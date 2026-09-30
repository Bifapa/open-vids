// @vitest-environment node
import { describe, expect, it } from "vitest";
import { buildShotMap } from "./shots.js";

describe("buildShotMap", () => {
  it("cuts shots at scene changes above the threshold, ignoring cuts closer than half a second", () => {
    const map = buildShotMap(
      "a.mp4",
      60,
      [
        { time: 10, score: 0.6 },
        { time: 10.3, score: 0.9 },
        { time: 20, score: 0.2 },
        { time: 30, score: 0.3 },
        { time: 59.8, score: 0.9 },
        { time: 0.2, score: 0.9 },
      ],
      0.3,
      [],
      [],
    );
    expect(map.shots).toEqual([
      { id: "k1", start: 0, end: 10 },
      { id: "k2", start: 10, end: 30 },
      { id: "k3", start: 30, end: 60 },
    ]);
    expect(map.sceneThreshold).toBe(0.3);
  });

  it("passes black and frozen problems through, clipped to the media and without slivers", () => {
    const map = buildShotMap(
      "a.mp4",
      60,
      [],
      0.3,
      [
        { start: 0, end: 1.2 },
        { start: 20, end: 20.3 },
        { start: 58, end: 75 },
      ],
      [{ start: 30, end: 33 }],
    );
    expect(map.shots).toEqual([{ id: "k1", start: 0, end: 60 }]);
    expect(map.problems).toEqual([
      { kind: "black", start: 0, end: 1.2 },
      { kind: "frozen", start: 30, end: 33 },
      { kind: "black", start: 58, end: 60 },
    ]);
  });

  describe("frozen ranges", () => {
    const frozenOf = (
      cuts: number[],
      black: Array<{ start: number; end: number }>,
      frozen: Array<{ start: number; end: number }>,
    ) =>
      buildShotMap(
        "a.mp4",
        60,
        cuts.map((time) => ({ time, score: 0.9 })),
        0.3,
        black,
        frozen,
      ).problems.filter((problem) => problem.kind === "frozen");

    it("drops a range that starts within a second of its shot: that is a static shot, not a freeze", () => {
      expect(frozenOf([30], [], [{ start: 30.2, end: 58 }])).toEqual([]);
      expect(frozenOf([], [], [{ start: 0.4, end: 50 }])).toEqual([]);
    });

    it("keeps a freeze that starts later in a shot with motion", () => {
      expect(frozenOf([], [], [{ start: 20, end: 25 }])).toEqual([
        { kind: "frozen", start: 20, end: 25 },
      ]);
    });

    it("drops a freeze that covers almost the whole shot after a short intro animation", () => {
      expect(frozenOf([10], [], [{ start: 11.8, end: 59.5 }])).toEqual([]);
    });

    it("merges pieces the detector reported around one freeze, so the later pieces are not mistaken for freezes", () => {
      expect(
        frozenOf(
          [],
          [],
          [
            { start: 30, end: 33 },
            { start: 33.1, end: 36 },
          ],
        ),
      ).toEqual([{ kind: "frozen", start: 30, end: 36 }]);
      // A static shot reported in pieces stays dropped.
      expect(
        frozenOf(
          [30],
          [],
          [
            { start: 30.1, end: 40 },
            { start: 40, end: 45 },
            { start: 45.1, end: 58 },
          ],
        ),
      ).toEqual([]);
    });

    it("splits a range at a cut inside it and judges each part on its own", () => {
      expect(frozenOf([40], [], [{ start: 30, end: 50 }])).toEqual([
        { kind: "frozen", start: 30, end: 40 },
      ]);
    });

    it("drops a frozen range that is mostly the black picture and keeps the black problem", () => {
      const map = buildShotMap(
        "a.mp4",
        60,
        [],
        0.3,
        [{ start: 20, end: 27 }],
        [{ start: 20.5, end: 27 }],
      );
      expect(map.problems).toEqual([{ kind: "black", start: 20, end: 27 }]);
    });
  });
});
