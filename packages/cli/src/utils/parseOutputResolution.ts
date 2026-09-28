/**
 * Shared `--output-resolution` / `--resolution` normalizer for the local
 * `hyperframes render` command.
 *
 * The one field this helper carries is `outputResolutionAspectAgnostic`:
 * `true` when the raw flag was a tier-only alias (`1080p` / `hd` / `4k` /
 * `uhd`). Passing it through lets the compile stage remap `landscape` →
 * `portrait` when the composition demands it.
 *
 * The strict-throw contract (unknown values raise instead of silently
 * degrading to `outputResolution: undefined`) is preserved so a typo like
 * `--output-resolution 8k` fails fast rather than falling back to
 * composition dimensions.
 */

import { type CanvasResolution, resolveResolutionFlagPair } from "@hyperframes/core";
import { VALID_CANVAS_RESOLUTIONS } from "@hyperframes/core";

/**
 * Free-text prefix the thrown error is scoped to (e.g. `"[render]"`).
 * Kept as a caller-supplied string rather than a fixed enum so future
 * surfaces (Studio Server, an SDK wrapper, …) can opt in without editing
 * this file.
 */
export interface OutputResolutionParseOptions {
  surfaceLabel: string;
  /**
   * Optional per-surface hint appended to the error message. Defaults to a
   * generic tier-alias hint; pass a custom hint to keep the error text
   * faithful when a surface exposes additional orientation-suffixed aliases
   * (`1080p-portrait`, `4k-portrait`, …).
   */
  aliasHint?: string;
}

/**
 * Parse the user-supplied resolution flag into the pair the render
 * config needs. Returns `{ outputResolution: undefined,
 * outputResolutionAspectAgnostic: false }` when the flag is absent so the
 * caller can spread the result unconditionally.
 *
 * Throws (not exits) on an unknown value — CLI callers wrap that in their
 * own errorBox / process.exit; SDK callers surface the error to their own
 * user.
 */
export function parseOutputResolutionFlag(
  raw: unknown,
  options: OutputResolutionParseOptions,
): { outputResolution: CanvasResolution | undefined; outputResolutionAspectAgnostic: boolean } {
  if (raw == null || raw === "") {
    return { outputResolution: undefined, outputResolutionAspectAgnostic: false };
  }
  const asString = String(raw);
  const { outputResolution, outputResolutionAspectAgnostic } = resolveResolutionFlagPair(asString);
  if (outputResolution) return { outputResolution, outputResolutionAspectAgnostic };
  const aliasHint = options.aliasHint ?? "1080p, 4k, uhd, hd, …";
  throw new Error(
    `${options.surfaceLabel} --output-resolution must be one of ${VALID_CANVAS_RESOLUTIONS.join("|")} ` +
      `(or an alias: ${aliasHint}); got ${asString}`,
  );
}
