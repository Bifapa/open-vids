import { describe, expect, it } from "vitest";
import {
  COMPOSITION_FRAME_LIMITS,
  isCompositionFramesResponse,
  parseCompositionFramesRequest,
} from "./frames.js";

describe("parseCompositionFramesRequest", () => {
  it("accepts times, a composition and a width, collapsing duplicate times at millisecond precision", () => {
    expect(
      parseCompositionFramesRequest({
        times: [1, 2.0004, 2, 3.5],
        composition: "compositions/a.html",
        width: 320,
      }),
    ).toEqual({
      ok: true,
      value: { composition: "compositions/a.html", times: [1, 2, 3.5], width: 320 },
    });
    expect(parseCompositionFramesRequest({ times: [0] })).toEqual({
      ok: true,
      value: { times: [0] },
    });
  });

  it.each([
    ["a non-object", null],
    ["no times", {}],
    ["empty times", { times: [] }],
    [
      "too many times",
      { times: Array.from({ length: COMPOSITION_FRAME_LIMITS.times + 1 }, (_, i) => i) },
    ],
    ["a negative time", { times: [-1] }],
    ["a non-number time", { times: ["1"] }],
    ["a tiny width", { times: [1], width: COMPOSITION_FRAME_LIMITS.minWidth - 1 }],
    ["a fractional width", { times: [1], width: 640.5 }],
    ["a blank composition", { times: [1], composition: " " }],
    ["an unknown field", { times: [1], format: "png" }],
  ])("refuses %s as invalid_request", (_name, body) => {
    const parsed = parseCompositionFramesRequest(body);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.error.code).toBe("invalid_request");
  });
});

describe("isCompositionFramesResponse", () => {
  const frame = {
    time: 1,
    capturedAt: 1,
    mimeType: "image/jpeg",
    data: "AAAA",
    width: 640,
    height: 360,
    cached: false,
  };

  it("checks the fields the runtime relies on", () => {
    expect(
      isCompositionFramesResponse({ composition: "index.html", duration: 4, frames: [frame] }),
    ).toBe(true);
    expect(
      isCompositionFramesResponse({
        composition: "index.html",
        duration: 4,
        frames: [{ ...frame, data: 1 }],
      }),
    ).toBe(false);
    expect(isCompositionFramesResponse({ composition: "index.html", frames: [] })).toBe(false);
  });
});
