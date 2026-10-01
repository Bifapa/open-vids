// @vitest-environment happy-dom

/** Compact density is token overrides under `data-density="compact"`: the sizes it changes must be the ones the
 * utilities read, or the Appearance switch would do nothing. */

import { readFileSync } from "node:fs";
import path from "node:path";
import { compile } from "tailwindcss";
import { expect, it } from "vitest";
import { loadStylesheet, STYLES_DIR } from "./styleSources";

async function build(candidates: string[]): Promise<string> {
  const source = readFileSync(path.join(STYLES_DIR, "studio.css"), "utf8");
  const compiled = await compile(source, { base: STYLES_DIR, loadStylesheet });
  return compiled.build(candidates);
}

it("sizes nav items, two-line rows and Settings rows from the tokens Compact overrides", async () => {
  const css = await build(["h-nav", "min-h-row-lg", "h-row-lg", "py-row-pad"]);

  expect(css).toMatch(/\.h-nav \{[^}]*height: var\(--spacing-nav\)/);
  expect(css).toMatch(/\.min-h-row-lg \{[^}]*min-height: var\(--spacing-row-lg\)/);
  expect(css).toMatch(/\.h-row-lg \{[^}]*height: var\(--spacing-row-lg\)/);
  expect(css).toMatch(/\.py-row-pad \{[^}]*padding-block: var\(--spacing-row-pad\)/);
});

it("steps the sizes down under data-density=compact, and only those", async () => {
  const css = await build(["h-nav"]);
  const compact = css.match(/:root\[data-density="compact"\] \{([^}]*)\}/)?.[1] ?? "";

  expect(compact).toMatch(/--spacing-nav: 24px/);
  expect(compact).toMatch(/--spacing-row-lg: 34px/);
  expect(compact).toMatch(/--spacing-row-pad: 3px/);
  expect(compact.match(/--[a-z-]+:/g)).toHaveLength(3);
  // The defaults they override.
  expect(css).toMatch(/--spacing-nav: 26px/);
  expect(css).toMatch(/--spacing-row-lg: 40px/);
  expect(css).toMatch(/--spacing-row-pad: 6px/);
});
