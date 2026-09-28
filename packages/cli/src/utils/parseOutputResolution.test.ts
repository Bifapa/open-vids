/**
 * Boundary tests for the shared `parseOutputResolutionFlag` helper used by
 * `hyperframes render`.
 */

import { describe, expect, it } from "vitest";
import { parseOutputResolutionFlag } from "./parseOutputResolution.js";

const RENDER = { surfaceLabel: "[render]" } as const;

describe("parseOutputResolutionFlag", () => {
  it.each([undefined, "", null])(
    "returns undefined + false when the flag is omitted (raw=%s)",
    (raw) => {
      expect(parseOutputResolutionFlag(raw, RENDER)).toEqual({
        outputResolution: undefined,
        outputResolutionAspectAgnostic: false,
      });
    },
  );

  it.each(["landscape", "portrait-4k", "square", "square-4k"])(
    "normalizes canonical preset %s with aspect-agnostic=false",
    (preset) => {
      const { outputResolution, outputResolutionAspectAgnostic } = parseOutputResolutionFlag(
        preset,
        RENDER,
      );
      expect(outputResolution).toBe(preset);
      expect(outputResolutionAspectAgnostic).toBe(false);
    },
  );

  // Without this pair, a portrait composition with `--output-resolution
  // 1080p` reaches the compile stage as the explicit `landscape` preset
  // and rejects with an aspect-mismatch instead of remapping to `portrait`.
  it.each(["1080p", "hd", "4k", "uhd"])(
    "flags aspect-agnostic tier alias %s so the compile stage can remap orientation",
    (alias) => {
      const { outputResolution, outputResolutionAspectAgnostic } = parseOutputResolutionFlag(
        alias,
        RENDER,
      );
      expect(outputResolutionAspectAgnostic).toBe(true);
      expect(outputResolution).toBeDefined();
    },
  );

  it.each(["1080p-portrait", "portrait-1080p", "1080p-square", "4k-portrait", "4k-square"])(
    "does NOT flag orientation-suffixed alias %s as aspect-agnostic",
    (alias) => {
      // The user picked an orientation — respect it, don't silently swap.
      const { outputResolutionAspectAgnostic } = parseOutputResolutionFlag(alias, RENDER);
      expect(outputResolutionAspectAgnostic).toBe(false);
    },
  );

  it("treats input case-insensitively (1080P, UHD, HD, 4K all pass)", () => {
    for (const alias of ["1080P", "UHD", "HD", "4K"]) {
      expect(parseOutputResolutionFlag(alias, RENDER).outputResolutionAspectAgnostic).toBe(true);
    }
  });

  it("throws with the caller-supplied surface label on unknown values", () => {
    expect(() => parseOutputResolutionFlag("8k", RENDER)).toThrow(/\[render\]/);
  });

  it("appends the caller-supplied aliasHint to the error text (so the message stays surface-accurate)", () => {
    const err = getThrown(() =>
      parseOutputResolutionFlag("8k", {
        surfaceLabel: "[render]",
        aliasHint: "1080p, 4k, uhd, hd, 1080p-portrait, portrait-1080p, 4k-portrait",
      }),
    );
    expect(err.message).toContain("1080p-portrait");
    expect(err.message).toContain("4k-portrait");
  });
});

function getThrown(fn: () => void): Error {
  try {
    fn();
  } catch (e) {
    if (e instanceof Error) return e;
    throw new Error(`Non-Error thrown: ${String(e)}`);
  }
  throw new Error("Expected fn to throw, but it did not");
}
