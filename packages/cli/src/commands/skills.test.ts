import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

async function commandExitCode(): Promise<number> {
  const { consumeCommandResult } = await import("../utils/commandResult.js");
  return consumeCommandResult().exitCode;
}

async function resetCommandResult(): Promise<void> {
  const { consumeCommandResult } = await import("../utils/commandResult.js");
  consumeCommandResult();
}

vi.mock("@clack/prompts", () => ({
  log: { error: vi.fn(), warn: vi.fn() },
}));

vi.mock("../utils/skillsMirror.js", () => ({
  mirrorGlobalSkills: vi.fn(() => ({ source: null, mirrored: [], skipped: [] })),
}));

let root: string;
let home: string;
let bundled: string;
let manifestPath: string;

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "skills-cmd-"));
  home = join(root, "home");
  mkdirSync(home, { recursive: true });
  bundled = join(root, "skills");
  const names = [
    "hyperframes",
    "hyperframes-core",
    "media-use",
    "pr-to-video",
    "embedded-captions",
  ];
  for (const name of names) {
    mkdirSync(join(bundled, name), { recursive: true });
    writeFileSync(join(bundled, name, "SKILL.md"), `# ${name}\n`);
  }
  const { buildManifest } = await import("../utils/skillsManifest.js");
  manifestPath = join(root, "skills-manifest.json");
  writeFileSync(manifestPath, JSON.stringify(buildManifest(bundled)));
  process.env["OPENVIDS_SKILLS_DIR"] = bundled;
  process.env["OPENVIDS_SKILLS_MANIFEST"] = manifestPath;
  vi.resetModules();
  await resetCommandResult();
});

afterEach(async () => {
  delete process.env["OPENVIDS_SKILLS_DIR"];
  delete process.env["OPENVIDS_SKILLS_MANIFEST"];
  rmSync(root, { recursive: true, force: true });
  vi.restoreAllMocks();
  await resetCommandResult();
});

async function runSkillsSub(
  name: "update" | "check" | "validate",
  args: Record<string, unknown> = {},
  positionals: string[] = [],
): Promise<void> {
  const { default: skillsCmd } = await import("./skills.js");
  const subs = skillsCmd.subCommands as unknown as Record<string, typeof skillsCmd>;
  expect(subs[name]).toBeDefined();
  await subs[name]!.run?.({
    args: { _: positionals, ...args },
    rawArgs: positionals,
    cmd: subs[name],
  } as never);
}

