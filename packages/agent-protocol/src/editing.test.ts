import { describe, expect, it } from "vitest";
import {
  EDIT_LIMITS,
  isEditError,
  parseApplyEditsRequest,
  parseSetAssetRangeRequest,
} from "./index.js";

function refused(body: unknown) {
  const parsed = parseApplyEditsRequest(body);
  if (parsed.ok) throw new Error("expected the request to be refused");
  return parsed.error;
}

describe("parseApplyEditsRequest", () => {
  it("accepts every operation and keeps only what was sent", () => {
    const parsed = parseApplyEditsRequest({
      composition: "index.html",
      baseVersion: '"sha256:x"',
      operations: [
        { op: "add_clip", asset: "assets/a.mp4", start: 0, track: 1, fit: "cover", muted: true },
        { op: "add_text", text: "Hi", start: 1, duration: 2, track: 3, color: "#fff" },
        { op: "add_component", name: "pop", start: 0, track: 4 },
        { op: "apply_captions", preset: "coral", cues: [{ text: "a b", start: 0, end: 1 }] },
        { op: "remove_clip", clip: "c1", ripple: true },
        { op: "move_clip", clip: "c1", track: 2 },
        { op: "trim_clip", clip: "c1", end: 3 },
        { op: "split_clip", clip: "c1", at: 1.5 },
        { op: "set_clip", clip: "c1", zIndex: -3 },
        { op: "arrange_track", track: 1, clips: ["a", "b"], gap: 0 },
        { op: "set_composition", duration: 12 },
        { op: "set_canvas", width: 1080, height: 1920 },
      ],
    });
    if (!parsed.ok) throw new Error(parsed.error.message);
    expect(parsed.value.operations).toHaveLength(12);
    expect(parsed.value.operations[0]).toEqual({
      op: "add_clip",
      asset: "assets/a.mp4",
      start: 0,
      track: 1,
      fit: "cover",
      muted: true,
    });
    expect(parsed.value.operations[5]).toEqual({ op: "move_clip", clip: "c1", track: 2 });
  });

  it.each([
    ["a non-object body", null],
    ["missing operations", {}],
    ["an empty batch", { operations: [] }],
    [
      "an unknown top-level field",
      { operations: [{ op: "set_composition", duration: 1 }], dry: true },
    ],
    [
      "an empty composition path",
      { composition: " ", operations: [{ op: "set_composition", duration: 1 }] },
    ],
  ])("refuses %s without an operation index", (_name, body) => {
    const error = refused(body);
    expect(error.code).toBe("invalid_request");
    expect(error.opIndex).toBeUndefined();
  });

  it.each([
    ["an operation that is not an object", 3],
    ["an unknown operation", { op: "explode" }],
    ["a misspelled option", { op: "add_clip", asset: "a.mp4", start: 0, track: 0, mediastart: 1 }],
    ["a missing required field", { op: "add_clip", asset: "a.mp4", track: 0 }],
    ["a string time", { op: "split_clip", clip: "a", at: "2" }],
    ["NaN as a time", { op: "split_clip", clip: "a", at: Number.NaN }],
    ["a negative start", { op: "add_clip", asset: "a.mp4", start: -0.1, track: 0 }],
    ["a zero duration", { op: "add_text", text: "x", start: 0, duration: 0, track: 0 }],
    ["a time past the limit", { op: "set_composition", duration: EDIT_LIMITS.maxTime + 1 }],
    ["a fractional track", { op: "add_clip", asset: "a.mp4", start: 0, track: 0.5 }],
    ["a track past the limit", { op: "add_clip", asset: "a.mp4", start: 0, track: 1000 }],
    ["a volume above the limit", { op: "set_clip", clip: "a", volume: 3.99 }],
    ["a negative fade", { op: "set_clip", clip: "a", fadeIn: -1 }],
    ["a string fade", { op: "add_clip", asset: "a.mp4", start: 0, track: 0, fadeOut: "1" }],
    ["an unknown fit", { op: "set_clip", clip: "a", fit: "stretch" }],
    ["a non-boolean muted", { op: "set_clip", clip: "a", muted: "yes" }],
    ["a frame without a size", { op: "set_clip", clip: "a", frame: { x: 0, y: 0 } }],
    [
      "a frame with zero width",
      {
        op: "add_clip",
        asset: "a.png",
        start: 0,
        track: 1,
        frame: { x: 0, y: 0, width: 0, height: 9 },
      },
    ],
    [
      "a frame with an unknown key",
      { op: "set_clip", clip: "a", frame: { x: 0, y: 0, width: 9, height: 9, z: 1 } },
    ],
    ["a blank clip id", { op: "remove_clip", clip: "  " }],
    ["a move that names nothing to change", { op: "move_clip", clip: "a" }],
    ["a trim that names nothing to change", { op: "trim_clip", clip: "a" }],
    ["a trim that ends before it starts", { op: "trim_clip", clip: "a", start: 5, end: 4 }],
    ["a set_clip with no property", { op: "set_clip", clip: "a" }],
    [
      "an unsafe text colour",
      { op: "add_text", text: "x", start: 0, duration: 1, track: 0, color: "red;}" },
    ],
    [
      "text over the character limit",
      {
        op: "add_text",
        text: "x".repeat(EDIT_LIMITS.textChars + 1),
        start: 0,
        duration: 1,
        track: 0,
      },
    ],
    [
      "a cue that ends before it starts",
      { op: "apply_captions", preset: "p", cues: [{ text: "x", start: 2, end: 2 }] },
    ],
    ["no cues", { op: "apply_captions", preset: "p", cues: [] }],
    ["arrange_track repeating a clip", { op: "arrange_track", track: 0, clips: ["a", "a"] }],
    ["arrange_track with no clips", { op: "arrange_track", track: 0, clips: [] }],
    ["an odd canvas side", { op: "set_canvas", width: 1081, height: 1920 }],
    ["a zero canvas side", { op: "set_canvas", width: 1080, height: 0 }],
    ["a fractional canvas side", { op: "set_canvas", width: 1080.5, height: 1920 }],
    ["a string canvas side", { op: "set_canvas", width: "1080", height: 1920 }],
    [
      "a canvas side past the limit",
      { op: "set_canvas", width: EDIT_LIMITS.maxCanvasPixels + 2, height: 1080 },
    ],
    ["a set_canvas with a missing side", { op: "set_canvas", width: 1080 }],
  ])("refuses %s at the operation's index", (_name, operation) => {
    const error = refused({
      operations: [{ op: "set_composition", duration: 1 }, operation],
    });
    expect(error.code).toBe("invalid_request");
    expect(error.opIndex).toBe(1);
  });

  it("accepts fades and the maximum volume", () => {
    const parsed = parseApplyEditsRequest({
      operations: [
        {
          op: "add_clip",
          asset: "a.mp4",
          start: 0,
          track: 0,
          fadeIn: 0.5,
          fadeOut: 0,
          volume: 3.98,
        },
        { op: "set_clip", clip: "c", fadeOut: 1 },
        { op: "set_clip", clip: "d", frame: { x: -20, y: 40.5, width: 380, height: 200 } },
      ],
    });
    if (!parsed.ok) throw new Error(parsed.error.message);
    expect(parsed.value.operations).toEqual([
      { op: "add_clip", asset: "a.mp4", start: 0, track: 0, volume: 3.98, fadeIn: 0.5, fadeOut: 0 },
      { op: "set_clip", clip: "c", fadeOut: 1 },
      { op: "set_clip", clip: "d", frame: { x: -20, y: 40.5, width: 380, height: 200 } },
    ]);
  });

  it("enforces the batch and cue count limits", () => {
    const tooMany = Array.from({ length: EDIT_LIMITS.operations + 1 }, () => ({
      op: "set_composition",
      duration: 1,
    }));
    expect(refused({ operations: tooMany }).message).toContain(String(EDIT_LIMITS.operations));
    const cues = Array.from({ length: EDIT_LIMITS.captionCues + 1 }, (_, index) => ({
      text: "w",
      start: index,
      end: index + 1,
    }));
    expect(refused({ operations: [{ op: "apply_captions", preset: "p", cues }] }).opIndex).toBe(0);
    const atLimit = parseApplyEditsRequest({
      operations: [
        { op: "apply_captions", preset: "p", cues: cues.slice(0, EDIT_LIMITS.captionCues) },
      ],
    });
    expect(atLimit.ok).toBe(true);
  });
});

