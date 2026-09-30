import {
  captionCuesFromWords,
  isChapter,
  isMaterial,
  storyOrder,
  type AttachmentPlacement,
  type CaptionCue,
  type ChapterNode,
  type ClipProvenance,
  type EditOperation,
  type PlacedRange,
  type StoryAttachment,
  type StoryGraph,
  type StoryMaterialNode,
  type TimelineSnapshot,
} from "@hyperframes/agent-protocol";
import { listPresets } from "../editing/presets.js";
import type { MediaFacts } from "../editing/mediaFacts.js";
import type { ResolvedProject, StudioApiAdapter } from "../types.js";
import { cleanChapterAroll, type AnalysisLookup, type CleanedPiece } from "./aroll.js";
import { StoryFailure } from "./errors.js";

/** Tracks Build Story writes: the A-roll on track 0, then B-roll video, pictures, motion graphics and music. */
export const STORY_TRACKS = { aRoll: 0, bRoll: 1, picture: 2, motion: 3, music: 4 } as const;

const DEFAULT_PICTURE_SECONDS = 4;
/** Motion presets without a declared length are assumed to run this long when placing them. */
const FALLBACK_MOTION_SECONDS = 3;
const MUSIC_FADE_SECONDS = 1.5;
const MIN_CLIP_SECONDS = 0.1;
const EDGE_FADE = 0.02;
const round3 = (value: number) => Math.round(value * 1000) / 1000;

export interface CompileEnv {
  project: ResolvedProject;
  adapter: StudioApiAdapter;
  facts: MediaFacts;
  lookup: AnalysisLookup;
  turnId: string | undefined;
}

export interface CompiledMaterial {
  node: string;
  chapter: string;
  /** Index in `operations` of the operation that creates the clip. */
  operation: number;
  start: number;
  end: number;
  track: number;
}

export interface CompiledChapter {
  node: string;
  title: string;
  estimatedDuration: number;
  start: number;
  end: number;
  clips: number;
}

