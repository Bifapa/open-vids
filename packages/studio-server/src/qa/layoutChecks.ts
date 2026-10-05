import type { QaIssueDraft, QaIssueKind, TimelineClip } from "@hyperframes/agent-protocol";
import { isCaptionsFile } from "../editing/captions.js";
import type { LayoutCheckFinding } from "../types.js";
import { activeAt, clipName, isCaptionsHost, round3, type QaTimeline } from "./timelineModel.js";

/** The layout audit seeks Chrome to every sample, so its cost grows with their number. */
export const MAX_LAYOUT_SAMPLES = 24;
const MIN_SAMPLE_SPACING = 0.25;
const MESSAGE_LIMIT = 560;
const SUBJECT_LIMIT = 280;

const CAPTION_NAME = /caption/i;

/** Layout audit codes by what QA calls them; everything else the audit reports is not a QA concern. */
const OVERLAP_CODES = ["content_overlap", "text_occluded"];
const OUT_OF_BOUNDS_CODES = [
  "canvas_overflow",
  "text_box_overflow",
  "clipped_text",
  "container_overflow",
  "panel_out_of_canvas",
  "canvas_content_at_edge",
  "frame_out_of_frame",
];

/** `count` items of `items`, evenly spread, first and last included when `count > 1`. */
export function evenly<T>(items: readonly T[], count: number): T[] {
  if (items.length <= count) return [...items];
  if (count <= 0) return [];
  if (count === 1) return items[0] === undefined ? [] : [items[0]];
  const picked: T[] = [];
  for (let index = 0; index < count; index += 1) {
    const item = items[Math.round((index * (items.length - 1)) / (count - 1))];
    if (item !== undefined) picked.push(item);
  }
  return picked;
}

/** Seconds where text can collide or leave the frame: caption cue midpoints and text/graphic clip midpoints. */
export function layoutSampleTimes(timeline: QaTimeline, duration: number): number[] {
  const times: number[] = timeline.cues.map((cue) => (cue.start + cue.end) / 2);
  for (const clip of timeline.snapshot.clips) {
    if (clip.kind === "text" || clip.kind === "element" || clip.kind === "composition") {
      if (!isCaptionsHost(clip)) times.push((clip.start + clip.end) / 2);
    }
  }
  const limit = duration > 0 ? duration : timeline.snapshot.composition.duration;
  const sorted = times
    .filter((time) => Number.isFinite(time) && time >= 0 && (limit <= 0 || time <= limit))
    .map(round3)
    .sort((a, b) => a - b);
  const spaced: number[] = [];
  for (const time of sorted) {
    const last = spaced[spaced.length - 1];
    if (last === undefined || time - last >= MIN_SAMPLE_SPACING) spaced.push(time);
  }
  return evenly(spaced, MAX_LAYOUT_SAMPLES);
}

/** The audited element (`selector`) is a caption: its own name, its file or its data attributes say so. */
function selfIsCaption(finding: LayoutCheckFinding): boolean {
  return (
    isCaptionsFile(finding.sourceFile ?? null) ||
    CAPTION_NAME.test(finding.selector) ||
    Object.values(finding.dataAttributes ?? {}).some((value) => CAPTION_NAME.test(value))
  );
}

function otherIsCaption(finding: LayoutCheckFinding): boolean {
  return CAPTION_NAME.test(finding.containerSelector ?? "");
}

function kindOf(finding: LayoutCheckFinding): QaIssueKind | null {
  if (finding.code === "caption_zone_collision") return "caption_collision";
  if (OVERLAP_CODES.includes(finding.code)) {
    return selfIsCaption(finding) || otherIsCaption(finding)
      ? "caption_collision"
      : "layout_overlap";
  }
  return OUT_OF_BOUNDS_CODES.includes(finding.code) ? "out_of_bounds" : null;
}

/**
 * What the issue is about, stable across passes: the element that leaves the frame, or the pair that overlaps. A
 * caption is named `caption` (its words are separate elements, one per highlighted word, so their own selectors would
 * make every word a different issue).
 */
function subjectOf(finding: LayoutCheckFinding, kind: QaIssueKind): string {
  const other = finding.containerSelector;
  if (kind === "out_of_bounds" || !other) return finding.selector;
  const self = selfIsCaption(finding);
  const otherCaption = otherIsCaption(finding);
  if (self && !otherCaption) return `caption × ${other}`;
  if (otherCaption && !self) return `${finding.selector} × caption`;
  return `${finding.selector} × ${other}`;
}

/** The timeline clips a finding is about: its `data-hf-id`, the elements named by DOM id, the captions host, or text on screen. */
function clipsOf(
  finding: LayoutCheckFinding,
  kind: QaIssueKind,
  timeline: QaTimeline,
): TimelineClip[] {
  const clips = timeline.snapshot.clips;
  const byId = finding.dataAttributes?.["data-hf-id"];
  const named = byId ? clips.filter((clip) => clip.id === byId) : [];
  const selectors = [finding.selector, finding.containerSelector];
  const byDom = clips.filter((clip) => clip.domId !== null && selectors.includes(`#${clip.domId}`));
  const captions = kind === "caption_collision" ? clips.filter(isCaptionsHost) : [];
  const direct = [...new Set([...named, ...byDom, ...captions])];
  if (direct.length > 0) return direct;
  const hosts = finding.sourceFile
    ? clips.filter((clip) => clip.compositionSrc === finding.sourceFile)
    : [];
  if (hosts.length > 0) return hosts;
  const visible = activeAt(clips, finding.time).filter(
    (clip) => clip.kind === "text" || clip.kind === "composition" || clip.kind === "element",
  );
  const text = finding.text?.trim().toLowerCase().slice(0, 24);
  const matching = text ? visible.filter((clip) => clip.label.toLowerCase().startsWith(text)) : [];
  return (matching.length > 0 ? matching : visible).slice(0, 4);
}

function describeFinding(finding: LayoutCheckFinding, kind: QaIssueKind): string {
  const what =
    kind === "caption_collision"
      ? "A caption collides with other content"
      : kind === "layout_overlap"
        ? "Text or graphics overlap"
        : "Content leaves the frame or is clipped";
  const text = finding.text ? ` ("${finding.text.slice(0, 60)}")` : "";
  const other = finding.containerSelector ? ` vs ${finding.containerSelector}` : "";
  const message = `${what}${text}: ${finding.message} [${finding.selector}${other}]`;
  return message.length > MESSAGE_LIMIT ? `${message.slice(0, MESSAGE_LIMIT - 1)}…` : message;
}

/** Layout audit findings as QA issues, all owned by the motion specialist (the one who edits text and graphics). */
export function layoutIssues(
  findings: readonly LayoutCheckFinding[],
  timeline: QaTimeline,
): QaIssueDraft[] {
  const issues: QaIssueDraft[] = [];
  for (const finding of findings) {
    const kind = kindOf(finding);
    if (!kind) continue;
    const start = Math.max(0, finding.firstSeen ?? finding.time);
    const end = Math.max(start, finding.lastSeen ?? finding.time);
    const subject = subjectOf(finding, kind);
    issues.push({
      kind,
      severity: finding.severity,
      source: "layout",
      check: `layout.${finding.code}`.slice(0, 80),
      start,
      end,
      clipIds: clipsOf(finding, kind, timeline).map(clipName).slice(0, 32),
      subject: subject.slice(0, SUBJECT_LIMIT),
      message: describeFinding(finding, kind),
      fixable: finding.severity !== "info",
      owner: "motion",
      suggestion: finding.fixHint ?? null,
    });
  }
  return issues;
}