describe("remove_clip with clips", () => {
  it("keeps the ids and ripple, and still accepts a single clip", () => {
    const parsed = parseApplyEditsRequest({
      operations: [
        { op: "remove_clip", clips: ["a", "b", "c"], ripple: true },
        { op: "remove_clip", clip: "d" },
      ],
    });
    if (!parsed.ok) throw new Error(parsed.error.message);
    expect(parsed.value.operations).toEqual([
      { op: "remove_clip", clips: ["a", "b", "c"], ripple: true },
      { op: "remove_clip", clip: "d" },
    ]);
  });

  it.each([
    ["neither clip nor clips", { op: "remove_clip" }],
    ["both clip and clips", { op: "remove_clip", clip: "a", clips: ["b"] }],
    ["an empty list", { op: "remove_clip", clips: [] }],
    ["a list that is not an array", { op: "remove_clip", clips: "a" }],
    ["a blank id in the list", { op: "remove_clip", clips: ["a", " "] }],
    ["a repeated clip", { op: "remove_clip", clips: ["a", "a"] }],
  ])("refuses %s at the operation's index", (_name, operation) => {
    const error = refused({ operations: [{ op: "set_composition", duration: 1 }, operation] });
    expect(error.code).toBe("invalid_request");
    expect(error.opIndex).toBe(1);
  });

  it("accepts exactly the limit and refuses one more", () => {
    const ids = (count: number) => Array.from({ length: count }, (_, index) => `clip-${index}`);
    expect(
      parseApplyEditsRequest({
        operations: [{ op: "remove_clip", clips: ids(EDIT_LIMITS.removeClips) }],
      }).ok,
    ).toBe(true);
    expect(
      refused({ operations: [{ op: "remove_clip", clips: ids(EDIT_LIMITS.removeClips + 1) }] })
        .message,
    ).toContain(String(EDIT_LIMITS.removeClips));
  });
});

