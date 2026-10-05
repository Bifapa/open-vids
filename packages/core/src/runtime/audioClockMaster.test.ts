import { describe, expect, it } from "vitest";
import {
  type AudioClockCandidate,
  AUDIO_CLOCK_HANDOFF_TOLERANCE_SECONDS,
  chooseAudioClockMaster,
} from "./audioClockMaster";
import type { AudioClockSource } from "./clock";

type TestClip = AudioClockCandidate & { reportedTime: number | null };

/** An `<audio>` clip in `[start, end)` whose element reports `reportedTime` in composition time. */
function clip(
  start: number,
  end: number,
  state: { paused?: boolean; readyState?: number; reportedTime?: number | null } = {},
): TestClip {
  const el = document.createElement("audio");
  Object.defineProperty(el, "paused", { value: state.paused ?? false });
  Object.defineProperty(el, "readyState", { value: state.readyState ?? 4 });
  return {
    el,
    start,
    end,
    source: { el, compositionStart: start, mediaStart: 0 },
    reportedTime: state.reportedTime === undefined ? null : state.reportedTime,
  };
}

function choose(candidates: TestClip[], current: { el: HTMLMediaElement | null; time: number }) {
  const timeOf = (source: AudioClockSource) =>
    "el" in source
      ? (candidates.find((candidate) => candidate.el === source.el)?.reportedTime ?? null)
      : source.currentTimeSeconds;
  return chooseAudioClockMaster(candidates, current, timeOf);
}

describe("chooseAudioClockMaster", () => {
  it("keeps following the music bed while sound effects start over it", () => {
    // The effect comes first in the document, as the agent writes them, and its player just
    // started: it still reports the start of its window, 0.4 s behind the playhead.
    const effect = clip(5, 6.2, { reportedTime: 5 });
    const bed = clip(0, 43, { reportedTime: 5.4 });
    const choice = choose([effect, bed], { el: bed.el, time: 5.4 });
    expect(choice).toEqual({ kind: "follow", candidate: bed });
  });

  it("hands the clock to the clip that lasts longest, once it reports the time the clock shows", () => {
    const voice = clip(2, 20, { reportedTime: 2.5 });
    const music = clip(0, 40, { reportedTime: 2.5 });
    expect(choose([voice, music], { el: null, time: 2.5 })).toEqual({
      kind: "follow",
      candidate: music,
    });

    const lagging = clip(0, 40, { reportedTime: 2.5 - 3 * AUDIO_CLOCK_HANDOFF_TOLERANCE_SECONDS });
    expect(choose([voice, lagging], { el: null, time: 2.5 })).toEqual({
      kind: "follow",
      candidate: voice,
    });
    expect(choose([lagging], { el: null, time: 2.5 })).toEqual({ kind: "none" });
  });

  it("never lets a sound effect drive the clock", () => {
    const tick = clip(1, 1.05, { reportedTime: 1.02 });
    expect(choose([tick], { el: null, time: 1.02 })).toEqual({ kind: "none" });
    expect(choose([tick], { el: tick.el, time: 1.02 })).toEqual({ kind: "none" });
  });

  it("holds the playhead while the clip that should drive the clock is buffering", () => {
    const voice = clip(0, 30, { paused: true, readyState: 1 });
    const effect = clip(0, 0.5, { reportedTime: 0.2 });
    expect(choose([effect, voice], { el: null, time: 0.2 })).toEqual({ kind: "hold" });
    const ready = clip(0, 30, { paused: true, readyState: 4 });
    expect(choose([ready], { el: null, time: 0.2 })).toEqual({ kind: "none" });
  });
});
