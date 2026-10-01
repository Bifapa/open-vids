import {
  EDIT_LIMITS,
  captionCuesFromWords,
  type ApplyEditsRequest,
  type CaptionCue,
  type CutPlan,
  type EditOperation,
  type TimelineSnapshot,
  type TranscriptView,
  type VisualProblem,
} from "@hyperframes/agent-protocol";
import { EditingError } from "../editing/host.js";

/** Short audio gain ramp at both edges of every clip of a rough cut, against clicks at the cuts. */
export const ROUGH_CUT_EDGE_FADE = 0.02;

const normalizePath = (path: string) =>
  path
    .replaceAll("\\", "/")
    .replace(/^(\.\/)+/, "")
    .replace(/^\/+/, "");

/** Whether a timeline clip plays the given project-relative source file. */
export const playsSource = (clipSrc: string | null, source: string): boolean =>
  clipSrc !== null && normalizePath(clipSrc) === normalizePath(source);

export interface RoughCutBatch {
  request: ApplyEditsRequest;
  /** Clips the batch replaces: the clips of the target track that play the plan's source. */
  replacedClips: number;
  /** Untouched blank-template placeholder clips on the target track, removed with the cut (not user content). */
  removedPlaceholders: number;
  /** Clips on other tracks (cutaways, B-roll, captions, manual additions): kept, positioned for the previous cut. */
  keptClips: number;
  /** Length of the finished cut on the timeline, seconds. */
  length: number;
}

/** A caption preset with the cues to write in the same batch. */
export interface RoughCutCaptions {
  preset: string;
  cues: CaptionCue[];
}

/**
 * One atomic batch that turns a cut plan into the timeline: remove the clips of the target track that play the
 * plan's source (the previous cut; clips on other tracks are kept), place the plan's ranges back to back with
 * `add_sequence` (stamped with the plan's id and the turn), set the composition to the cut's length and, when asked,
 * write the captions.
 */
export function roughCutBatch(input: {
  plan: CutPlan;
  timeline: TimelineSnapshot;
  composition: string | undefined;
  track: number;
  /** The agent turn building the cut (stamped on the clips). */
  turnId?: string | undefined;
  captions?: RoughCutCaptions | undefined;
}): RoughCutBatch {
  const { plan, timeline, composition, track, turnId, captions } = input;
  if (plan.ranges.length === 0)
    throw new EditingError("invalid_request", `Plan ${plan.id} keeps no material.`);
  if (plan.ranges.length > EDIT_LIMITS.sequenceRanges) {
    throw new EditingError(
      "invalid_request",
      `Plan ${plan.id} has ${plan.ranges.length} ranges; one batch places at most ${EDIT_LIMITS.sequenceRanges}. Plan again with a larger maxPause or fewer segments.`,
    );
  }
  const replaced = timeline.clips
    .filter((clip) => clip.track === track && playsSource(clip.src, plan.source))
    .map((clip) => clip.id);
  const placeholders = timeline.clips
    .filter((clip) => clip.track === track && clip.placeholder === true)
    .map((clip) => clip.id);
  if (replaced.length + placeholders.length > EDIT_LIMITS.removeClips) {
    throw new EditingError(
      "invalid_request",
      `${replaced.length} clips of ${plan.source} are on track ${track}; remove some with edit_timeline first (a batch removes at most ${EDIT_LIMITS.removeClips}).`,
    );
  }
  const length = plan.ranges.reduce(
    (end, range) => Math.max(end, range.at + range.to - range.from),
    0,
  );
  const operations: EditOperation[] = [
    ...(replaced.length + placeholders.length > 0
      ? [{ op: "remove_clip", clips: [...replaced, ...placeholders] } satisfies EditOperation]
      : []),
    {
      op: "add_sequence",
      asset: plan.source,
      track,
      start: 0,
      ranges: plan.ranges.map((range) => ({ from: range.from, to: range.to })),
      edgeFade: ROUGH_CUT_EDGE_FADE,
      provenance: { cut: plan.id, ...(turnId && { turn: turnId }) },
    },
    { op: "set_composition", duration: Number(length.toFixed(3)) },
    ...(captions
      ? [
          {
            op: "apply_captions",
            preset: captions.preset,
            cues: captions.cues,
          } satisfies EditOperation,
        ]
      : []),
  ];
  return {
    request: {
      ...(composition && { composition }),
      baseVersion: timeline.version,
      operations,
    },
    replacedClips: replaced.length,
    removedPlaceholders: placeholders.length,
    keptClips: timeline.clips.filter((clip) => clip.track !== track).length,
    length,
  };
}

/**
 * Word-synced caption cues for a plan: the transcript's words that fall inside the plan's kept ranges, placed at
 * their timeline time, with cue breaks at sentence ends. The transcript must have been read with its words.
 */
export function planCaptionCues(
  plan: Pick<CutPlan, "ranges" | "id">,
  transcript: Pick<TranscriptView, "words" | "sentences">,
): CaptionCue[] {
  const words = transcript.words ?? [];
  const indexOfWord = new Map(words.map((word, index) => [word.i, index]));
  const sentenceEnds = new Set<number>();
  for (const sentence of transcript.sentences) {
    const index = indexOfWord.get(sentence.lastWord);
    if (index !== undefined) sentenceEnds.add(index);
  }
  const cues = captionCuesFromWords(
    words,
    plan.ranges.map((range) => ({ from: range.from, to: range.to, at: range.at })),
    { sentenceEnds },
  );
  if (cues.length === 0)
    throw new EditingError(
      "invalid_request",
      `Plan ${plan.id} has no transcript words to caption (is the source transcribed?).`,
    );
  if (cues.length > EDIT_LIMITS.captionCues)
    throw new EditingError(
      "invalid_request",
      `The cut has ${cues.length} caption cues; one batch writes at most ${EDIT_LIMITS.captionCues}. Caption it with edit_timeline in parts.`,
    );
  return cues;
}

export interface TimelineProblem {
  kind: VisualProblem["kind"];
  /** Timeline seconds. */
  start: number;
  end: number;
  /** The same stretch in the source, seconds. */
  sourceStart: number;
  sourceEnd: number;
}

/** Where kept material of the plan overlaps a black or frozen stretch of the source, in timeline seconds. */
export function problemsOnTimeline(
  plan: Pick<CutPlan, "ranges">,
  problems: readonly VisualProblem[],
): TimelineProblem[] {
  const found: TimelineProblem[] = [];
  for (const range of plan.ranges) {
    for (const problem of problems) {
      const from = Math.max(range.from, problem.start);
      const to = Math.min(range.to, problem.end);
      if (to - from <= 0.05) continue;
      found.push({
        kind: problem.kind,
        start: range.at + (from - range.from),
        end: range.at + (to - range.from),
        sourceStart: from,
        sourceEnd: to,
      });
    }
  }
  return found.sort((a, b) => a.start - b.start);
}