describe("add_sequence parsing", () => {
  const sequence = (extra: Record<string, unknown> = {}) => ({
    op: "add_sequence",
    asset: "assets/talk.mp4",
    track: 0,
    ranges: [{ from: 1, to: 2.5 }],
    ...extra,
  });

  it("keeps the ranges, defaults and options it was sent", () => {
    const parsed = parseApplyEditsRequest({
      operations: [
        sequence({
          start: 4,
          ranges: [
            { from: 0, to: 3 },
            { from: 10, to: 12.5 },
          ],
          volume: 0.8,
          muted: false,
          fit: "cover",
          frame: { x: 0, y: 0, width: 640, height: 360 },
          edgeFade: EDIT_LIMITS.maxEdgeFade,
        }),
      ],
    });
    if (!parsed.ok) throw new Error(parsed.error.message);
    expect(parsed.value.operations).toEqual([
      {
        op: "add_sequence",
        asset: "assets/talk.mp4",
        track: 0,
        start: 4,
        ranges: [
          { from: 0, to: 3 },
          { from: 10, to: 12.5 },
        ],
        volume: 0.8,
        muted: false,
        fit: "cover",
        frame: { x: 0, y: 0, width: 640, height: 360 },
        edgeFade: EDIT_LIMITS.maxEdgeFade,
      },
    ]);
  });

  it.each([
    ["no ranges", sequence({ ranges: [] })],
    ["ranges that are not an array", sequence({ ranges: { from: 0, to: 1 } })],
    ["a range that ends where it starts", sequence({ ranges: [{ from: 2, to: 2 }] })],
    ["a range that ends before it starts", sequence({ ranges: [{ from: 3, to: 2 }] })],
    ["a negative in-point", sequence({ ranges: [{ from: -1, to: 2 }] })],
    ["a non-finite out-point", sequence({ ranges: [{ from: 0, to: Number.POSITIVE_INFINITY }] })],
    ["a string in-point", sequence({ ranges: [{ from: "0", to: 1 }] })],
    [
      "a range past the time limit",
      sequence({ ranges: [{ from: 0, to: EDIT_LIMITS.maxTime + 1 }] }),
    ],
    ["a range with an unknown field", sequence({ ranges: [{ from: 0, to: 1, label: "intro" }] })],
    ["a range that is not an object", sequence({ ranges: [[0, 1]] })],
    ["a missing track", { op: "add_sequence", asset: "a.mp4", ranges: [{ from: 0, to: 1 }] }],
    ["an unknown field", sequence({ mediaStart: 3 })],
    ["an edgeFade above the limit", sequence({ edgeFade: EDIT_LIMITS.maxEdgeFade + 0.01 })],
    ["a negative edgeFade", sequence({ edgeFade: -0.01 })],
    ["a string edgeFade", sequence({ edgeFade: "0.02" })],
    ["a volume above the limit", sequence({ volume: 4 })],
    ["a negative start", sequence({ start: -1 })],
    ["an unknown fit", sequence({ fit: "stretch" })],
    ["a frame without a size", sequence({ frame: { x: 0, y: 0 } })],
  ])("refuses %s at the operation's index", (_name, operation) => {
    const error = refused({ operations: [{ op: "set_composition", duration: 1 }, operation] });
    expect(error.code).toBe("invalid_request");
    expect(error.opIndex).toBe(1);
  });

  it("names the range that is wrong", () => {
    const error = refused({
      operations: [
        sequence({
          ranges: [
            { from: 0, to: 1 },
            { from: 1, to: 2 },
            { from: 5, to: 4 },
          ],
        }),
      ],
    });
    expect(error.message).toContain("ranges[2]");
  });

  it("accepts exactly the range limit and refuses one more", () => {
    const ranges = (count: number) =>
      Array.from({ length: count }, (_, index) => ({ from: index, to: index + 0.5 }));
    const atLimit = parseApplyEditsRequest({
      operations: [sequence({ ranges: ranges(EDIT_LIMITS.sequenceRanges) })],
    });
    expect(atLimit.ok).toBe(true);
    const error = refused({
      operations: [sequence({ ranges: ranges(EDIT_LIMITS.sequenceRanges + 1) })],
    });
    expect(error.message).toContain(String(EDIT_LIMITS.sequenceRanges));
    expect(error.opIndex).toBe(0);
  });
});

