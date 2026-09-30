import type { Shot, ShotMap, TimeRange, VisualProblem } from "@hyperframes/agent-protocol";

/** Scene cuts closer than this to each other (or to the media's edges) are one cut. */
const MIN_SHOT_SECONDS = 0.5;
/** Picture problems shorter than this are not worth reporting. */
const MIN_PROBLEM_SECONDS = 0.5;
/** Frozen ranges that touch (or nearly) are one freeze; the detector reports them piecewise around noisy frames. */
const FROZEN_MERGE_GAP_SECONDS = 0.25;
/** A freeze that starts sooner than this after its shot's first frame is a static shot (slide, title card), not a freeze. */
const STATIC_SHOT_LEAD_SECONDS = 1.0;
/** A freeze covering this share of its shot is a static shot, even when a short intro animation precedes it. */
const STATIC_SHOT_COVERAGE = 0.9;
/** A frozen range this much covered by a black range is the black picture, reported once as black. */
const FROZEN_BLACK_COVERAGE = 0.8;

const round3 = (value: number): number => Math.round(value * 1000) / 1000;

const overlapSeconds = (a: TimeRange, b: TimeRange): number =>
  Math.max(0, Math.min(a.end, b.end) - Math.max(a.start, b.start));

/**
 * The frozen ranges that are real freezes. Touching ranges merge; a range a cut runs through is split at the cut (a
 * freeze cannot span two shots). Then the ranges of a static shot are dropped — one that starts within a second of its
 * shot's first frame or covers nearly all of the shot (a slide, a title card, a still) — and so are ranges that are
 * mostly the black picture.
 */
function realFreezes(
  frozen: readonly TimeRange[],
  shots: readonly Shot[],
  black: readonly TimeRange[],
): TimeRange[] {
  const merged: TimeRange[] = [];
  for (const range of [...frozen].sort((a, b) => a.start - b.start || a.end - b.end)) {
    const previous = merged[merged.length - 1];
    if (previous && range.start - previous.end <= FROZEN_MERGE_GAP_SECONDS)
      previous.end = Math.max(previous.end, range.end);
    else merged.push({ start: range.start, end: range.end });
  }

  const pieces: TimeRange[] = [];
  for (const range of merged) {
    let start = range.start;
    for (const shot of shots) {
      if (shot.start > start + 1e-6 && shot.start < range.end - 1e-6) {
        pieces.push({ start, end: shot.start });
        start = shot.start;
      }
    }
    pieces.push({ start, end: range.end });
  }

  return pieces.filter((piece) => {
    const shot = shots.find(
      (candidate) => piece.start < candidate.end - 1e-6 && piece.end > candidate.start + 1e-6,
    );
    if (shot) {
      if (piece.start - shot.start < STATIC_SHOT_LEAD_SECONDS) return false;
      const shotLength = shot.end - shot.start;
      if (shotLength > 0 && (piece.end - piece.start) / shotLength >= STATIC_SHOT_COVERAGE)
        return false;
    }
    let dark = 0;
    for (const range of black) dark += overlapSeconds(piece, range);
    return dark < FROZEN_BLACK_COVERAGE * (piece.end - piece.start);
  });
}

/**
 * Shots between consecutive hard cuts whose scene score reaches `threshold`. A cut within half a second of the previous
 * one (or of either edge of the media) is ignored so no shot is shorter than that. Black ranges are passed through,
 * clipped to the media and without the ones under half a second; frozen ranges are too, once the static shots
 * (see `realFreezes`) are taken out.
 */
export function buildShotMap(
  source: string,
  duration: number,
  cuts: ReadonlyArray<{ time: number; score: number }>,
  threshold: number,
  black: readonly TimeRange[],
  frozen: readonly TimeRange[],
): ShotMap {
  const boundaries: number[] = [];
  let last = 0;
  for (const cut of [...cuts].sort((a, b) => a.time - b.time)) {
    if (!(cut.score >= threshold)) continue;
    if (cut.time - last < MIN_SHOT_SECONDS || duration - cut.time < MIN_SHOT_SECONDS) continue;
    boundaries.push(cut.time);
    last = cut.time;
  }

  const shots: Shot[] = [];
  if (duration > 0) {
    const edges = [0, ...boundaries, duration];
    for (let index = 0; index < edges.length - 1; index++)
      shots.push({
        id: `k${index + 1}`,
        start: round3(edges[index] ?? 0),
        end: round3(edges[index + 1] ?? duration),
      });
  }

  const limit = duration > 0 ? duration : 0;
  const clip = (range: TimeRange): TimeRange => ({
    start: Math.max(0, range.start),
    end: Math.min(range.end, limit),
  });
  const clippedBlack = black.map(clip);
  const problems: VisualProblem[] = [];
  for (const [kind, ranges] of [
    ["black", clippedBlack],
    ["frozen", realFreezes(frozen.map(clip), shots, clippedBlack)],
  ] as const) {
    for (const range of ranges) {
      const start = round3(Math.max(0, range.start));
      const end = round3(Math.min(range.end, limit));
      if (end - start >= MIN_PROBLEM_SECONDS) problems.push({ kind, start, end });
    }
  }
  problems.sort((a, b) => a.start - b.start || a.end - b.end || a.kind.localeCompare(b.kind));
  return { source, sceneThreshold: threshold, shots, problems };
}
