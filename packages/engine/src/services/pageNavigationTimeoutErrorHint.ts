/**
 * Augment Puppeteer `page.goto` navigation-timeout errors with actionable
 * guidance that names the HyperFrames-specific knobs. Puppeteer's stock error
 * text ("Navigation timeout of 60000 ms exceeded") doesn't tell the user
 * which env var / CLI flag raises this timeout in HyperFrames, or which
 * browser-binary override lets them route around a slow pinned build.
 *
 * Sibling of `augmentProtocolTimeoutError` (surfaces
 * `PRODUCER_PUPPETEER_PROTOCOL_TIMEOUT_MS` / `--protocol-timeout` on the
 * `Runtime.callFunctionOn timed out` class), and mirrors the surfacing
 * pattern from #2443 (which surfaces `HYPERFRAMES_BROWSER_PATH` on
 * download-time failures). This helper covers the runtime `page.goto` layer
 * instead:
 *
 *   1. Raise-the-timeout: `PRODUCER_PAGE_NAVIGATION_TIMEOUT_MS` env,
 *      `--browser-timeout` CLI flag (SECONDS, not ms).
 *   2. Escape-hatch browser binary: `HYPERFRAMES_BROWSER_PATH` env, points
 *      at a system Chrome / chrome-headless-shell path.
 *
 * A previous revision gated an extra container-render hint on the
 * darwin/arm64 + CSS-3D + audio compound (field signal ts=1784146416).
 * That compound hint was removed with the container render mode, so every
 * matching error now receives the same generic env/flag/browser-path
 * augmentation.
 *
 * Design is conservative — non-matching errors flow through unchanged (same
 * instance). Non-Error inputs are coerced with `new Error(String(err))` so
 * callers always receive a well-typed `Error`. Original error preserved via
 * `err.cause` for downstream logging / observability.
 */

const NAVIGATION_TIMEOUT_MATCHER = /Navigation timeout|net::ERR_TIMED_OUT/i;

export function augmentPageNavigationTimeoutError(err: unknown, effectiveTimeoutMs: number): Error {
  if (!(err instanceof Error)) return new Error(String(err));
  if (!NAVIGATION_TIMEOUT_MATCHER.test(err.message)) return err;

  const augmented = new Error(
    `${err.message}\n\n` +
      `HyperFrames effective page.goto navigation timeout: ${effectiveTimeoutMs} ms.\n\n` +
      `To raise the timeout:\n` +
      `  Env: PRODUCER_PAGE_NAVIGATION_TIMEOUT_MS=<higher-ms>  (milliseconds)\n` +
      `  CLI: --browser-timeout <seconds>                     (seconds)\n\n` +
      `To use a different browser binary (e.g. system Chrome instead of the pinned chrome-headless-shell):\n` +
      `  Env: HYPERFRAMES_BROWSER_PATH=<path-to-Chrome-or-chrome-headless-shell>\n`,
    { cause: err },
  );
  return augmented;
}

/**
 * Predicate variant: exposed for callers that only need to classify an
 * error (e.g. observability, tests) without materialising an augmented
 * Error. Uses the same matcher as the augmentation path so the two never
 * drift.
 */
export function isPageNavigationTimeoutError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : typeof err === "string" ? err : "";
  return NAVIGATION_TIMEOUT_MATCHER.test(message);
}