describe("provenance on add operations", () => {
  const provenance = { storyNode: "chapter-a1", cut: "cut-2", turn: "turn-9" };

  it("is accepted on add_clip, add_sequence, add_text and add_component and kept as sent", () => {
    const parsed = parseApplyEditsRequest({
      operations: [
        { op: "add_clip", asset: "a.mp4", start: 0, track: 1, provenance },
        {
          op: "add_sequence",
          asset: "a.mp4",
          track: 1,
          ranges: [{ from: 0, to: 1 }],
          provenance: { cut: "cut-2" },
        },
        { op: "add_text", text: "Hi", start: 0, duration: 1, track: 2, provenance: { turn: "t" } },
        { op: "add_component", name: "pop", start: 0, track: 3, provenance: { storyNode: "n" } },
      ],
    });
    if (!parsed.ok) throw new Error(parsed.error.message);
    expect(
      parsed.value.operations.map((op) => ("provenance" in op ? op.provenance : undefined)),
    ).toEqual([provenance, { cut: "cut-2" }, { turn: "t" }, { storyNode: "n" }]);
  });

  it("refuses ids that could not be written safely as an attribute, unknown keys and empty stamps", () => {
    const add = (stamp: unknown) => ({
      operations: [{ op: "add_clip", asset: "a.mp4", start: 0, track: 1, provenance: stamp }],
    });
    expect(refused(add({ turn: 'x" onload="y' })).message).toContain("provenance.turn");
    expect(refused(add({ story: "n" })).message).toContain("unknown field");
    expect(refused(add({})).message).toContain("must set");
    expect(refused(add("chapter-1")).message).toContain("must be an object");
    expect(refused({ operations: [{ op: "set_clip", clip: "c", provenance }] }).message).toContain(
      "unknown field",
    );
  });
});

describe("isEditError", () => {
  it("recognises the wire error and nothing else", () => {
    expect(isEditError({ code: "conflict", message: "stale" })).toBe(true);
    expect(isEditError({ code: "made_up", message: "x" })).toBe(false);
    expect(isEditError({ code: "conflict" })).toBe(false);
    expect(isEditError("conflict")).toBe(false);
  });
});

describe("parseSetAssetRangeRequest", () => {
  it("accepts a minimum-length pick that differs from 0.1 s only by float error and refuses shorter ones", () => {
    for (const range of [
      { start: 1.1, end: 1.2 },
      { start: 10, end: 10.1 },
      { start: 99.9, end: 100 },
    ]) {
      expect(parseSetAssetRangeRequest({ path: "assets/a.mp4", range }).ok).toBe(true);
    }
    expect(
      parseSetAssetRangeRequest({ path: "assets/a.mp4", range: { start: 1, end: 1.09 } }).ok,
    ).toBe(false);
  });
});

