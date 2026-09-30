import {
  EDIT_LIMITS,
  type ApplyEditsRequest,
  type CutPlan,
  type EditOperation,
  type TimelineSnapshot,
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
  /** Clips of the source that the batch replaces, on every track. */
  replacedClips: number;
  /** Length of the finished cut on the timeline, seconds. */
  length: number;
}

/**
 * One atomic batch that turns a cut plan into the timeline: remove the clips that play the plan's source, place the
 * plan's ranges back to back with `add_sequence`, and set the composition to the cut's length.
 */
export function roughCutBatch(input: {
  plan: CutPlan;
  timeline: TimelineSnapshot;
  composition: string | undefined;
  track: number;
}): RoughCutBatch {
  const { plan, timeline, composition, track } = input;
  if (plan.ranges.length === 0)
    throw new EditingError("invalid_request", `Plan ${plan.id} keeps no material.`);
  if (plan.ranges.length > EDIT_LIMITS.sequenceRanges) {
    throw new EditingError(
      "invalid_request",
      `Plan ${plan.id} has ${plan.ranges.length} ranges; one batch places at most ${EDIT_LIMITS.sequenceRanges}. Plan again with a larger maxPause or fewer segments.`,
    );
  }
  const replaced = timeline.clips
    .filter((clip) => playsSource(clip.src, plan.source))
    .map((clip) => clip.id);
  if (replaced.length > EDIT_LIMITS.removeClips) {
    throw new EditingError(
      "invalid_request",
      `${replaced.length} clips of ${plan.source} are on the timeline; remove some with edit_timeline first (a batch removes at most ${EDIT_LIMITS.removeClips}).`,
    );
  }
  const length = plan.ranges.reduce(
    (end, range) => Math.max(end, range.at + range.to - range.from),
    0,
  );
  const operations: EditOperation[] = [
    ...(replaced.length > 0
      ? [{ op: "remove_clip", clips: replaced } satisfies EditOperation]
      : []),
    {
      op: "add_sequence",
      asset: plan.source,
      track,
      start: 0,
      ranges: plan.ranges.map((range) => ({ from: range.from, to: range.to })),
      edgeFade: ROUGH_CUT_EDGE_FADE,
    },
    { op: "set_composition", duration: Number(length.toFixed(3)) },
  ];
  return {
    request: {
      ...(composition && { composition }),
      baseVersion: timeline.version,
      operations,
    },
    replacedClips: replaced.length,
    length,
  };
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
