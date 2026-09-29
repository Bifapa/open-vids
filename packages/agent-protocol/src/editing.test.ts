import { describe, expect, it } from "vitest";
import { EDIT_LIMITS, isEditError, parseApplyEditsRequest } from "./index.js";

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
      ],
    });
    if (!parsed.ok) throw new Error(parsed.error.message);
    expect(parsed.value.operations).toHaveLength(11);
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

describe("isEditError", () => {
  it("recognises the wire error and nothing else", () => {
    expect(isEditError({ code: "conflict", message: "stale" })).toBe(true);
    expect(isEditError({ code: "made_up", message: "x" })).toBe(false);
    expect(isEditError({ code: "conflict" })).toBe(false);
    expect(isEditError("conflict")).toBe(false);
  });
});
