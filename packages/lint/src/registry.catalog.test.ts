import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { lintProject } from "./project";

const REGISTRY = resolve(__dirname, "../../../registry");

function directories(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(dir, entry.name));
}

describe("shipped registry", () => {
  it("installs every example without lint errors", async () => {
    const failures: string[] = [];
    for (const example of directories(join(REGISTRY, "examples"))) {
      const { results } = await lintProject(example);
      for (const { file, result } of results) {
        for (const finding of result.findings.filter((item) => item.severity === "error")) {
          failures.push(`${example}/${file}: ${finding.code}`);
        }
      }
    }
    expect(failures).toEqual([]);
  }, 120_000);

  it("gives every block a composition id that cannot collide with a project root", () => {
    const roots: string[] = [];
    for (const block of directories(join(REGISTRY, "blocks"))) {
      for (const entry of readdirSync(block)) {
        if (!entry.endsWith(".html")) continue;
        const html = readFileSync(join(block, entry), "utf8");
        if (/data-composition-id=["']main["']/.test(html)) roots.push(`${block}/${entry}`);
      }
    }
    expect(roots).toEqual([]);
  });
});
