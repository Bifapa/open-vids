// @vitest-environment node
import { describe, expect, it } from "vitest";
import { parseBlackdetect, parseFreezedetect, parseSceneChanges } from "./ffmpegParse.js";

describe("parseSceneChanges", () => {
  it("pairs metadata=print frames with their scene score", () => {
    const stderr = `[Parsed_metadata_2 @ 0x7f8] frame:0    pts:12345   pts_time:12.345
[Parsed_metadata_2 @ 0x7f8] lavfi.scene_score=0.452301
[Parsed_metadata_2 @ 0x7f8] frame:1    pts:30000   pts_time:30
[Parsed_metadata_2 @ 0x7f8] lavfi.scene_score=0.91
`;
    expect(parseSceneChanges(stderr)).toEqual([
      { time: 12.345, score: 0.452 },
      { time: 30, score: 0.91 },
    ]);
  });

  it("reports showinfo-only frames (already above the select threshold) with score 1", () => {
    const stderr = `[Parsed_showinfo_1 @ 0x7f8] n:   0 pts:  61440 pts_time:4.8      duration:  512 duration_time:0.04   fmt:yuv420p
[Parsed_showinfo_1 @ 0x7f8] n:   1 pts: 122880 pts_time:9.6      duration:  512 duration_time:0.04   fmt:yuv420p
`;
    expect(parseSceneChanges(stderr)).toEqual([
      { time: 4.8, score: 1 },
      { time: 9.6, score: 1 },
    ]);
  });

  it("keeps the real score when metadata and showinfo print the same frame", () => {
    const stderr = `[Parsed_metadata_2 @ 0x1] frame:0    pts:100   pts_time:2.5
[Parsed_metadata_2 @ 0x1] lavfi.scene_score=0.61
[Parsed_showinfo_3 @ 0x2] n:   0 pts:    100 pts_time:2.5      duration:  1 fmt:yuv420p
`;
    expect(parseSceneChanges(stderr)).toEqual([{ time: 2.5, score: 0.61 }]);
  });

  it("scales scdet's 0–100 score", () => {
    const stderr =
      "[scdet @ 0x7f] lavfi.scd.score: 34.5, lavfi.scd.time: 12.5\n[scdet @ 0x7f] lavfi.scd.score: 8.2, lavfi.scd.time: 20\n";
    expect(parseSceneChanges(stderr)).toEqual([
      { time: 12.5, score: 0.345 },
      { time: 20, score: 0.082 },
    ]);
  });
});

describe("parseBlackdetect", () => {
  it("reads black ranges and drops zero-length ones", () => {
    const stderr = `[blackdetect @ 0x6000] black_start:0 black_end:1.2 black_duration:1.2
[blackdetect @ 0x6000] black_start:55.04 black_end:57.5 black_duration:2.46
[blackdetect @ 0x6000] black_start:70 black_end:70 black_duration:0
`;
    expect(parseBlackdetect(stderr)).toEqual([
      { start: 0, end: 1.2 },
      { start: 55.04, end: 57.5 },
    ]);
  });
});

describe("parseFreezedetect", () => {
  it("reads start, duration and end lines", () => {
    const stderr = `[freezedetect @ 0x1] lavfi.freezedetect.freeze_start: 10.5
[freezedetect @ 0x1] lavfi.freezedetect.freeze_duration: 3
[freezedetect @ 0x1] lavfi.freezedetect.freeze_end: 13.5
[freezedetect @ 0x1] lavfi.freezedetect.freeze_start: 40
[freezedetect @ 0x1] lavfi.freezedetect.freeze_duration: 2.5
[freezedetect @ 0x1] lavfi.freezedetect.freeze_end: 42.5
`;
    expect(parseFreezedetect(stderr, 100)).toEqual([
      { start: 10.5, end: 13.5 },
      { start: 40, end: 42.5 },
    ]);
  });

  it("ends a freeze that lasts until the media ends at the duration", () => {
    const stderr = "[freezedetect @ 0x1] lavfi.freezedetect.freeze_start: 95.2\n";
    expect(parseFreezedetect(stderr, 100)).toEqual([{ start: 95.2, end: 100 }]);
  });

  it("works on stderr that combines several filters", () => {
    const stderr = `[blackdetect @ 0x1] black_start:1 black_end:2 black_duration:1
[freezedetect @ 0x2] lavfi.freezedetect.freeze_start: 5
[freezedetect @ 0x2] lavfi.freezedetect.freeze_end: 8
`;
    expect(parseBlackdetect(stderr)).toEqual([{ start: 1, end: 2 }]);
    expect(parseFreezedetect(stderr, 10)).toEqual([{ start: 5, end: 8 }]);
  });
});
