import { describe, expect, it } from "vitest";
import {
  clampRangeToFile,
  dragRange,
  effectivePick,
  formatRangeClock,
  formatRangeLabel,
  formatRangeTime,
  isWholeFile,
  moveEnd,
  moveStart,
  nudgeHandle,
  parseRangeTime,
  percentAt,
  sameRange,
  shiftRange,
  storedRange,
  timeAtPointer,
} from "./assetRange";

describe("range time formatting", () => {
  it("writes m:ss.s, h:mm:ss.s from an hour, rounded to a tenth", () => {
    expect(formatRangeTime(0)).toBe("0:00.0");
    expect(formatRangeTime(42)).toBe("0:42.0");
    expect(formatRangeTime(75.46)).toBe("1:15.5");
    expect(formatRangeTime(59.96)).toBe("1:00.0");
    expect(formatRangeTime(3723.4)).toBe("1:02:03.4");
    expect(formatRangeTime(-3)).toBe("0:00.0");
    expect(formatRangeTime(Number.NaN)).toBe("0:00.0");
  });

  it("labels a badge with whole seconds", () => {
    expect(formatRangeClock(42.4)).toBe("0:42");
    expect(formatRangeClock(3661)).toBe("1:01:01");
    expect(formatRangeLabel({ start: 42, end: 75 })).toBe("0:42–1:15");
  });
});

describe("parsing a typed time", () => {
  it.each([
    ["75", 75],
    ["75.5", 75.5],
    ["75,5", 75.5],
    ["1:15", 75],
    ["1:15.5", 75.5],
    ["01:15,50", 75.5],
    ["0:00.1", 0.1],
    ["1:02:03.4", 3723.4],
    ["  2:00  ", 120],
  ])("reads %s as %f s", (text, seconds) => {
    expect(parseRangeTime(text)).toBe(seconds);
  });

  it.each([
    "",
    " ",
    "abc",
    "-5",
    "1:",
    ":30",
    "1:75",
    "1:60.0",
    "1:75:00",
    "1:2:3:4",
    "1.2.3",
    "1e3",
  ])("refuses %j", (text) => {
    expect(parseRangeTime(text)).toBeNull();
  });

  it("round-trips what the editor shows", () => {
    for (const seconds of [0, 0.1, 42, 75.5, 3723.4]) {
      expect(parseRangeTime(formatRangeTime(seconds))).toBe(seconds);
    }
  });
});

describe("handle limits", () => {
  const duration = 100;

  it("keeps the in point inside the file and a minimum length before the out point", () => {
    const range = { start: 10, end: 20 };
    expect(moveStart(range, -5, duration)).toEqual({ start: 0, end: 20 });
    expect(moveStart(range, 19.95, duration)).toEqual({ start: 19.9, end: 20 });
    expect(moveStart(range, 50, duration)).toEqual({ start: 19.9, end: 20 });
  });

  it("keeps the out point inside the file and a minimum length after the in point", () => {
    const range = { start: 10, end: 20 };
    expect(moveEnd(range, 140, duration)).toEqual({ start: 10, end: 100 });
    expect(moveEnd(range, 10.05, duration)).toEqual({ start: 10, end: 10.1 });
    expect(moveEnd(range, 0, duration)).toEqual({ start: 10, end: 10.1 });
  });

  it("can pick the last tenth of the file without leaving it", () => {
    expect(moveStart({ start: 0, end: 100 }, 100, duration)).toEqual({ start: 99.9, end: 100 });
    expect(moveEnd({ start: 99.9, end: 100 }, 99, duration)).toEqual({ start: 99.9, end: 100 });
  });

  it("slides the whole range, keeping its length, and stops at either edge", () => {
    const range = { start: 40, end: 60 };
    expect(shiftRange(range, 10, duration)).toEqual({ start: 50, end: 70 });
    expect(shiftRange(range, -90, duration)).toEqual({ start: 0, end: 20 });
    expect(shiftRange(range, 90, duration)).toEqual({ start: 80, end: 100 });
  });

  it("applies a drag's pointer travel to the range the drag began on", () => {
    const origin = { start: 40, end: 60 };
    expect(dragRange("start", origin, -15, duration)).toEqual({ start: 25, end: 60 });
    expect(dragRange("end", origin, 15, duration)).toEqual({ start: 40, end: 75 });
    expect(dragRange("move", origin, 15, duration)).toEqual({ start: 55, end: 75 });
    // Dragging the in point past the out point stops a minimum length short of it.
    expect(dragRange("start", origin, 30, duration)).toEqual({ start: 59.9, end: 60 });
  });

  it("nudges a handle 0.1 s, a second with Shift, without float drift", () => {
    let range = { start: 10, end: 20 };
    for (let i = 0; i < 3; i += 1) range = nudgeHandle("start", range, 1, false, duration);
    expect(range.start).toBe(10.3);
    expect(nudgeHandle("end", range, -1, true, duration)).toEqual({ start: 10.3, end: 19 });
    expect(nudgeHandle("start", { start: 0, end: 5 }, -1, false, duration).start).toBe(0);
    expect(nudgeHandle("end", { start: 5, end: 100 }, 1, true, duration).end).toBe(100);
  });
});

