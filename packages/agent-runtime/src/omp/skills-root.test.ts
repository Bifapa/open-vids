import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { bundledSkillsRoot, skillsInstruction } from "./skills-root.ts";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function tree(...skillsDirs: string[]): string {
  const root = mkdtempSync(join(tmpdir(), "ov-skills-root-"));
  roots.push(root);
  for (const dir of skillsDirs) {
    mkdirSync(join(root, dir, "hyperframes"), { recursive: true });
    writeFileSync(join(root, dir, "hyperframes", "SKILL.md"), "# skill");
  }
  return root;
}

describe("bundledSkillsRoot", () => {
  it("finds the repo's skills/ from a source checkout", () => {
    const root = tree("skills");
    const here = join(root, "packages", "agent-runtime", "src", "omp");
    mkdirSync(here, { recursive: true });
    expect(bundledSkillsRoot(here, undefined)).toBe(join(root, "skills"));
  });

  it("finds the skills staged beside the runtime in the packaged app", () => {
    const root = tree(join("runtime", "hyperframes", "skills"));
    const here = join(root, "runtime", "agent-runtime", "src", "omp");
    mkdirSync(here, { recursive: true });
    expect(bundledSkillsRoot(here, undefined)).toBe(join(root, "runtime", "hyperframes", "skills"));
  });

  it("honours an override that holds the skills and refuses one that does not", () => {
    const root = tree("custom");
    expect(bundledSkillsRoot(root, join(root, "custom"))).toBe(join(root, "custom"));
    expect(bundledSkillsRoot(root, join(root, "missing"))).toBeNull();
  });

  it("is null when there are no skills anywhere above", () => {
    const root = tree();
    expect(bundledSkillsRoot(root, undefined)).toBeNull();
  });

  it("tells the agent where the skills are and that they are read-only", () => {
    expect(skillsInstruction("/x/skills")).toContain("/x/skills");
    expect(skillsInstruction("/x/skills")).toContain("cannot edit or write");
  });
});
