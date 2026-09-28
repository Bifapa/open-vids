/**
 * Plan-time validators for the local render pipeline. Each validator
 * is invoked before capture, so banned configurations fail fast
 * with a typed error instead of surfacing mid-render.
 */

import {
  collectFontFamilyCustomProperties,
  GENERIC_FAMILIES,
  iterateFontFamilyDeclarations,
  resolveFontFamilyDeclarationFamilies,
} from "../deterministicFonts.js";

/**
 * Typed plan-validation error. Callers match retry policy off the
 * `code` field.
 */
export class PlanValidationError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "PlanValidationError";
    this.code = code;
  }
}

/**
 * Typed code for {@link validateNoSystemFonts}. Renders run in a Linux container without host-OS fonts; compositions declaring
 * `-apple-system` / `system-ui` as a primary family would render differently
 * on the worker, breaking byte-identical retries.
 */
export const SYSTEM_FONT_USED = "SYSTEM_FONT_USED";

/** Typed code for invalid duration metadata resolved by the shared browser probe. */
export const RENDER_DURATION_OUT_OF_RANGE = "RENDER_DURATION_OUT_OF_RANGE";

/** All render paths are operationally bounded to one day of output. */
export const MAX_RENDER_DURATION_SECONDS = 24 * 60 * 60;

/**
 * Reject a compiled HTML document whose top-priority font-family resolves to
 * a host-OS / generic family. Throws {@link PlanValidationError} with
 * `code === SYSTEM_FONT_USED` and the offending family in the message.
 *
 * Inspects the FIRST entry of each font-family declaration: that's the
 * family the browser tries to use. Subsequent entries are CSS fallbacks,
 * and a generic fallback is fine and conventional — so
 * `font-family: "Inter", -apple-system, sans-serif` passes and
 * `font-family: -apple-system, BlinkMacSystemFont, "Segoe UI"` fails.
 *
 * Reads font-family surfaces via `iterateFontFamilyDeclarations` so the
 * @font-face injector and this validator scan the same regions.
 */
export function validateNoSystemFonts(compiledHtml: string): void {
  const customProperties = collectFontFamilyCustomProperties(compiledHtml);
  for (const { surface, declaration } of iterateFontFamilyDeclarations(compiledHtml)) {
    const families = resolveFontFamilyDeclarationFamilies(declaration, customProperties);
    if (families.length === 0) continue;
    const primaryRaw = families[0]!;
    // A var() primary is checked as its resolved value or, when undefined, its
    // fallback, so `--font: system-ui` and `var(--font, system-ui)` both fail.
    if (!GENERIC_FAMILIES.has(primaryRaw.toLowerCase())) continue;
    throw new PlanValidationError(
      SYSTEM_FONT_USED,
      `[planValidation] Composition declares a host-OS / generic primary ${surface}: ` +
        `${JSON.stringify(primaryRaw)} (full declaration: ${JSON.stringify(declaration.trim())}). ` +
        `Distributed chunk workers render in a Linux container and cannot produce byte-identical ` +
        `output for fonts that resolve to host system installations. Use a deterministic web font ` +
        `(e.g. Inter, Montserrat, or another @fontsource family) as the primary family; generic ` +
        `names like "sans-serif" / "-apple-system" / "system-ui" are only allowed as fallbacks.`,
    );
  }
}

export function validateRenderDuration(input: {
  duration: number;
  totalFrames: number;
  fps: number;
}): void {
  const { duration, totalFrames, fps } = input;
  const maxFrames = Math.ceil(MAX_RENDER_DURATION_SECONDS * fps);
  if (
    Number.isFinite(duration) &&
    duration > 0 &&
    Number.isFinite(fps) &&
    fps > 0 &&
    Number.isSafeInteger(totalFrames) &&
    totalFrames > 0 &&
    totalFrames <= maxFrames
  ) {
    return;
  }

  throw new PlanValidationError(
    RENDER_DURATION_OUT_OF_RANGE,
    `[planValidation] Render duration is out of range: ` +
      `duration=${String(duration)}s totalFrames=${String(totalFrames)} fps=${String(fps)} ` +
      `(maxDuration=${String(MAX_RENDER_DURATION_SECONDS)}s, maxFrames=${String(maxFrames)}). ` +
      `This usually means an unbounded timeline escaped into render planning, such as ` +
      `GSAP repeat:-1 / yoyo loops without an explicit finite root duration. Add a finite ` +
      `data-duration or replace infinite repeats with a finite repeat count before rendering.`,
  );
}
