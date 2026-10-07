import { describe, expect, it } from "vitest";
import type { TimelineElement } from "../store/playerStore";
import { resolveDurationRipple, type DurationRipple } from "./timelineDurationRipple";

function clip(id: string, start: number, duration: number, extra: Partial<TimelineElement> = {}) {
  return {
    id,
    key: id,
    tag: "audio",
    start,
    duration,
    track: 3,
    domId: id,
    ...extra,
  } satisfies TimelineElement;
}

/** Three back-to-back lines on one track, and an unrelated clip on another. */
const LANE = [clip("a", 0, 3), clip("b", 3, 2), clip("c", 5, 4), clip("other", 5, 4, { track: 4 })];

function shifts(result: DurationRipple): Record<string, number> {
  return result.kind === "shift" ? Object.fromEntries(result.starts) : {};
}

describe("resolveDurationRipple", () => {
  it("pushes the later clips of the same track by the length the take gained", () => {
    const result = resolveDurationRipple(LANE, [{ element: LANE[0]!, duration: 4.5 }], true);
    expect(result.kind).toBe("shift");
    expect(shifts(result)).toEqual({ b: 4.5, c: 6.5 });
    // The unrelated track and the changed clip itself stay put.
    expect(result.kind === "shift" && result.shiftedKeys).toEqual(["b", "c"]);
  });

  it("pulls them back by the length the take lost", () => {
    const result = resolveDurationRipple(LANE, [{ element: LANE[1]!, duration: 1 }], true);
    expect(shifts(result)).toEqual({ c: 4 });
  });

  it("moves nothing while ripple is off", () => {
    expect(resolveDurationRipple(LANE, [{ element: LANE[0]!, duration: 9 }], false)).toEqual({
      kind: "none",
    });
  });

  it("moves nothing when the length is the same or nothing follows", () => {
    expect(resolveDurationRipple(LANE, [{ element: LANE[0]!, duration: 3.0004 }], true)).toEqual({
      kind: "none",
    });
    expect(resolveDurationRipple(LANE, [{ element: LANE[2]!, duration: 8 }], true)).toEqual({
      kind: "none",
    });
  });

  it("leaves a clip that starts inside the changed clip alone", () => {
    const overlapping = [clip("a", 0, 6), clip("inside", 2, 1), clip("after", 6, 2)];
    const result = resolveDurationRipple(
      overlapping,
      [{ element: overlapping[0]!, duration: 7 }],
      true,
    );
    expect(shifts(result)).toEqual({ after: 7 });
  });

  it("refuses the whole ripple when a later clip is locked", () => {
    const locked = [clip("a", 0, 3), clip("b", 3, 2, { timelineLocked: true }), clip("c", 5, 4)];
    const result = resolveDurationRipple(locked, [{ element: locked[0]!, duration: 4 }], true);
    expect(result).toEqual({ kind: "locked", lockedKeys: ["b"] });
  });

  it("ignores a locked clip that would not move", () => {
    const locked = [clip("a", 0, 3), clip("far", 0, 3, { track: 9, timelineLocked: true })];
    const result = resolveDurationRipple(locked, [{ element: locked[0]!, duration: 4 }], true);
    expect(result).toEqual({ kind: "none" });
  });

  it("adds up the lengths of several changed clips before a later one", () => {
    const result = resolveDurationRipple(
      LANE,
      [
        { element: LANE[0]!, duration: 4 },
        { element: LANE[1]!, duration: 3 },
      ],
      true,
    );
    // b is pushed by a's gain (+1); c by a's and b's (+1 +1); b is a changed clip, so it is not "shifted".
    expect(shifts(result)).toEqual({ b: 4, c: 7 });
    expect(result.kind === "shift" && result.shiftedKeys).toEqual(["c"]);
  });

  it("never moves a clip before 0", () => {
    const early = [clip("a", 0, 5), clip("b", 5, 2)];
    const result = resolveDurationRipple(early, [{ element: early[0]!, duration: 0.5 }], true);
    expect(shifts(result)).toEqual({ b: 0.5 });
  });

  it("keeps clips of another composition file on the same track number apart", () => {
    const files = [
      clip("a", 0, 3, { sourceFile: "index.html" }),
      clip("b", 3, 2, { sourceFile: "scene.html" }),
    ];
    expect(resolveDurationRipple(files, [{ element: files[0]!, duration: 5 }], true)).toEqual({
      kind: "none",
    });
  });
});