describe("what gets stored", () => {
  it("stores a pick, and nothing when it spans the whole file", () => {
    expect(storedRange({ start: 42, end: 75 }, 120)).toEqual({ start: 42, end: 75 });
    expect(storedRange({ start: 0, end: 120 }, 120)).toBeNull();
    expect(storedRange({ start: 0.002, end: 119.998 }, 120)).toBeNull();
    expect(storedRange({ start: 0, end: 119 }, 120)).toEqual({ start: 0, end: 119 });
  });

  it("clamps a range into a file that got shorter, and drops one nothing is left of", () => {
    expect(clampRangeToFile({ start: 42, end: 75 }, 60)).toEqual({ start: 42, end: 60 });
    expect(clampRangeToFile({ start: 42, end: 75 }, 42.05)).toBeNull();
    expect(clampRangeToFile({ start: 70, end: 75 }, 60)).toBeNull();
  });

  it("reads the pick a file's current length leaves in effect", () => {
    expect(effectivePick({ start: 42, end: 75 }, 120)).toEqual({ start: 42, end: 75 });
    expect(effectivePick({ start: 42, end: 75 }, 60)).toEqual({ start: 42, end: 60 });
    expect(effectivePick({ start: 0, end: 75 }, 60)).toBeNull();
    // Length not probed yet: the pick stands as stored.
    expect(effectivePick({ start: 42, end: 75 }, null)).toEqual({ start: 42, end: 75 });
    expect(effectivePick(null, 60)).toBeNull();
  });

  it("compares ranges, where none equals none", () => {
    expect(sameRange(null, undefined)).toBe(true);
    expect(sameRange({ start: 1, end: 2 }, null)).toBe(false);
    expect(sameRange({ start: 1, end: 2 }, { start: 1, end: 2 })).toBe(true);
    expect(isWholeFile({ start: 0, end: 10 }, 10)).toBe(true);
  });
});

describe("strip geometry", () => {
  it("turns a pointer position into seconds, clamped to the strip", () => {
    expect(timeAtPointer(150, 100, 200, 60)).toBe(15);
    expect(timeAtPointer(0, 100, 200, 60)).toBe(0);
    expect(timeAtPointer(999, 100, 200, 60)).toBe(60);
    expect(timeAtPointer(150, 100, 0, 60)).toBe(0);
  });

  it("places a time along the strip as a percentage", () => {
    expect(percentAt(15, 60)).toBe("25%");
    expect(percentAt(90, 60)).toBe("100%");
    expect(percentAt(5, 0)).toBe("0%");
  });
});
