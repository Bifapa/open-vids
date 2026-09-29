import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const cliSource = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "cli.ts"), "utf8");
const helpSource = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "help.ts"), "utf8");

function commandLoaderBlock(): string {
  const match = cliSource.match(/const commandLoaders = \{([\s\S]*?)\n\};/);
  expect(match).toBeTruthy();
  return match![1]!;
}

describe("CLI command registration", () => {
  it("registers keyframes as the only keyframe inspection command", () => {
    const loaders = commandLoaderBlock();

    expect(loaders).toMatch(/\bkeyframes:\s*\(\)\s*=>\s*import\("\.\/commands\/keyframes\.js"\)/);
    expect(loaders).not.toMatch(/\bmotion:\s*\(\)\s*=>/);
    expect(loaders).not.toContain("./commands/motion.js");
  });

  it("shows keyframes in root help", () => {
    expect(helpSource).toContain(
      '["keyframes", "Inspect keyframes and render onion-shot diagnostics"]',
    );
  });

  it("shows the check command used by workflow capability preflight in root help", () => {
    const loaders = commandLoaderBlock();
    expect(loaders).toMatch(/\bcheck:\s*\(\)\s*=>\s*import\("\.\/commands\/check\.js"\)/);
    expect(helpSource).toContain(
      '["check", "Run lint, runtime validation, and layout inspection as one gate"]',
    );
  });

  it("registers media-treatment as the only treatment authoring command", () => {
    const loaders = commandLoaderBlock();
    expect(loaders).toContain('"media-treatment"');
    expect(loaders).not.toContain('"color-grading"');
  });

  it("guards every command loader against unknown flags", () => {
    expect(cliSource).toContain("guardUnknownFlags(load)");
    expect(cliSource).not.toContain("guardUnknownFlags(load,");
  });
});
