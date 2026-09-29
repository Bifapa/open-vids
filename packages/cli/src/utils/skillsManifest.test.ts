import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  checkSkills,
  diffSkills,
  buildManifest,
  isCoreSkill,
  presentSkills,
} from "./skillsManifest.js";

let root: string;
let home: string;
let project: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "skills-local-"));
  home = join(root, "home");
  project = join(root, "project");
  mkdirSync(home, { recursive: true });
  mkdirSync(project, { recursive: true });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function writeBundledSkills(names: string[]): string {
  const skillsRoot = join(root, "skills");
  mkdirSync(skillsRoot, { recursive: true });
  for (const name of names) {
    mkdirSync(join(skillsRoot, name), { recursive: true });
    writeFileSync(join(skillsRoot, name, "SKILL.md"), `# ${name}\n`);
  }
  const manifestPath = join(root, "skills-manifest.json");
  writeFileSync(manifestPath, JSON.stringify(buildManifest(skillsRoot)));
  return manifestPath;
}

function installSkill(skillsDir: string, name: string, content = `# ${name}\n`): void {
  mkdirSync(join(skillsDir, name), { recursive: true });
  writeFileSync(join(skillsDir, name, "SKILL.md"), content);
}

describe("buildManifest", () => {
  it("includes only directories that contain a SKILL.md", () => {
    const skillsRoot = join(root, "skills");
    mkdirSync(join(skillsRoot, "real"), { recursive: true });
    writeFileSync(join(skillsRoot, "real", "SKILL.md"), "x");
    mkdirSync(join(skillsRoot, "not-a-skill"), { recursive: true });
    writeFileSync(join(skillsRoot, "not-a-skill", "README.md"), "x");
    const m = buildManifest(skillsRoot);
    expect(Object.keys(m.skills)).toEqual(["real"]);
  });

  it("has no source field (local-first)", () => {
    const skillsRoot = join(root, "skills");
    mkdirSync(join(skillsRoot, "a"), { recursive: true });
    writeFileSync(join(skillsRoot, "a", "SKILL.md"), "x");
    const m = buildManifest(skillsRoot);
    expect("source" in m).toBe(false);
  });
});

describe("isCoreSkill", () => {
  it("classifies the entry router, hyperframes-* domain skills, and media-use as core", () => {
    expect(isCoreSkill("hyperframes")).toBe(true);
    expect(isCoreSkill("hyperframes-core")).toBe(true);
    expect(isCoreSkill("hyperframes-animation")).toBe(true);
    expect(isCoreSkill("media-use")).toBe(true);
    expect(isCoreSkill("pr-to-video")).toBe(false);
    expect(isCoreSkill("embedded-captions")).toBe(false);
    expect(isCoreSkill("figma")).toBe(false);
  });
});

describe("diffSkills", () => {
  it("classifies current / outdated / missing and ignores skills not in the manifest", () => {
    const manifest = {
      skills: {
        keep: { hash: "h1", files: 1 },
        changed: { hash: "h2", files: 1 },
        gone: { hash: "h3", files: 1 },
      },
    };
    const diff = diffSkills(
      {
        keep: { hash: "h1", files: 1 },
        changed: { hash: "DIFFERENT", files: 1 },
        extra: { hash: "hx", files: 1 },
      },
      manifest,
    );
    const byName = Object.fromEntries(diff.skills.map((s) => [s.name, s.status]));
    expect(byName).toEqual({ keep: "current", changed: "outdated", gone: "missing" });
    expect(diff.summary).toEqual({ current: 1, outdated: 1, missing: 1, coreMissing: 0 });
  });
});

describe("checkSkills local resolution", () => {
  it("diffs an install against an explicit local manifest", () => {
    const manifestPath = writeBundledSkills(["alpha", "beta"]);
    installSkill(join(home, ".claude/skills"), "alpha");

    const res = checkSkills({ source: manifestPath, cwd: project, home });
    expect(res.location).toBe(join(home, ".claude/skills"));
    expect(res.agent).toBe("claude-code");
    const byName = Object.fromEntries(res.skills.map((s) => [s.name, s.status]));
    expect(byName["alpha"]).toBe("current");
    expect(byName["beta"]).toBe("missing");
  });

  it("flags an installed-but-unlisted skill as removed", () => {
    const manifestPath = writeBundledSkills(["alpha"]);
    const dir = join(home, ".claude/skills");
    installSkill(dir, "alpha");
    installSkill(dir, "retired");

    const res = checkSkills({ source: manifestPath, cwd: project, home });
    const byName = Object.fromEntries(res.skills.map((s) => [s.name, s.status]));
    expect(byName["retired"]).toBe("removed");
    expect(res.summary.removed).toBe(1);
    expect(res.updateAvailable).toBe(true);
  });

  it("rejects a remote --source offline", () => {
    expect(() => checkSkills({ source: "owner/repo", cwd: project, home })).toThrow(
      /not supported offline/,
    );
  });

  it("honors the --dir override and infers the agent from the path", () => {
    const manifestPath = writeBundledSkills(["alpha"]);
    const dir = join(root, "home", ".kiro/skills");
    installSkill(dir, "alpha");

    const res = checkSkills({ source: manifestPath, dir });
    expect(res.location).toBe(dir);
    expect(res.agent).toBe("kiro");
  });

  it("presentSkills returns only the names present in the located install", () => {
    const skillsDir = join(home, ".claude/skills");
    installSkill(skillsDir, "hyperframes");

    expect(presentSkills(["hyperframes", "pr-to-video"], { cwd: project, home })).toEqual([
      "hyperframes",
    ]);
  });

  it("resolves the bundled manifest with no source via env override (offline)", () => {
    const manifestPath = writeBundledSkills(["alpha"]);
    const prev = process.env["OPENVIDS_SKILLS_MANIFEST"];
    process.env["OPENVIDS_SKILLS_MANIFEST"] = manifestPath;
    try {
      const res = checkSkills({ cwd: project, home });
      expect(res.location).toBeNull();
      expect(res.skills.map((s) => s.name)).toEqual(["alpha"]);
    } finally {
      if (prev === undefined) delete process.env["OPENVIDS_SKILLS_MANIFEST"];
      else process.env["OPENVIDS_SKILLS_MANIFEST"] = prev;
    }
  });

  it("malformed manifest JSON throws a clear error", () => {
    const bad = join(root, "bad.json");
    writeFileSync(bad, JSON.stringify({ nope: true }));
    expect(() => checkSkills({ source: bad, cwd: project, home })).toThrow(/Malformed/);
    const raw = readFileSync(bad, "utf8");
    expect(raw).toContain("nope");
  });
});
