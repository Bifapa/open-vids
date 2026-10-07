import { existsSync, statSync } from "node:fs";
import {
  isChapter,
  isMaterial,
  isSoundEffect,
  storyOrder,
  type AttachmentPlacement,
  type ChapterNode,
  type EditOperation,
  type MusicNode,
  type StoryAttachment,
  type StoryGraph,
  type StorySyncRole,
  type StoryNodeFacts,
  type VoiceScript,
} from "@hyperframes/agent-protocol";
import { mediaBounds, readAssetRanges } from "../editing/assetRanges.js";
import { pickedFragment } from "../helpers/pickedRange.js";
import { listPresets } from "../editing/presets.js";
import type { MediaFacts } from "../editing/mediaFacts.js";
import type { ResolvedProject, StudioApiAdapter } from "../types.js";
import { cleanChapterAroll, fitToEstimate, type AnalysisLookup } from "./aroll.js";
import { StoryFailure } from "./errors.js";
import { readScript, selectedTake } from "../voice/project/takesStore.js";
import { resolveWithinProject } from "../helpers/safePath.js";
import { takeCaptionWords } from "../voice/project/captionWords.js";

/**
 * Tracks Build Story writes: the A-roll on track 0, then B-roll video, pictures, motion graphics, music beds and sound
 * effects.
 */
export const STORY_TRACKS = {
  aRoll: 0,
  bRoll: 1,
  picture: 2,
  motion: 3,
  music: 4,
  sfx: 5,
  voice: 6,
} as const;

const DEFAULT_PICTURE_SECONDS = 4;
/** Motion presets without a declared length are assumed to run this long when placing them. */
const FALLBACK_MOTION_SECONDS = 3;
export const MUSIC_FADE_SECONDS = 1.5;
const MIN_CLIP_SECONDS = 0.1;
const EDGE_FADE = 0.02;
export const round3 = (value: number) => Math.round(value * 1000) / 1000;

export interface CompileEnv {
  project: ResolvedProject;
  adapter: StudioApiAdapter;
  facts: MediaFacts;
  lookup: AnalysisLookup;
}

/**
 * What the graph wants built for one story node inside a section: the edit operations that create it, with every
 * `start` relative to the section start and without provenance (the planner adds both). Two units are the same
 * intent exactly when their operations are the same JSON — that is how a rebuild decides what changed.
 */
export interface IntentUnit {
  node: string;
  role: StorySyncRole;
  title: string;
  ops: EditOperation[];
}

/** The voice line a chapter's narration is stored as in the project's voiceover script. */
export const narrationLine = (chapterId: string) => `chapter-${chapterId}`;

/** The story-node id a chapter's narration clip is stamped with (it is not a graph node of its own). */
export const narrationNode = (chapterId: string) => `narration:${chapterId}`;

/** The chapter a narration clip's `data-ov-story-node` belongs to, or null for any other node id. */
export function narrationChapter(node: string): string | null {
  return node.startsWith("narration:") ? node.slice("narration:".length) : null;
}

/**
 * A chapter's narration placed from its generated voice. The take's identity is part of the intent: a regenerated
 * take (same line, new audio) makes the unit changed even when the clip would look the same.
 */
export interface IntentNarration extends IntentUnit {
  take: { id: string; fingerprint: string; start: number; end: number };
  /** The chapter's narration as caption words: source text, take timings relative to the take's start. */
  words: Array<{ text: string; start: number; end: number }> | null;
}

export interface IntentSection {
  chapter: ChapterNode;
  /** Length of the section as the graph builds it: the cleaned A-roll, or the estimated duration without speech. */
  length: number;
  aRoll: IntentUnit;
  /** The chapter's narration placed from its generated voice (null: no narration, or its voice is not generated yet). */
  narration: IntentNarration | null;
  /** One unit per attached B-roll video, picture or motion graphic, in node order. */
  materials: IntentUnit[];
}

/** A music bed: from the first to the last chapter it is attached to (in play order); placed once the layout is known. */
export interface IntentMusic {
  node: MusicNode;
  covers: string[];
  /** Length of the usable part of the file (the user's pick, or the whole file), when known. */
  usableDuration: number | null;
  /** Where the usable part starts in the file (0 without a pick): the bed starts there, not at the file's start. */
  usableStart: number;
  /** The usable part is a fragment the user picked (warnings say so). */
  picked: boolean;
}

