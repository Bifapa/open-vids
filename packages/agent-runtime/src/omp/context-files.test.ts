import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  contextFilesHash,
  projectContextFiles,
  stripExternalAgentSections,
} from "./context-files.ts";

const sharedTemplates = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../../cli/src/templates/_shared",
);

describe("stripExternalAgentSections", () => {
  it("removes marked blocks and keeps the rest", () => {
    const text = [
      "# Title",
      "<!-- openvids:external-agents:start -->",
      "## Commands",
      "npx hyperframes check",
      "<!-- openvids:external-agents:end -->",
      "",
      "## Key Rules",
      "1. Rule",
    ].join("\n");
    expect(stripExternalAgentSections(text)).toBe("# Title\n## Key Rules\n1. Rule");
  });

  it("drops everything after a start marker whose end is missing", () => {
    const text = "keep\n<!-- openvids:external-agents:start -->\n## Commands\nrun it";
    expect(stripExternalAgentSections(text)).toBe("keep\n");
  });

  it("leaves a file without markers alone", () => {
    expect(stripExternalAgentSections("# Mine\n\nbody\n")).toBe("# Mine\n\nbody\n");
  });

  it.each(["AGENTS.md", "CLAUDE.md"])(
    "leaves the in-app agent no shell or skill instructions from the shared %s",
    (name) => {
      const context = stripExternalAgentSections(readFileSync(join(sharedTemplates, name), "utf8"));
      expect(context).toContain("## Project Structure");
      expect(context).toContain("## Key Rules");
      expect(context).not.toMatch(/## Skills/);
      expect(context).not.toMatch(/## Commands/);
      expect(context).not.toMatch(/## Documentation/);
      expect(context).not.toMatch(/## Linting/);
      expect(context).not.toMatch(/hyperframes (check|preview|render|lint|docs|skills)/);
      expect(context).not.toMatch(/\/hyperframes|npx|openvids:external-agents/);
    },
  );
});

describe("projectContextFiles", () => {
  const roots: string[] = [];
  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  function project(name: string, files: Record<string, string>): string {
    const root = mkdtempSync(join(tmpdir(), "ov-context-"));
    roots.push(root);
    const dir = join(root, name);
    mkdirSync(dir);
    for (const [file, content] of Object.entries(files)) writeFileSync(join(dir, file), content);
    return dir;
  }

  it("loads AGENTS.md of a project whose path has a space in it, without its external-agent sections", async () => {
    const dir = project("My Video", {
      "AGENTS.md":
        "# Mine\n<!-- openvids:external-agents:start -->\nrun npx\n<!-- openvids:external-agents:end -->\nkeep\n",
    });
    expect(await projectContextFiles(dir)).toEqual([
      { path: join(dir, "AGENTS.md"), content: "# Mine\nkeep\n" },
    ]);
  });

  it("falls back to CLAUDE.md, and returns nothing without either file", async () => {
    const dir = project("My Video", { "CLAUDE.md": "# Claude\n" });
    expect(await projectContextFiles(dir)).toEqual([
      { path: join(dir, "CLAUDE.md"), content: "# Claude\n" },
    ]);
    expect(await projectContextFiles(project("Empty One", {}))).toEqual([]);
  });
});

describe("contextFilesHash", () => {
  it("changes with the context file the agent would be told, and not with what it never sees", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ov-context-hash-"));
    try {
      const empty = await contextFilesHash(dir);
      writeFileSync(join(dir, "AGENTS.md"), "# Rules\nBe brief.\n");
      const first = await contextFilesHash(dir);
      expect(first).not.toBe(empty);
      expect(await contextFilesHash(dir)).toBe(first);

      writeFileSync(join(dir, "AGENTS.md"), "# Rules\nBe thorough.\n");
      expect(await contextFilesHash(dir)).not.toBe(first);

      // Shell instructions for external agents are stripped before the agent sees the file.
      writeFileSync(
        join(dir, "AGENTS.md"),
        "# Rules\n<!-- openvids:external-agents:start -->\nrun a shell\n<!-- openvids:external-agents:end -->\n",
      );
      const stripped = await contextFilesHash(dir);
      writeFileSync(
        join(dir, "AGENTS.md"),
        "# Rules\n<!-- openvids:external-agents:start -->\nrun another shell\n<!-- openvids:external-agents:end -->\n",
      );
      expect(await contextFilesHash(dir)).toBe(stripped);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
