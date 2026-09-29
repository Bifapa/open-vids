// @vitest-environment node
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// Semantic pin for the /figma skill's MCP-only phases: motion, shaders, and
// storyboards have NO CLI touchpoint, so the SKILL.md phase names are the only
// thing that routes them. The manifest hash proves the skill changed; this
// proves a future prompt edit didn't silently drop the phase names.
const REPO_ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..", "..", "..", "..", "..");
const read = (...parts: string[]): string => readFileSync(join(REPO_ROOT, ...parts), "utf8");
const SKILL_MD = read("skills", "figma", "SKILL.md");

describe("figma SKILL.md MCP-only phases", () => {
  it("documents the connector-assisted motion/shader/storyboard phases", () => {
    expect(SKILL_MD).toContain("## Motion (Phase 4 — connector-assisted)");
    expect(SKILL_MD).toContain("## Shaders (Phase 5 — mostly manual)");
    expect(SKILL_MD).toContain("storyboard");
  });

  it("does not instruct agents to call deleted CLI commands", () => {
    expect(SKILL_MD).not.toContain("hyperframes events");
    expect(SKILL_MD).not.toContain("hyperframes upgrade");
    expect(SKILL_MD).not.toContain("hyperframes telemetry");
  });
});

// Routing pin: a catalog blurb once said "storyboard sections → animatics",
// which encodes the frames-as-pictures slideshow the skill's own cardinal rule
// forbids — a field agent routed by that word and concluded the shipped
// behavior was the PNG-sequence architecture. These assertions keep the
// frames-are-states framing in the skill surfaces that still exist (the root
// README table was removed with the upstream cleanup), so a future sync can't
// silently reintroduce the old word.
describe("figma storyboard doctrine pins", () => {
  const SKILL_SURFACES: Array<[string, string[]]> = [
    ["skills/figma/SKILL.md", ["skills", "figma", "SKILL.md"]],
    ["skills/hyperframes/SKILL.md", ["skills", "hyperframes", "SKILL.md"]],
  ];

  it("every skill surface says reconstructed motion, never animatics", () => {
    for (const [label, parts] of SKILL_SURFACES) {
      const content = read(...parts);
      expect(content, label).toContain("reconstructed motion");
      expect(content, label).not.toContain("animatics");
    }
  });

  it("the source-of-truth description carries the frames-as-states framing", () => {
    expect(SKILL_MD).toContain("frames read as states, not slides");
  });

  it("keeps the cardinal rule and the app-states escalation (rule 10)", () => {
    expect(SKILL_MD).toContain("KEYFRAMES, not slides");
    expect(SKILL_MD).toContain("code what changes state, freeze what doesn't");
    expect(SKILL_MD).toContain("interaction to perform");
  });
});