describe("hyperframes skills (local-first)", () => {
  it("update installs the stale core set plus a requested workflow — nothing else", async () => {
    // Seed an install: hyperframes outdated, embedded-captions current,
    // pr-to-video missing (on demand).
    const dir = join(home, ".claude/skills");
    mkdirSync(join(dir, "hyperframes"), { recursive: true });
    writeFileSync(join(dir, "hyperframes", "SKILL.md"), "# hyperframes\nstale\n");
    mkdirSync(join(dir, "embedded-captions"), { recursive: true });
    writeFileSync(join(dir, "embedded-captions", "SKILL.md"), "# embedded-captions\n");

    await runSkillsSub("update", { dir }, ["pr-to-video"]);
    expect(await commandExitCode()).toBe(0);

    // Requested workflow installed from the bundle.
    expect(existsSync(join(dir, "pr-to-video", "SKILL.md"))).toBe(true);
    // Stale core refreshed to byte-match the bundle.
    const bundledCore = writeFileSync.length; // touch to keep import used
    void bundledCore;
    const { readFileSync } = await import("node:fs");
    expect(readFileSync(join(dir, "hyperframes", "SKILL.md"), "utf8")).toBe(
      readFileSync(join(bundled, "hyperframes", "SKILL.md"), "utf8"),
    );
    // Installed-and-current workflow untouched (still the seeded content).
    expect(readFileSync(join(dir, "embedded-captions", "SKILL.md"), "utf8")).toBe(
      "# embedded-captions\n",
    );
  });

  it("update is a no-op when everything is current", async () => {
    const dir = join(home, ".claude/skills");
    for (const name of ["hyperframes", "hyperframes-core", "media-use"]) {
      mkdirSync(join(dir, name), { recursive: true });
      const { copyFileSync } = await import("node:fs");
      copyFileSync(join(bundled, name, "SKILL.md"), join(dir, name, "SKILL.md"));
    }
    const { default: skillsCmd } = await import("./skills.js");
    void skillsCmd;

    await runSkillsSub("update", { dir });
    expect(await commandExitCode()).toBe(0);
    // No new skills appeared.
    expect(existsSync(join(dir, "pr-to-video"))).toBe(false);
  });

  it("update fails loudly on an unknown skill name (strict)", async () => {
    const dir = join(home, ".claude/skills");
    await runSkillsSub("update", { dir }, ["graphic-overlays"]);
    expect(await commandExitCode()).toBe(1);
    expect(existsSync(join(dir, "graphic-overlays"))).toBe(false);
  });

  it("rejects flag-like skill names before any install", async () => {
    const dir = join(home, ".claude/skills");
    await runSkillsSub("update", { dir }, ["--config=evil.js"]);
    expect(await commandExitCode()).toBe(1);
  });

  it("check exits non-zero when a core skill is missing", async () => {
    const dir = join(home, ".claude/skills");
    mkdirSync(dir, { recursive: true });
    await runSkillsSub("check", { dir });
    expect(await commandExitCode()).toBe(1);
  });

  it("check --json emits a parseable result", async () => {
    const dir = join(home, ".claude/skills");
    mkdirSync(dir, { recursive: true });
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    let calls: unknown[][] = [];
    try {
      await runSkillsSub("check", { dir, json: true });
    } finally {
      calls = [...logSpy.mock.calls];
      logSpy.mockRestore();
    }
    expect(await commandExitCode()).toBe(1);
    const last = String(calls.at(-1)?.[0] ?? "");
    const parsed = JSON.parse(last) as { location?: string; summary?: { missing?: number } };
    expect(parsed.location).toBe(dir);
    expect(parsed.summary?.missing ?? 0).toBeGreaterThan(0);
  });

  it("update prunes a skill no longer in the bundle", async () => {
    const dir = join(home, ".claude/skills");
    for (const name of ["hyperframes", "retired-skill"]) {
      mkdirSync(join(dir, name), { recursive: true });
      writeFileSync(join(dir, name, "SKILL.md"), `# ${name}\n`);
    }
    // hyperframes bundle content matches, so only the prune fires.
    const { copyFileSync } = await import("node:fs");
    copyFileSync(join(bundled, "hyperframes", "SKILL.md"), join(dir, "hyperframes", "SKILL.md"));

    await runSkillsSub("update", { dir });
    expect(await commandExitCode()).toBe(0);
    expect(existsSync(join(dir, "retired-skill"))).toBe(false);
    expect(existsSync(join(dir, "hyperframes", "SKILL.md"))).toBe(true);
  });

  it("validate passes on the bundled tree", async () => {
    await runSkillsSub("validate", {});
    expect(await commandExitCode()).toBe(0);
  });

  it("bare `hyperframes skills` installs the full bundled set", async () => {
    const { default: skillsCmd } = await import("./skills.js");
    // Point the default global store at the temp home. Auto-locate scans
    // $HOME (global) and cwd (project): clear USERPROFILE/CLAUDE_CONFIG_DIR
    // and chdir into an empty temp project so neither a stale dev-machine
    // install nor the repo's own tree wins locateInstall.
    const prevHome = process.env["HOME"];
    const prevProfile = process.env["USERPROFILE"];
    const prevClaude = process.env["CLAUDE_CONFIG_DIR"];
    const prevCwd = process.cwd();
    const emptyProject = join(root, "proj");
    mkdirSync(emptyProject, { recursive: true });
    process.env["HOME"] = home;
    delete process.env["USERPROFILE"];
    delete process.env["CLAUDE_CONFIG_DIR"];
    process.chdir(emptyProject);
    try {
      await skillsCmd.run?.({ args: {}, rawArgs: [], cmd: skillsCmd } as never);
    } finally {
      process.chdir(prevCwd);
      if (prevHome === undefined) delete process.env["HOME"];
      else process.env["HOME"] = prevHome;
      if (prevProfile === undefined) delete process.env["USERPROFILE"];
      else process.env["USERPROFILE"] = prevProfile;
      if (prevClaude === undefined) delete process.env["CLAUDE_CONFIG_DIR"];
      else process.env["CLAUDE_CONFIG_DIR"] = prevClaude;
    }
    expect(await commandExitCode()).toBe(0);
    expect(existsSync(join(home, ".claude/skills/hyperframes/SKILL.md"))).toBe(true);
    expect(existsSync(join(home, ".claude/skills/pr-to-video/SKILL.md"))).toBe(true);
  });
});