export interface StoryIntent {
  sections: IntentSection[];
  music: IntentMusic[];
  /** Caption preset for the captioned chapters (null: no chapter wants captions, or no preset is installed). */
  captionPreset: string | null;
  /** Every source the chapters' A-roll reads. */
  sources: Set<string>;
  warnings: string[];
  /**
   * The caption words of a voice take (any take of the script, not only the selected one: a unit a rebuild keeps was
   * built from the take it recorded), with the take's start in its file. Null: no such line or take.
   */
  voiceWords: (
    lineId: string,
    takeId: string,
  ) => { start: number; words: Array<{ text: string; start: number; end: number }> | null } | null;
}

interface Span {
  start: number;
  length: number;
}

/** Where a piece of material of `length` sits inside a chapter (offset wins over placement), kept inside the chapter. */
function placeInChapter(
  chapter: Span,
  length: number,
  placement: AttachmentPlacement,
  offset: number | null,
): { start: number; length: number } {
  const end = chapter.start + chapter.length;
  let start: number;
  if (offset !== null) start = chapter.start + offset;
  else if (placement === "middle") start = chapter.start + (chapter.length - length) / 2;
  else if (placement === "end") start = end - length;
  else start = chapter.start;
  start = Math.min(Math.max(start, chapter.start), Math.max(chapter.start, end - MIN_CLIP_SECONDS));
  return { start: round3(start), length: round3(Math.min(length, end - start)) };
}

const ROLE_OF = { video: "b_roll", picture: "picture", motion: "motion" } as const;

/** Whether a chapter's narration has a generated voice (the line's selected take), for the story view. */
export function narrationFact(
  chapter: ChapterNode,
  script: VoiceScript,
): NonNullable<StoryNodeFacts["narration"]> {
  const line = script.lines.find((entry) => entry.id === narrationLine(chapter.id));
  const take = line ? selectedTake(line) : null;
  return {
    generated: take !== null,
    seconds: take ? round3(take.end - take.start) : null,
    textCurrent: line !== undefined && line.text.trim() === chapter.narration.trim(),
  };
}

/**
 * The chapter's narration as a unit: its voice line's selected take at the chapter start. Narration whose voice is not
 * generated yet places nothing (an `add_clip voiceLine` without a take would abort the whole batch) and is reported.
 */
function compileNarration(
  chapter: ChapterNode,
  script: VoiceScript,
  projectDir: string,
  warnings: string[],
): IntentNarration | null {
  if (chapter.narration.trim() === "") return null;
  const lineId = narrationLine(chapter.id);
  const line = script.lines.find((entry) => entry.id === lineId);
  const take = line ? selectedTake(line) : null;
  if (!line || !take) {
    warnings.push(
      `${chapter.title}: narration has no generated voice yet; nothing was placed (line "${lineId}").`,
    );
    return null;
  }
  // A voice file that is gone (deleted from the library, assets not copied with the project) would fail the whole
  // atomic batch at apply time: say so here and leave the narration out.
  const file = resolveWithinProject(projectDir, take.file);
  if (file === null || !existsSync(file) || !statSync(file).isFile()) {
    warnings.push(
      `${chapter.title}: the narration's voice file is missing (${take.file}); nothing was placed.`,
    );
    return null;
  }
  if (line.text.trim() !== chapter.narration.trim()) {
    warnings.push(
      `${chapter.title}: the narration text changed after its voice was generated; the old voice was placed (generate it again).`,
    );
  }
  const words = takeCaptionWords(line, take);
  if (words === null && chapter.captions) {
    warnings.push(
      `${chapter.title}: the narration's voice has no word timings; its captions follow the A-roll speech (generate it again).`,
    );
  }
  return {
    node: narrationNode(chapter.id),
    role: "narration",
    title: `${chapter.title} narration`,
    ops: [
      {
        op: "add_clip",
        asset: "",
        voiceLine: lineId,
        start: 0,
        track: STORY_TRACKS.voice,
        duration: round3(take.end - take.start),
      },
    ],
    take: {
      id: take.id,
      fingerprint: take.fingerprint ?? take.requestHash,
      start: take.start,
      end: take.end,
    },
    words,
  };
}