describe("parseApplyEditsRequest: the newer operations and options", () => {
  const ok = (operation: unknown) => {
    const parsed = parseApplyEditsRequest({ operations: [operation] });
    if (!parsed.ok) throw new Error(parsed.error.message);
    return parsed.value.operations[0];
  };
  const bad = (operation: unknown) => refused({ operations: [operation] }).message;

  it("keeps exactly what was sent for each new operation", () => {
    expect(ok({ op: "set_speed", clip: "c", rate: 2, ripple: true, rippleScope: "all" })).toEqual({
      op: "set_speed",
      clip: "c",
      rate: 2,
      ripple: true,
      rippleScope: "all",
    });
    expect(ok({ op: "retime_captions", shift: -1.5, from: 10 })).toEqual({
      op: "retime_captions",
      shift: -1.5,
      from: 10,
    });
    expect(ok({ op: "captions_from_transcript", preset: "coral", maxWords: 4 })).toEqual({
      op: "captions_from_transcript",
      preset: "coral",
      maxWords: 4,
    });
    expect(
      ok({ op: "mount_composition", composition: "compositions/x.html", start: 1, track: 2 }),
    ).toEqual({ op: "mount_composition", composition: "compositions/x.html", start: 1, track: 2 });
    expect(
      ok({ op: "set_color_grade", clip: "c", preset: "warm-daylight", adjust: { exposure: 1.5 } }),
    ).toEqual({
      op: "set_color_grade",
      clip: "c",
      preset: "warm-daylight",
      adjust: { exposure: 1.5 },
    });
    expect(ok({ op: "set_audio_fx", clip: "c", clear: true })).toEqual({
      op: "set_audio_fx",
      clip: "c",
      clear: true,
    });
    expect(ok({ op: "set_volume_automation", clip: "c", points: [{ t: 0, v: 1 }] })).toEqual({
      op: "set_volume_automation",
      clip: "c",
      points: [{ t: 0, v: 1 }],
    });
    expect(ok({ op: "duck_audio", clip: "m", underTrack: 0, reduceDb: 12 })).toEqual({
      op: "duck_audio",
      clip: "m",
      underTrack: 0,
      reduceDb: 12,
    });
    expect(ok({ op: "set_locked", clips: ["a", "b"], locked: true })).toEqual({
      op: "set_locked",
      clips: ["a", "b"],
      locked: true,
    });
    expect(ok({ op: "set_canvas", width: 1080, height: 1920, fit: "contain" })).toEqual({
      op: "set_canvas",
      width: 1080,
      height: 1920,
      fit: "contain",
    });
    expect(ok({ op: "set_clip", clip: "c", opacity: 0.5 })).toEqual({
      op: "set_clip",
      clip: "c",
      opacity: 0.5,
    });
  });

  it.each([
    ["a rate below the engine minimum", { op: "set_speed", clip: "c", rate: 0.05 }],
    ["a rate above the engine maximum", { op: "set_speed", clip: "c", rate: 11 }],
    ["a rippleScope without ripple", { op: "remove_clip", clip: "c", rippleScope: "all" }],
    ["a retime without shift or scale", { op: "retime_captions", from: 1 }],
    ["an unknown adjust key", { op: "set_color_grade", clip: "c", adjust: { glow: 1 } }],
    ["an adjust value out of range", { op: "set_color_grade", clip: "c", adjust: { tint: 2 } }],
    ["an empty colour grade", { op: "set_color_grade", clip: "c" }],
    [
      "clear together with a preset",
      { op: "set_color_grade", clip: "c", preset: "a", clear: true },
    ],
    ["fx with neither preset nor clear", { op: "set_audio_fx", clip: "c" }],
    [
      "automation with both points and clear",
      { op: "set_volume_automation", clip: "c", clear: true, points: [{ t: 0, v: 1 }] },
    ],
    [
      "automation volume above the ceiling",
      { op: "set_volume_automation", clip: "c", points: [{ t: 0, v: 9 }] },
    ],
    ["ducking under nothing", { op: "duck_audio", clip: "m" }],
    [
      "ducking under both a list and a track",
      { op: "duck_audio", clip: "m", under: ["a"], underTrack: 0 },
    ],
    ["locking without a boolean", { op: "set_locked", clips: ["a"], locked: "yes" }],
    ["an unknown canvas fit", { op: "set_canvas", width: 2, height: 2, fit: "stretch" }],
  ])("refuses %s", (_name, operation) => {
    expect(refused({ operations: [operation] }).opIndex).toBe(0);
    expect(bad(operation).length).toBeGreaterThan(0);
  });

  it("reads requestId and dryRun and refuses a malformed one", () => {
    const parsed = parseApplyEditsRequest({
      requestId: "r-1:abc",
      dryRun: true,
      operations: [{ op: "set_composition", duration: 1 }],
    });
    expect(parsed.ok && parsed.value.requestId).toBe("r-1:abc");
    expect(parsed.ok && parsed.value.dryRun).toBe(true);
    expect(
      refused({ requestId: "bad id", operations: [{ op: "set_composition", duration: 1 }] })
        .message,
    ).toContain("requestId");
    expect(
      refused({ dryRun: "yes", operations: [{ op: "set_composition", duration: 1 }] }).message,
    ).toContain("dryRun");
  });

  it("allows the larger batch", () => {
    const operations = Array.from({ length: EDIT_LIMITS.operations }, () => ({
      op: "set_composition",
      duration: 1,
    }));
    expect(parseApplyEditsRequest({ operations }).ok).toBe(true);
  });
});
