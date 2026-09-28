/**
 * Tests for plan-time validators. Each validator pins both branches:
 *
 *   - PASS — the config is acceptable; no throw.
 *   - FAIL — the config trips a banned rule; throws
 *     PlanValidationError with the expected typed `code`.
 */

import { describe, expect, it } from "bun:test";
import {
  MAX_RENDER_DURATION_SECONDS,
  PlanValidationError,
  RENDER_DURATION_OUT_OF_RANGE,
  SYSTEM_FONT_USED,
  validateRenderDuration,
  validateNoSystemFonts,
} from "./planValidation.js";
import { parseFontFamilyValue } from "../deterministicFonts.js";

describe("PlanValidationError", () => {
  it("preserves the typed `code` field", () => {
    const err = new PlanValidationError("EXAMPLE_CODE", "msg");
    expect(err.code).toBe("EXAMPLE_CODE");
    expect(err.message).toBe("msg");
    expect(err.name).toBe("PlanValidationError");
    expect(err).toBeInstanceOf(Error);
  });
});

describe("validateRenderDuration", () => {
  it("accepts a finite duration within the ceiling", () => {
    expect(() =>
      validateRenderDuration({
        duration: MAX_RENDER_DURATION_SECONDS,
        totalFrames: MAX_RENDER_DURATION_SECONDS * 30,
        fps: 30,
      }),
    ).not.toThrow();
  });

  it("throws RENDER_DURATION_OUT_OF_RANGE for the engine's infinite-timeline sentinel", () => {
    let caught: unknown;
    try {
      validateRenderDuration({
        duration: 10_000_000_000,
        totalFrames: 300_000_000_000,
        fps: 30,
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(PlanValidationError);
    expect((caught as PlanValidationError).code).toBe(RENDER_DURATION_OUT_OF_RANGE);
    expect((caught as Error).message).toContain("300000000000");
    expect((caught as Error).message).toContain("GSAP repeat:-1");
  });

  it("throws RENDER_DURATION_OUT_OF_RANGE for non-finite or zero values", () => {
    for (const input of [
      { duration: Number.POSITIVE_INFINITY, totalFrames: 1, fps: 30 },
      { duration: 0, totalFrames: 1, fps: 30 },
      { duration: 1, totalFrames: 0, fps: 30 },
      { duration: 1, totalFrames: 1, fps: Number.NaN },
    ]) {
      let caught: unknown;
      try {
        validateRenderDuration(input);
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(PlanValidationError);
      expect((caught as PlanValidationError).code).toBe(RENDER_DURATION_OUT_OF_RANGE);
    }
  });
});

describe("parseFontFamilyValue", () => {
  it("splits a comma-separated list and strips whitespace + quotes", () => {
    expect(parseFontFamilyValue(`"Inter", -apple-system, sans-serif`)).toEqual([
      "Inter",
      "-apple-system",
      "sans-serif",
    ]);
  });

  it("strips single quotes too", () => {
    expect(parseFontFamilyValue(`'My Custom Font', serif`)).toEqual(["My Custom Font", "serif"]);
  });

  it("keeps a comma inside a quoted family name", () => {
    expect(parseFontFamilyValue(`"Display, Condensed", serif`)).toEqual([
      "Display, Condensed",
      "serif",
    ]);
  });

  it("keeps a var() fallback in a single token", () => {
    expect(parseFontFamilyValue(`var(--brand-font, inherit), sans-serif`)).toEqual([
      "var(--brand-font, inherit)",
      "sans-serif",
    ]);
  });

  it("keeps a nested var() fallback in a single token", () => {
    expect(
      parseFontFamilyValue(`var(--brand-font, var(--fallback-font, "Inter")), sans-serif`),
    ).toEqual([`var(--brand-font, var(--fallback-font, "Inter"))`, "sans-serif"]);
  });

  it("ignores empty entries (trailing commas)", () => {
    expect(parseFontFamilyValue(`Inter,,sans-serif`)).toEqual(["Inter", "sans-serif"]);
  });

  it("handles a single value with no commas", () => {
    expect(parseFontFamilyValue(`"My Font"`)).toEqual(["My Font"]);
  });

  it("handles an all-whitespace value as empty", () => {
    expect(parseFontFamilyValue(`   `)).toEqual([]);
  });
});

describe("validateNoSystemFonts", () => {
  const CLEAN_HTML = `<!doctype html>
<html><head><style>
  body { font-family: "Inter", -apple-system, sans-serif; margin: 0; }
  h1 { font-family: "Montserrat", "Helvetica Neue", sans-serif; }
</style></head>
<body><h1 data-font-family="Outfit, sans-serif">Hello</h1></body>
</html>`;

  it("passes a composition with deterministic web fonts as primary", () => {
    expect(() => validateNoSystemFonts(CLEAN_HTML)).not.toThrow();
  });

  it("passes when font-family is absent entirely (plain text composition)", () => {
    expect(() =>
      validateNoSystemFonts(`<!doctype html><html><body><p>no fonts here</p></body></html>`),
    ).not.toThrow();
  });

  it("throws SYSTEM_FONT_USED when primary family is `-apple-system`", () => {
    const offending = `<style>body { font-family: -apple-system, BlinkMacSystemFont, sans-serif; }</style>`;
    let caught: unknown;
    try {
      validateNoSystemFonts(offending);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(PlanValidationError);
    expect((caught as PlanValidationError).code).toBe(SYSTEM_FONT_USED);
    expect((caught as PlanValidationError).code).toBe("SYSTEM_FONT_USED");
    expect((caught as Error).message).toContain(`"-apple-system"`);
    expect((caught as Error).message).toContain("font-family");
  });

  it("throws SYSTEM_FONT_USED when primary family is `system-ui`", () => {
    const offending = `<div style="font-family: system-ui, sans-serif">text</div>`;
    let caught: unknown;
    try {
      validateNoSystemFonts(offending);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(PlanValidationError);
    expect((caught as PlanValidationError).code).toBe(SYSTEM_FONT_USED);
    expect((caught as Error).message).toContain(`"system-ui"`);
  });

  it("throws SYSTEM_FONT_USED when primary family is `sans-serif` (CSS generic alone)", () => {
    const offending = `<style>.x { font-family: sans-serif; }</style>`;
    let caught: unknown;
    try {
      validateNoSystemFonts(offending);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(PlanValidationError);
    expect((caught as PlanValidationError).code).toBe(SYSTEM_FONT_USED);
    expect((caught as Error).message).toContain(`"sans-serif"`);
  });

  it("treats data-font-family= as a valid surface for the same check", () => {
    const offending = `<h1 data-font-family="ui-monospace, monospace">hi</h1>`;
    let caught: unknown;
    try {
      validateNoSystemFonts(offending);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(PlanValidationError);
    expect((caught as PlanValidationError).code).toBe(SYSTEM_FONT_USED);
    expect((caught as Error).message).toContain("data-font-family");
  });

  it("is case-insensitive (`SYSTEM-UI` is the same as `system-ui`)", () => {
    const offending = `<style>p { font-family: SYSTEM-UI, sans-serif; }</style>`;
    let caught: unknown;
    try {
      validateNoSystemFonts(offending);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(PlanValidationError);
    expect((caught as PlanValidationError).code).toBe(SYSTEM_FONT_USED);
  });

  it("accepts generic families when used only as fallbacks", () => {
    // The whole point: `font-family: "Inter", -apple-system, sans-serif` is
    // the canonical fallback chain. We want this to pass.
    const ok = `<style>body { font-family: "Inter", -apple-system, BlinkMacSystemFont, sans-serif; }</style>`;
    expect(() => validateNoSystemFonts(ok)).not.toThrow();
  });

  it("resolves simple CSS var() primary aliases before rejecting system fonts", () => {
    const offending = `<style>
      :root { --ui-font: -apple-system, BlinkMacSystemFont, sans-serif; }
      body { font-family: var(--ui-font), sans-serif; }
    </style>`;
    let caught: unknown;
    try {
      validateNoSystemFonts(offending);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(PlanValidationError);
    expect((caught as PlanValidationError).code).toBe(SYSTEM_FONT_USED);
    expect((caught as Error).message).toContain(`"-apple-system"`);
  });

  it("checks the fallback of an undefined CSS var() primary", () => {
    const offending = `<style>body { font-family: var(--ui-font, -apple-system, sans-serif); }</style>`;
    expect(() => validateNoSystemFonts(offending)).toThrow(`"-apple-system"`);
    const ok = `<style>body { font-family: var(--ui-font, "Inter", sans-serif); }</style>`;
    expect(() => validateNoSystemFonts(ok)).not.toThrow();
  });

  it.each(["serif", "system-ui"])("accepts var(--x,), %s, which the browser inherits", (rest) => {
    const html = `<style>body { font-family: var(--x,), ${rest}; }</style>`;
    expect(() => validateNoSystemFonts(html)).not.toThrow();
  });

  it("accepts CSS var() primary aliases that resolve to deterministic fonts", () => {
    const ok = `<style>
      :root { --ui-font: "Inter", -apple-system, sans-serif; }
      body { font-family: var(--ui-font), sans-serif; }
    </style>`;
    expect(() => validateNoSystemFonts(ok)).not.toThrow();
  });
});
