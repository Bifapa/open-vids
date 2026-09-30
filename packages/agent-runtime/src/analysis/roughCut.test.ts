import { describe, expect, it } from "vitest";
import type { CutPlan, TimelineSnapshot } from "@hyperframes/agent-protocol";
import { EditingError } from "../editing/host.js";
import { FakeAnalysisHost } from "../testing/analysis.js";
import { clock } from "./format.js";
import { playsSource, problemsOnTimeline, roughCutBatch } from "./roughCut.js";

const ranges: CutPlan["ranges"] = [
  { from: 10, to: 20, at: 0, segment: "g1", hook: true },
  { from: 0, to: 30, at: 10, segment: "g1", hook: false },
  { from: 50, to: 60, at: 40, segment: "g2", hook: false },
];

describe("problemsOnTimeline", () => {
  it("clips a problem to each kept range and maps it to timeline time, in timeline order", () => {
    expect(
      problemsOnTimeline({ ranges }, [
        { kind: "frozen", start: 15, end: 25 },
        { kind: "black", start: 55, end: 70 },
      ]),
    ).toEqual([
      // The hook plays 10–20 at 0: the frozen stretch keeps 15–20.
      { kind: "frozen", start: 5, end: 10, sourceStart: 15, sourceEnd: 20 },
      // The same stretch again where the segment plays in place: 15–25 → 10 + 15.
      { kind: "frozen", start: 25, end: 35, sourceStart: 15, sourceEnd: 25 },
      { kind: "black", start: 45, end: 50, sourceStart: 55, sourceEnd: 60 },
    ]);
  });

  it("ignores problems the cut skips or only touches", () => {
    expect(
      problemsOnTimeline({ ranges }, [
        { kind: "black", start: 30, end: 50 },
        { kind: "black", start: 60, end: 61 },
        { kind: "frozen", start: 59.98, end: 65 },
      ]),
    ).toEqual([]);
  });
});

describe("playsSource", () => {
  it("compares project-relative paths regardless of ./, leading slash and separators", () => {
    expect(playsSource("./assets/a.mp4", "assets/a.mp4")).toBe(true);
    expect(playsSource("assets\\a.mp4", "assets/a.mp4")).toBe(true);
    expect(playsSource("/assets/a.mp4", "assets/a.mp4")).toBe(true);
    expect(playsSource("assets/b.mp4", "assets/a.mp4")).toBe(false);
    expect(playsSource(null, "assets/a.mp4")).toBe(false);
  });
});

async function planOf(planRanges: CutPlan["ranges"]): Promise<CutPlan> {
  const host = new FakeAnalysisHost();
  host.planRanges = planRanges;
  return host.planCut({ source: "assets/a.mp4" }, new AbortController().signal);
}

const timeline: TimelineSnapshot = {
  composition: { path: "index.html", width: 1280, height: 720, duration: 50 },
  version: "sha256:v",
  tracks: [],
  clips: [],
};

describe("roughCutBatch", () => {
  it("measures the cut by where its last range ends, hook included", async () => {
    const batch = roughCutBatch({
      plan: await planOf(ranges),
      timeline,
      composition: "scenes/talk.html",
      track: 0,
    });
    expect(batch.length).toBe(50);
    expect(batch.request.composition).toBe("scenes/talk.html");
    expect(batch.request.operations.at(-1)).toEqual({ op: "set_composition", duration: 50 });
  });

  it("refuses a plan that keeps nothing", async () => {
    const empty = await planOf([]);
    expect(() =>
      roughCutBatch({ plan: empty, timeline, composition: undefined, track: 0 }),
    ).toThrow(EditingError);
  });
});

describe("clock", () => {
  it("rounds to tenths without ever printing 60 seconds", () => {
    expect(clock(59.96)).toBe("01:00.0");
    expect(clock(0)).toBe("00:00.0");
    expect(clock(62.34)).toBe("01:02.3");
    expect(clock(3_725.5)).toBe("1:02:05.5");
    expect(clock(-3)).toBe("00:00.0");
  });
});
