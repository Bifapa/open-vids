import type { AudioClockSource } from "./clock";

/** An `<audio>` clip whose window holds the playhead, as the transport would follow it. */
export interface AudioClockCandidate {
  el: HTMLMediaElement;
  source: Extract<AudioClockSource, { el: HTMLMediaElement }>;
  start: number;
  end: number;
}

/** A clip shorter than this (a sound effect) never drives the clock: it has barely started when it ends. */
export const MIN_AUDIO_CLOCK_CLIP_SECONDS = 1;
/** A new clock source must report a time this close to the current one; a player just started lags. */
export const AUDIO_CLOCK_HANDOFF_TOLERANCE_SECONDS = 0.1;

const HAVE_FUTURE_DATA = 3;

export type AudioClockChoice =
  | { kind: "follow"; candidate: AudioClockCandidate }
  /** The clip that should drive the clock is buffering: hold the playhead where it is. */
  | { kind: "hold" }
  | { kind: "none" };

/**
 * Which audio clip the transport clock follows on this tick.
 *
 * The clip it already follows stays the clock while it plays: switching between clips every tick,
 * each reporting its own slightly different position (a player that just started still reports the
 * start of its clip), dragged the playhead back and forth until it crawled. A new clock is the
 * playing clip whose window lasts longest (the music bed, the voice-over), and only once it reports
 * the time the clock already shows. Sound effects (`MIN_AUDIO_CLOCK_CLIP_SECONDS`) never drive it.
 * When the clip that would is still buffering, the playhead holds rather than running ahead.
 */
export function chooseAudioClockMaster(
  candidates: readonly AudioClockCandidate[],
  current: { el: HTMLMediaElement | null; time: number },
  timeOf: (source: AudioClockSource) => number | null,
): AudioClockChoice {
  const eligible = candidates
    .filter((candidate) => candidate.end - candidate.start >= MIN_AUDIO_CLOCK_CLIP_SECONDS)
    .sort((a, b) => b.end - a.end || a.start - b.start);
  const kept = eligible.find((candidate) => candidate.el === current.el && !candidate.el.paused);
  if (kept) return { kind: "follow", candidate: kept };
  for (const candidate of eligible) {
    if (candidate.el.paused) continue;
    const time = timeOf(candidate.source);
    if (time !== null && Math.abs(time - current.time) <= AUDIO_CLOCK_HANDOFF_TOLERANCE_SECONDS) {
      return { kind: "follow", candidate };
    }
  }
  const longest = eligible[0];
  if (
    longest &&
    longest.el.paused &&
    !longest.el.error &&
    longest.el.readyState < HAVE_FUTURE_DATA
  ) {
    return { kind: "hold" };
  }
  return { kind: "none" };
}
