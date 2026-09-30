import type {
  SegmentMap,
  ShotMap,
  TakeAnalysis,
  VisionAnalysis,
  VisionTarget,
} from "@hyperframes/agent-protocol";

/** Most frames Vision is ever asked to look at for one source. */
const MAX_FRAMES = 40;
/** Extra frames for long shots that no other target already covers. */
const MAX_SHOT_SAMPLES = 6;
/** A frame this close to an inspected one counts as the same frame. */
const SAME_FRAME_SECONDS = 0.05;
/** Frames on a black/frozen range stay this far from its edges. */
const PROBLEM_EDGE_SECONDS = 0.5;

const round1 = (value: number): number => Math.round(value * 10) / 10;

/**
 * The frames worth showing to Vision, chosen from what the deterministic stages found (never a dense sample of the
 * whole video): three frames on every black/frozen range, the middle of every take issue that needs a look, one frame
 * per segment (the middle of its longest shot) and up to six frames of the longest shots nothing else covers. At most
 * 40 frames in total; times are rounded to 0.1 s, `inspected` is true when Vision already looked at all of them.
 */
export function visionTargets(input: {
  duration: number;
  shots: ShotMap | null;
  takes: TakeAnalysis | null;
  segments: SegmentMap | null;
  vision: VisionAnalysis | null;
}): VisionTarget[] {
  const { duration, shots, takes, segments, vision } = input;
  const last = Math.max(0, round1(duration - 0.1));
  const snap = (time: number): number => Math.min(last, Math.max(0, round1(time)));
  const inspectedFrames = vision?.inspectedFrames ?? [];
  const chosen: number[] = [];
  const isChosen = (time: number): boolean =>
    chosen.some((other) => Math.abs(other - time) < SAME_FRAME_SECONDS);

  const targets: VisionTarget[] = [];
  let budget = MAX_FRAMES;
  const add = (
    reason: VisionTarget["reason"],
    ref: string | null,
    start: number,
    end: number,
    wanted: number[],
    allowShared: boolean,
  ) => {
    const times: number[] = [];
    for (const time of wanted.map(snap)) {
      if (times.length >= budget) break;
      if (times.some((other) => Math.abs(other - time) < SAME_FRAME_SECONDS)) continue;
      if (!allowShared && isChosen(time)) continue;
      times.push(time);
    }
    if (times.length === 0) return;
    budget -= times.length;
    chosen.push(...times);
    targets.push({
      reason,
      ref,
      start,
      end,
      times,
      inspected: times.every((time) =>
        inspectedFrames.some((seen) => Math.abs(seen - time) <= SAME_FRAME_SECONDS),
      ),
    });
  };

  // (a) Picture problems: both ends and the middle.
  const problems = shots?.problems ?? [];
  for (const problem of problems) {
    const issue = takes?.issues.find(
      (candidate) =>
        candidate.kind === problem.kind &&
        Math.abs(candidate.start - problem.start) < 0.001 &&
        Math.abs(candidate.end - problem.end) < 0.001,
    );
    const middle = (problem.start + problem.end) / 2;
    add(
      "visual_problem",
      issue?.id ?? null,
      problem.start,
      problem.end,
      [problem.start + PROBLEM_EDGE_SECONDS, middle, problem.end - PROBLEM_EDGE_SECONDS].map(
        (time) => Math.min(problem.end, Math.max(problem.start, time)),
      ),
      true,
    );
  }

  // (b) Take issues that need a look (not fillers, and picture problems are covered above).
  for (const issue of takes?.issues ?? []) {
    if (issue.action !== "review" || issue.kind === "filler") continue;
    if (issue.kind === "black" || issue.kind === "frozen") continue;
    add("take_review", issue.id, issue.start, issue.end, [(issue.start + issue.end) / 2], true);
  }

  // (c) One representative frame per segment: the middle of its longest shot (inside the segment).
  const allShots = shots?.shots ?? [];
  for (const segment of segments?.segments ?? []) {
    let bestStart = segment.start;
    let bestEnd = segment.end;
    let bestLength = -1;
    for (const shot of allShots) {
      const from = Math.max(shot.start, segment.start);
      const to = Math.min(shot.end, segment.end);
      if (to - from > bestLength) {
        bestLength = to - from;
        bestStart = from;
        bestEnd = to;
      }
    }
    if (bestLength < 0) {
      bestStart = segment.start;
      bestEnd = segment.end;
    }
    add(
      "segment_sample",
      segment.id,
      segment.start,
      segment.end,
      [(bestStart + bestEnd) / 2],
      false,
    );
  }

  // (d) The longest shots no earlier target already covers.
  const uncovered = allShots
    .filter((shot) => !chosen.some((time) => time >= shot.start && time <= shot.end))
    .sort((a, b) => b.end - b.start - (a.end - a.start) || a.start - b.start)
    .slice(0, MAX_SHOT_SAMPLES);
  for (const shot of uncovered)
    add("shot_sample", shot.id, shot.start, shot.end, [(shot.start + shot.end) / 2], false);

  return targets.sort((a, b) => a.start - b.start || a.end - b.end);
}