export interface CompiledStory {
  operations: EditOperation[];
  duration: number;
  chapters: CompiledChapter[];
  materials: CompiledMaterial[];
  removedClips: number;
  keptClips: number;
  captions: { preset: string; cues: number } | null;
  warnings: string[];
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

function provenanceOf(storyNode: string, turn: string | undefined): Partial<ClipProvenance> {
  return { storyNode, ...(turn !== undefined && { turn }) };
}

/**
 * Compiles the graph into one atomic edit batch, deterministically. Chapters play in `storyOrder`, laid back to back
 * on the A-roll track; attached material is placed inside its chapter; music spans its chapters; captions come from
 * the transcript. Clips of a previous build and the raw A-roll of the chapters' sources are replaced, everything else
 * on the timeline is kept.
 */
export async function compileStory(
  env: CompileEnv,
  graph: StoryGraph,
  timeline: TimelineSnapshot,
): Promise<CompiledStory> {
  const warnings: string[] = [];
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

  const aRoll: EditOperation[] = [];
  const materialOps: EditOperation[] = [];
  const materials: Array<Omit<CompiledMaterial, "operation"> & { op: EditOperation }> = [];
  const built: CompiledChapter[] = [];
  const spans = new Map<string, Span>();
  const placed = new Map<string, Array<{ chapter: ChapterNode; pieces: PlacedPiece[] }>>();
  const sources = new Set<string>();

  // ── A-roll ────────────────────────────────────────────────────────────────
  let cursor = 0;
  for (const chapter of chapters) {
    for (const range of chapter.sourceRanges) sources.add(range.source);
    const cleaned = await cleanChapterAroll(chapter, env.lookup);
    warnings.push(...cleaned.warnings);
    const speech = cleaned.pieces.length > 0 && cleaned.total > 0;
    const length = round3(speech ? cleaned.total : chapter.estimatedDuration);
    if (!speech && chapter.sourceRanges.length > 0) {
      warnings.push(
        `${chapter.title}: no A-roll could be placed; the chapter is ${length} s long (its estimated duration).`,
      );
    }
    const start = round3(cursor);
    spans.set(chapter.id, { start, length });
    let clips = 0;
    let at = start;
    const groups: Array<{ source: string; pieces: CleanedPiece[]; at: number }> = [];
    for (const piece of speech ? cleaned.pieces : []) {
      const last = groups.at(-1);
      if (last && last.source === piece.source) last.pieces.push(piece);
      else groups.push({ source: piece.source, pieces: [piece], at });
      at += piece.to - piece.from;
    }
    for (const group of groups) {
      aRoll.push({
        op: "add_sequence",
        asset: group.source,
        track: STORY_TRACKS.aRoll,
        start: round3(group.at),
        ranges: group.pieces.map((piece) => ({ from: piece.from, to: piece.to })),
        edgeFade: EDGE_FADE,
        provenance: provenanceOf(chapter.id, env.turnId),
      });
      clips += group.pieces.length;
      let position = group.at;
      const list = placed.get(group.source) ?? [];
      list.push({
        chapter,
        pieces: group.pieces.map((piece) => {
          const range = { ...piece, at: round3(position) };
          position += piece.to - piece.from;
          return range;
        }),
      });
      placed.set(group.source, list);
    }
    built.push({
      node: chapter.id,
      title: chapter.title,
      estimatedDuration: chapter.estimatedDuration,
      start,
      end: round3(start + length),
      clips,
    });
    cursor = start + length;
  }
  const duration = round3(cursor);

  // ── Attached material ─────────────────────────────────────────────────────
  const presets = await listPresets(env.adapter, {});
  const motionLength = new Map(
    presets
      .filter((preset) => preset.kind !== "caption")
      .map((preset) => [preset.name, preset.duration]),
  );
  const chapterRecord = new Map(built.map((entry) => [entry.node, entry]));
  const attachedTo = new Map<string, StoryAttachment[]>();
  for (const attachment of graph.attachments) {
    const list = attachedTo.get(attachment.chapter) ?? [];
    list.push(attachment);
    attachedTo.set(attachment.chapter, list);
  }
  const nodeOrder = new Map(graph.nodes.map((node, index) => [node.id, index]));

  const addMaterial = (
    chapter: ChapterNode,
    node: StoryMaterialNode,
    track: number,
    span: { start: number; length: number },
    op: EditOperation,
  ) => {
    materialOps.push(op);
    materials.push({
      node: node.id,
      chapter: chapter.id,
      start: span.start,
      end: round3(span.start + span.length),
      track,
      op,
    });
    const record = chapterRecord.get(chapter.id);
    if (record) record.clips += 1;
  };

  for (const chapter of chapters) {
    const span = spans.get(chapter.id);
    if (!span) continue;
    const attachments = [...(attachedTo.get(chapter.id) ?? [])].sort(
      (a, b) => (nodeOrder.get(a.node) ?? 0) - (nodeOrder.get(b.node) ?? 0),
    );
    for (const attachment of attachments) {
      const node = byId.get(attachment.node);
      if (!node || !isMaterial(node)) continue;
      const provenance = provenanceOf(node.id, env.turnId);
      switch (node.kind) {
        case "video": {
          const asset = await env.facts.read(env.project.dir, node.asset);
          if (!asset) {
            warnings.push(
              `${chapter.title}: ${node.asset} is not in the project; "${node.title}" was left out.`,
            );
            break;
          }
          const sourceEnd = node.sourceOut ?? asset.duration;
          const range = sourceEnd === null ? null : sourceEnd - node.sourceIn;
          if (range !== null && range <= 0) {
            warnings.push(
              `${chapter.title}: "${node.title}" starts at or after the end of ${node.asset}; it was left out.`,
            );
            break;
          }
          let wanted = attachment.duration ?? Math.min(range ?? span.length, span.length);
          if (range !== null && wanted > range) {
            warnings.push(
              `${chapter.title}: "${node.title}" has only ${round3(range)} s of footage; it plays ${round3(range)} s.`,
            );
            wanted = range;
          }
          const at = placeInChapter(span, wanted, attachment.placement, attachment.offset);
          if (at.length < MIN_CLIP_SECONDS) {
            warnings.push(
              `${chapter.title}: "${node.title}" does not fit inside the chapter; it was left out.`,
            );
            break;
          }
          addMaterial(chapter, node, STORY_TRACKS.bRoll, at, {
            op: "add_clip",
            asset: node.asset,
            start: at.start,
            track: STORY_TRACKS.bRoll,
            duration: at.length,
            ...(node.sourceIn > 0 && { mediaStart: node.sourceIn }),
            muted: true,
            fit: "cover",
            provenance,
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
          const at = placeInChapter(span, wanted, attachment.placement, attachment.offset);
          if (at.length < MIN_CLIP_SECONDS) {
            warnings.push(
              `${chapter.title}: "${node.title}" does not fit inside the chapter; it was left out.`,
            );
            break;
          }
          addMaterial(chapter, node, STORY_TRACKS.picture, at, {
            op: "add_clip",
            asset: node.asset,
            start: at.start,
            track: STORY_TRACKS.picture,
            duration: at.length,
            fit: "contain",
            provenance,
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
          const at = placeInChapter(span, assumed, attachment.placement, attachment.offset);
          if (at.length < MIN_CLIP_SECONDS) {
            warnings.push(
              `${chapter.title}: "${node.title}" does not fit inside the chapter; it was left out.`,
            );
            break;
          }
          const explicit =
            declared !== null ||
            attachment.placement === "throughout" ||
            at.length < assumed - 0.001;
          addMaterial(chapter, node, STORY_TRACKS.motion, at, {
            op: "add_component",
            name: node.preset,
            start: at.start,
            track: STORY_TRACKS.motion,
            ...(explicit && { duration: at.length }),
            provenance,
          });
          break;
        }
        case "missing":
          warnings.push(`${chapter.title}: missing ${node.need}`);
          break;
        case "music":
          break;
      }
    }
  }

  // ── Music ─────────────────────────────────────────────────────────────────
  const chapterRank = new Map(chapters.map((chapter, index) => [chapter.id, index]));
  for (const node of graph.nodes) {
    if (node.kind !== "music") continue;
    const attached = graph.attachments
      .filter((item) => item.node === node.id && chapterRank.has(item.chapter))
      .sort((a, b) => (chapterRank.get(a.chapter) ?? 0) - (chapterRank.get(b.chapter) ?? 0));
    const first = attached[0];
    const last = attached.at(-1);
    if (!first || !last) continue;
    const firstSpan = spans.get(first.chapter);
    const lastSpan = spans.get(last.chapter);
    const firstChapter = byId.get(first.chapter);
    if (!firstSpan || !lastSpan || !firstChapter || !isChapter(firstChapter)) continue;
    if (node.asset === null) {
      warnings.push(
        `${firstChapter.title}: music "${node.title}" has no file yet; nothing was placed.`,
      );
      continue;
    }
    const asset = await env.facts.read(env.project.dir, node.asset);
    if (!asset) {
      warnings.push(
        `${firstChapter.title}: ${node.asset} is not in the project; music "${node.title}" was left out.`,
      );
      continue;
    }
    const start = firstSpan.start;
    const wanted = round3(lastSpan.start + lastSpan.length - start);
    let length = wanted;
    if (asset.duration !== null && asset.duration < wanted) {
      length = round3(asset.duration);
      warnings.push(
        `Music "${node.title}" is ${length} s long but the story part it scores is ${wanted} s; it ends early.`,
      );
    }
    const fade = round3(Math.min(MUSIC_FADE_SECONDS, length / 2));
    const at = { start, length };
    materialOps.push({
      op: "add_clip",
      asset: node.asset,
      start,
      track: STORY_TRACKS.music,
      duration: length,
      volume: node.volume,
      fadeIn: fade,
      fadeOut: fade,
      provenance: provenanceOf(node.id, env.turnId),
    });
    materials.push({
      node: node.id,
      chapter: first.chapter,
      start: at.start,
      end: round3(at.start + at.length),
      track: STORY_TRACKS.music,
      op: materialOps[materialOps.length - 1] ?? { op: "set_composition", duration },
    });
    const record = chapterRecord.get(first.chapter);
    if (record) record.clips += 1;
  }

  // ── Removal ───────────────────────────────────────────────────────────────
  const replaced = timeline.clips.filter(
    (clip) =>
      !clip.locked &&
      (clip.provenance?.storyNode != null ||
        (clip.track === STORY_TRACKS.aRoll && clip.src !== null && sources.has(clip.src))),
  );
  const lockedLeft = timeline.clips.filter(
    (clip) =>
      clip.locked &&
      (clip.provenance?.storyNode != null ||
        (clip.track === STORY_TRACKS.aRoll && clip.src !== null && sources.has(clip.src))),
  );
  if (lockedLeft.length > 0) {
    warnings.push(
      `${lockedLeft.length} locked clips from an earlier build or cut were left in place.`,
    );
  }

  // ── Captions ──────────────────────────────────────────────────────────────
  const captioned = chapters.filter((chapter) => chapter.captions);
  let captions: CompiledStory["captions"] = null;
  let captionOp: EditOperation | null = null;
  if (captioned.length > 0) {
    const available = presets.filter((preset) => preset.kind === "caption").map((p) => p.name);
    const wantedPreset = graph.settings.captionPreset;
    if (wantedPreset !== null && available.length > 0 && !available.includes(wantedPreset)) {
      throw new StoryFailure("unknown_preset", `No caption preset "${wantedPreset}"`);
    }
    const preset = wantedPreset ?? available[0];
    const cues: CaptionCue[] = [];
    if (preset === undefined) {
      warnings.push("Captions were left out: no caption presets are installed.");
    } else {
      for (const [source, list] of placed) {
        const data = await env.lookup(source);
        const ranges: PlacedRange[] = list
          .filter((entry) => entry.chapter.captions)
          .flatMap((entry) =>
            entry.pieces.map((piece) => ({ from: piece.from, to: piece.to, at: piece.at })),
          );
        if (ranges.length === 0) continue;
        if (!data?.transcript) {
          warnings.push(
            `Captions for ${source} were left out: it has no transcript (analyze_media).`,
          );
          continue;
        }
        cues.push(
          ...captionCuesFromWords(data.transcript.words, ranges, {
            sentenceEnds: new Set(data.transcript.sentences.map((sentence) => sentence.lastWord)),
          }),
        );
      }
      cues.sort((a, b) => a.start - b.start);
      for (let i = 1; i < cues.length; i++) {
        const previous = cues[i - 1];
        const cue = cues[i];
        if (previous && cue && cue.start <= previous.start)
          cue.start = round3(previous.start + 0.001);
      }
      if (cues.length === 0)
        warnings.push("Captions were left out: the captioned chapters have no speech.");
      else {
        captions = { preset, cues: cues.length };
        captionOp = { op: "apply_captions", preset, cues };
      }
    }
  }

  const operations: EditOperation[] = [
    ...(replaced.length > 0
      ? [{ op: "remove_clip", clips: replaced.map((clip) => clip.id) } satisfies EditOperation]
      : []),
    ...aRoll,
    ...materialOps,
    { op: "set_composition", duration },
    ...(captionOp ? [captionOp] : []),
  ];
  return {
    operations,
    duration,
    chapters: built,
    materials: materials.map(({ op, ...rest }) => ({ ...rest, operation: operations.indexOf(op) })),
    removedClips: replaced.length,
    keptClips: timeline.clips.length - replaced.length,
    captions,
    warnings,
  };
}

interface PlacedPiece extends CleanedPiece {
  at: number;
}
