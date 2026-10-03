import { describe, expect, it } from "vitest";
import { cropRect, framesToEmit, recordSite, type RecordSiteOptions } from "./recordSite.js";
import { SiteInspectError } from "./siteSession.js";

const options = (over: Partial<RecordSiteOptions> = {}): RecordSiteOptions => ({
  url: "https://example.com/",
  outFile: "/tmp/openvids-record-test.mp4",
  seconds: 5,
  signal: new AbortController().signal,
  ...over,
});

describe("framesToEmit", () => {
  it("fills a static page's whole recording from its single frame", () => {
    // One frame at the start, one paint at the end: the first covers everything up to the second.
    expect(framesToEmit(100, 100, 105, 30)).toBe(150);
  });

  it("never stretches the timeline when Chrome paints faster than the output rate", () => {
    // 120 paints a second, 1/120 s apart: each interval covers 0.25 of a frame, dropped; a whole second is 30.
    let emitted = 0;
    let previous = 0;
    for (let step = 1; step <= 120; step++) {
      const timestamp = step / 120;
      emitted += framesToEmit(0, previous, timestamp, 30);
      previous = timestamp;
    }
    expect(emitted).toBe(30);
  });

  it("tracks the rounded grid, not each interval, and never goes backwards", () => {
    expect(framesToEmit(0, 0, 0.02, 30)).toBe(1);
    expect(framesToEmit(0, 0.02, 0.05, 30)).toBe(1);
    expect(framesToEmit(10, 12, 11, 30)).toBe(0);
  });
});

describe("cropRect", () => {
  const viewport = { width: 1920, height: 1080 };

  it("keeps the part of the element inside the viewport, in even pixels", () => {
    expect(cropRect({ x: 0, y: 0, width: 1920, height: 1080 }, viewport)).toEqual({
      x: 0,
      y: 0,
      width: 1920,
      height: 1080,
    });
    expect(cropRect({ x: -100, y: 50, width: 400, height: 300 }, viewport)).toEqual({
      x: 0,
      y: 50,
      width: 300,
      height: 300,
    });
    expect(cropRect({ x: 10.4, y: 10.6, width: 101, height: 51 }, viewport)).toEqual({
      x: 10,
      y: 10,
      width: 102,
      height: 52,
    });
    expect(cropRect({ x: 0, y: 0, width: 101, height: 51 }, viewport)).toEqual({
      x: 0,
      y: 0,
      width: 100,
      height: 50,
    });
  });

  it("answers nothing for an element outside the viewport or too small to encode", () => {
    expect(cropRect({ x: 2000, y: 0, width: 100, height: 100 }, viewport)).toBeNull();
    expect(cropRect({ x: 10, y: 10, width: 1, height: 300 }, viewport)).toBeNull();
  });
});

describe("recordSite validation", () => {
  it("refuses a length or viewport the protocol cannot carry, before touching Chrome", async () => {
    await expect(recordSite(options({ seconds: 0 }))).rejects.toMatchObject({
      code: "unsupported",
    });
    await expect(recordSite(options({ seconds: 31 }))).rejects.toBeInstanceOf(SiteInspectError);
    await expect(recordSite(options({ seconds: 5, width: 1001 }))).rejects.toMatchObject({
      code: "unsupported",
    });
    await expect(recordSite(options({ seconds: 5, height: 4000 }))).rejects.toMatchObject({
      code: "unsupported",
    });
  });
});
