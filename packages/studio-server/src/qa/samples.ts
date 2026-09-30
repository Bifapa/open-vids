import {
  QA_LIMITS,
  type QaIssueDraft,
  type QaSample,
  type StoryNode,
  type TimelineClip,
} from "@hyperframes/agent-protocol";
import { evenly } from "./layoutChecks.js";
import {
  activeAt,
  clipName,
  isAudible,
  isCaptionsHost,
  isContent,
  isVisual,
  round3,
  sourceTime,
  wordsBetween,
  type QaTimeline,
} from "./timelineModel.js";

/** Frames closer than this show the same thing. */
export const MERGE_SECONDS = 0.4;
/** Shown just after a visual cut, so the new shot has settled but is still its first moments. */
const AFTER_CUT_SECONDS = 0.3;
/** How much speech around a sample the context quotes, each side. */
const SAID_WINDOW_SECONDS = 3;
const SAID_CHARS = 170;
const STORY_CHARS = 110;

type Reason = QaSample["reason"];

/** Lower index = more important when the frame budget runs out. */
const PRIORITY: readonly Reason[] = ["suspect", "broll", "cut", "caption", "graphic", "coverage"];

const trimTo = (text: string, max: number): string =>
  text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;

function storyLabel(node: StoryNode | undefined): string | null {
  if (!node) return null;
  const about =
    node.kind === "chapter"
      ? node.purpose
      : node.kind === "missing"
        ? node.need
        : node.kind === "motion"
          ? node.usageIntent
          : node.usageIntent || (node.resolvedFrom?.need ?? "");
  return `${node.kind === "chapter" ? "chapter" : "story node"} "${trimTo(node.title, 50)}"${about ? `: ${trimTo(about, STORY_CHARS)}` : ""}`;
}

function describeClip(timeline: QaTimeline, clip: TimelineClip): string {
  const what =
    clip.kind === "text"
      ? `text "${trimTo(clip.label, 80)}"`
      : `${clip.kind} ${clip.src ?? clip.compositionSrc ?? (clip.label || "")}`.trim();
  const extra = [`clip ${clipName(clip)}`];
  const node = clip.provenance?.storyNode;
  const story = node ? storyLabel(timeline.graph?.nodes.find((entry) => entry.id === node)) : null;
  if (story) extra.push(story);
  return `track ${clip.track} ${what} (${extra.join(", ")})`;
}

/** What is spoken around `time`, from the audible clip playing there that has a fresh transcript. */
function spokenAt(timeline: QaTimeline, time: number): string | null {
  const speaker = activeAt(timeline.snapshot.clips, time).find(
    (clip) => isAudible(timeline, clip) && clip.src !== null && timeline.transcripts.has(clip.src),
  );
  const transcript = speaker?.src ? timeline.transcripts.get(speaker.src) : undefined;
  if (!speaker || !transcript) return null;
  const at = sourceTime(timeline, speaker, time);
  const words = wordsBetween(transcript, at - SAID_WINDOW_SECONDS, at + SAID_WINDOW_SECONDS);
  if (words.length === 0) return null;
  const text = words.map((word) => word.text.trim()).join(" ");
  return `said around here: "${trimTo(text, SAID_CHARS)}"`;
}

/** What the timeline shows and says at `time`, in the words Vision needs to judge fit. */
export function contextAt(timeline: QaTimeline, time: number): string {
  const visible = activeAt(timeline.snapshot.clips, time)
    .filter((clip) => isVisual(clip) && !isCaptionsHost(clip))
    .sort((a, b) => a.track - b.track);
  const parts = visible.map((clip) => describeClip(timeline, clip));
  const cue = timeline.cues.find((entry) => entry.start <= time && time < entry.end);
  if (cue) parts.push(`caption "${trimTo(cue.text, 100)}"`);
  const said = spokenAt(timeline, time);
  if (said) parts.push(said);
  if (parts.length === 0) return "nothing is placed on the timeline here";
  return trimTo(parts.join("; "), QA_LIMITS.contextChars);
}

interface Candidate {
  time: number;
  reason: Reason;
}

function candidates(
  timeline: QaTimeline,
  duration: number,
  issues: readonly QaIssueDraft[],
  framesPerMinute: number,
): Candidate[] {
  const clips = timeline.snapshot.clips;
  const found: Candidate[] = [];
  for (const issue of issues) {
    if (issue.severity !== "info")
      found.push({ time: (issue.start + issue.end) / 2, reason: "suspect" });
  }
  for (const clip of clips) {
    const middle = (clip.start + clip.end) / 2;
    if (isContent(clip)) {
      if (clip.track > 0) found.push({ time: middle, reason: "broll" });
      if (clip.start > 0.05) {
        found.push({ time: Math.min(clip.start + AFTER_CUT_SECONDS, middle), reason: "cut" });
      }
    } else if (isVisual(clip) && !isCaptionsHost(clip)) {
      found.push({ time: middle, reason: "graphic" });
    }
  }
  for (const cue of timeline.cues)
    found.push({ time: (cue.start + cue.end) / 2, reason: "caption" });
  const count = Math.max(1, Math.round((duration / 60) * framesPerMinute));
  for (let index = 0; index < count; index += 1) {
    found.push({ time: ((index + 0.5) * duration) / count, reason: "coverage" });
  }
  const last = Math.max(0, duration - 0.05);
  return found
    .filter((entry) => Number.isFinite(entry.time) && entry.time >= 0)
    .map((entry) => ({ time: round3(Math.min(entry.time, last)), reason: entry.reason }));
}

/**
 * The frames Vision should look at: just after visual cuts, B-roll, captions, graphics, deterministic suspects, then
 * even coverage at `framesPerMinute`. Frames less than 0.4 s apart are one frame (the more important reason wins);
 * when more are wanted than `maxFrames`, suspects go first, then B-roll, cuts, captions, graphics and coverage, and a
 * class that only partly fits is thinned evenly.
 */
export function planSamples(input: {
  timeline: QaTimeline;
  duration: number;
  issues: readonly QaIssueDraft[];
  framesPerMinute: number;
  maxFrames: number;
}): QaSample[] {
  const { timeline, issues, framesPerMinute } = input;
  const duration = input.duration > 0 ? input.duration : timeline.snapshot.composition.duration;
  const budget = Math.min(input.maxFrames, QA_LIMITS.samples);
  const all = candidates(timeline, duration, issues, framesPerMinute);
  const chosen: Candidate[] = [];
  const clear = (time: number, among: readonly Candidate[]) =>
    among.every((entry) => Math.abs(entry.time - time) >= MERGE_SECONDS - 1e-6);
  for (const reason of PRIORITY) {
    const room = budget - chosen.length;
    if (room <= 0) break;
    const fits: Candidate[] = [];
    for (const entry of all
      .filter((item) => item.reason === reason)
      .sort((a, b) => a.time - b.time)) {
      if (clear(entry.time, chosen) && clear(entry.time, fits)) fits.push(entry);
    }
    chosen.push(...evenly(fits, room));
  }
  return chosen
    .sort((a, b) => a.time - b.time)
    .map((entry) => ({
      time: entry.time,
      reason: entry.reason,
      context: contextAt(timeline, entry.time),
    }));
}