/**
 * Compiles the graph into what each section should hold, deterministically: chapters in `storyOrder`; each
 * chapter's A-roll is its source ranges cleaned like a rough cut, back to back; attached material is placed inside
 * its chapter; music spans its chapters; captions come from the transcript. Nothing about the current timeline goes
 * in, so the same graph and analysis always give the same intent.
 */
export async function compileIntent(env: CompileEnv, graph: StoryGraph): Promise<StoryIntent> {
  const warnings: string[] = [];
  const ranges = readAssetRanges(env.project.dir);
  const script = readScript(env.project.dir);
  const order = storyOrder(graph);
  const byId = new Map(graph.nodes.map((node) => [node.id, node]));
  const chapters = order.chapters.flatMap((id) => {
    const node = byId.get(id);
    return node && isChapter(node) ? [node] : [];
  });
  if (chapters.length === 0) {
    throw new StoryFailure("invalid_request", "The story has no chapters to build");
  }
  warnings.push(...order.notes);

  const presets = await listPresets(env.adapter, {});
  const motionLength = new Map(
    presets
      .filter((preset) => preset.kind !== "caption")
      .map((preset) => [preset.name, preset.duration]),
  );
  const attachedTo = new Map<string, StoryAttachment[]>();
  for (const attachment of graph.attachments) {
    const list = attachedTo.get(attachment.chapter) ?? [];
    list.push(attachment);
    attachedTo.set(attachment.chapter, list);
  }
  const nodeOrder = new Map(graph.nodes.map((node, index) => [node.id, index]));

  const sources = new Set<string>();
  const sections: IntentSection[] = [];
  for (const chapter of chapters) {
    for (const range of chapter.sourceRanges) sources.add(range.source);
    const cleaned = fitToEstimate(chapter, await cleanChapterAroll(chapter, env.lookup, ranges));
    warnings.push(...cleaned.warnings);
    const speech = cleaned.pieces.length > 0 && cleaned.total > 0;
    const narration = compileNarration(chapter, script, env.project.dir, warnings);
    const narrated = narration ? round3(narration.take.end - narration.take.start) : 0;
    // Without A-roll the chapter is as long as the narration needs; over A-roll the cleaned speech sets the length.
    const length = round3(speech ? cleaned.total : Math.max(chapter.estimatedDuration, narrated));
    if (!speech && chapter.sourceRanges.length > 0) {
      warnings.push(
        `${chapter.title}: no A-roll could be placed; the chapter is ${length} s long (${narrated > chapter.estimatedDuration ? "the narration's length" : "its estimated duration"}).`,
      );
    }
    if (speech && narrated > length + MIN_CLIP_SECONDS) {
      warnings.push(
        `${chapter.title}: the narration is ${narrated} s but the chapter's A-roll is ${length} s; it runs into the next chapter.`,
      );
    }
    const aRollOps: EditOperation[] = [];
    let at = 0;
    for (const piece of speech ? cleaned.pieces : []) {
      const last = aRollOps.at(-1);
      const range = { from: piece.from, to: piece.to };
      if (last?.op === "add_sequence" && last.asset === piece.source) last.ranges.push(range);
      else {
        aRollOps.push({
          op: "add_sequence",
          asset: piece.source,
          track: STORY_TRACKS.aRoll,
          start: round3(at),
          ranges: [range],
          edgeFade: EDGE_FADE,
        });
      }
      at += piece.to - piece.from;
    }

    const span: Span = { start: 0, length };
    const materials: IntentUnit[] = [];
    const attachments = [...(attachedTo.get(chapter.id) ?? [])].sort(
      (a, b) => (nodeOrder.get(a.node) ?? 0) - (nodeOrder.get(b.node) ?? 0),
    );
    for (const attachment of attachments) {
      const node = byId.get(attachment.node);
      if (!node || !isMaterial(node)) continue;
      if (node.kind === "missing") {
        warnings.push(`${chapter.title}: missing ${node.need}`);
        continue;
      }
      if (node.kind === "music" && !isSoundEffect(node)) continue;
      const unit: IntentUnit = {
        node: node.id,
        role: node.kind === "music" ? "sfx" : ROLE_OF[node.kind],
        title: node.title,
        ops: [],
      };
      materials.push(unit);
      const leftOut = () =>
        warnings.push(
          `${chapter.title}: "${node.title}" does not fit inside the chapter; it was left out.`,
        );
      switch (node.kind) {
        case "video": {
          const asset = await env.facts.read(env.project.dir, node.asset);
          if (!asset) {
            warnings.push(
              `${chapter.title}: ${node.asset} is not in the project; "${node.title}" was left out.`,
            );
            break;
          }
          const bounds = mediaBounds(ranges.get(node.asset), asset.duration);
          const sourceIn = Math.max(node.sourceIn, bounds.start);
          const wantedOut = node.sourceOut ?? asset.duration;
          const sourceOut =
            bounds.end === null ? wantedOut : Math.min(wantedOut ?? bounds.end, bounds.end);
          const range = sourceOut === null ? null : sourceOut - sourceIn;
          if (range !== null && range <= 0) {
            warnings.push(
              bounds.picked && bounds.end !== null
                ? `${chapter.title}: "${node.title}" is outside the picked fragment ${pickedFragment(node.asset, { start: bounds.start, end: bounds.end })}; it was left out.`
                : `${chapter.title}: "${node.title}" starts at or after the end of ${node.asset}; it was left out.`,
            );
            break;
          }
          if (
            bounds.picked &&
            bounds.end !== null &&
            (node.sourceIn < bounds.start || (wantedOut !== null && wantedOut > bounds.end))
          ) {
            warnings.push(
              `${chapter.title}: "${node.title}" uses only the picked fragment ${pickedFragment(node.asset, { start: bounds.start, end: bounds.end })}; the rest was left out.`,
            );
          }
          let wanted = attachment.duration ?? Math.min(range ?? span.length, span.length);
          if (range !== null && wanted > range) {
            warnings.push(
              `${chapter.title}: "${node.title}" has only ${round3(range)} s of footage; it plays ${round3(range)} s.`,
            );
            wanted = range;
          }
          const placed = placeInChapter(span, wanted, attachment.placement, attachment.offset);
          if (placed.length < MIN_CLIP_SECONDS) {
            leftOut();
            break;
          }
          unit.ops.push({
            op: "add_clip",
            asset: node.asset,
            start: placed.start,
            track: STORY_TRACKS.bRoll,
            duration: placed.length,
            ...(sourceIn > 0 && { mediaStart: sourceIn }),
            muted: true,
            fit: "cover",
          });
          break;
        }
        case "picture": {
          const asset = await env.facts.read(env.project.dir, node.asset);
          if (!asset) {
            warnings.push(
              `${chapter.title}: ${node.asset} is not in the project; "${node.title}" was left out.`,
            );
            break;
          }
          const wanted =
            attachment.duration ??
            (attachment.placement === "throughout" ? span.length : DEFAULT_PICTURE_SECONDS);
          const placed = placeInChapter(span, wanted, attachment.placement, attachment.offset);
          if (placed.length < MIN_CLIP_SECONDS) {
            leftOut();
            break;
          }
          unit.ops.push({
            op: "add_clip",
            asset: node.asset,
            start: placed.start,
            track: STORY_TRACKS.picture,
            duration: placed.length,
            fit: "contain",
          });
          break;
        }
        case "motion": {
          if (!motionLength.has(node.preset)) {
            warnings.push(
              `${chapter.title}: no motion preset "${node.preset}" in the registry; "${node.title}" was left out.`,
            );
            break;
          }
          const declared = attachment.duration ?? node.duration;
          const natural = motionLength.get(node.preset) ?? null;
          const assumed =
            attachment.placement === "throughout" && declared === null
              ? span.length
              : (declared ?? natural ?? Math.min(FALLBACK_MOTION_SECONDS, span.length));
          const placed = placeInChapter(span, assumed, attachment.placement, attachment.offset);
          if (placed.length < MIN_CLIP_SECONDS) {
            leftOut();
            break;
          }
          const explicit =
            declared !== null ||
            attachment.placement === "throughout" ||
            placed.length < assumed - 0.001;
          unit.ops.push({
            op: "add_component",
            name: node.preset,
            start: placed.start,
            track: STORY_TRACKS.motion,
            ...(explicit && { duration: placed.length }),
          });
          break;
        }
        case "music": {
          // A sound effect (see isSoundEffect): its own length, placed like a picture, at the node's volume.
          const asset = node.asset ? await env.facts.read(env.project.dir, node.asset) : null;
          if (!node.asset || !asset) {
            warnings.push(
              `${chapter.title}: sound effect "${node.title}" has no file in the project; it was left out.`,
            );
            break;
          }
          const bounds = mediaBounds(ranges.get(node.asset), asset.duration);
          const natural =
            bounds.end === null ? (asset.duration ?? span.length) : bounds.end - bounds.start;
          const wanted = Math.min(attachment.duration ?? natural, natural);
          if (bounds.picked && bounds.end !== null && (attachment.duration ?? 0) > natural) {
            warnings.push(
              `${chapter.title}: sound effect "${node.title}" is limited to the picked fragment ${pickedFragment(node.asset, { start: bounds.start, end: bounds.end })}.`,
            );
          }
          const placed = placeInChapter(span, wanted, attachment.placement, attachment.offset);
          if (placed.length < MIN_CLIP_SECONDS) {
            leftOut();
            break;
          }
          unit.ops.push({
            op: "add_clip",
            asset: node.asset,
            start: placed.start,
            track: STORY_TRACKS.sfx,
            duration: placed.length,
            ...(bounds.start > 0 && { mediaStart: bounds.start }),
            volume: node.volume,
            fadeOut: round3(Math.min(0.1, placed.length / 2)),
          });
          break;
        }
      }
    }
    sections.push({
      chapter,
      length,
      aRoll: { node: chapter.id, role: "a_roll", title: chapter.title, ops: aRollOps },
      narration,
      materials,
    });
  }

  const rank = new Map(chapters.map((chapter, index) => [chapter.id, index]));
  const music: IntentMusic[] = [];
  for (const node of graph.nodes) {
    if (node.kind !== "music" || isSoundEffect(node)) continue;
    const covers = graph.attachments
      .filter((item) => item.node === node.id && rank.has(item.chapter))
      .sort((a, b) => (rank.get(a.chapter) ?? 0) - (rank.get(b.chapter) ?? 0))
      .map((item) => item.chapter);
    const first = covers[0];
    if (first === undefined) continue;
    const firstTitle = sections.find((section) => section.chapter.id === first)?.chapter.title;
    if (node.asset === null) {
      warnings.push(`${firstTitle}: music "${node.title}" has no file yet; nothing was placed.`);
      continue;
    }
    const asset = await env.facts.read(env.project.dir, node.asset);
    if (!asset) {
      warnings.push(
        `${firstTitle}: ${node.asset} is not in the project; music "${node.title}" was left out.`,
      );
      continue;
    }
    const bounds = mediaBounds(ranges.get(node.asset), asset.duration);
    music.push({
      node,
      covers,
      usableDuration: bounds.end === null ? asset.duration : bounds.end - bounds.start,
      usableStart: bounds.start,
      picked: bounds.picked,
    });
  }

  let captionPreset: string | null = null;
  if (chapters.some((chapter) => chapter.captions)) {
    const available = presets.filter((preset) => preset.kind === "caption").map((p) => p.name);
    const wanted = graph.settings.captionPreset;
    if (wanted !== null && available.length > 0 && !available.includes(wanted)) {
      throw new StoryFailure("unknown_preset", `No caption preset "${wanted}"`);
    }
    captionPreset = wanted ?? available[0] ?? null;
    if (captionPreset === null) {
      warnings.push("Captions were left out: no caption presets are installed.");
    }
  }

  const voiceWords: StoryIntent["voiceWords"] = (lineId, takeId) => {
    const line = script.lines.find((entry) => entry.id === lineId);
    const take = line?.takes.find((entry) => entry.id === takeId);
    return line && take ? { start: take.start, words: takeCaptionWords(line, take) } : null;
  };
  return { sections, music, captionPreset, sources, warnings, voiceWords };
}
