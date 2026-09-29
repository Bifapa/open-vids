// Skills freshness: give the bundled skill set a content fingerprint so we can
// answer "are the installed skills the latest version?" across every agent
// platform (Claude Code, Codex, …) — offline, from the bundled `skills/` tree.
//
// Why our own hash instead of a lock `computedHash`: a skill is a whole
// directory (SKILL.md + references/ + scripts/ + palettes/ + templates/), so
// we fingerprint the *entire* bundle. The same function hashes the bundled
// tree (to build the manifest) and the installed tree (to compare) — so equal
// content ⇒ equal hash.
//
// The manifest is intentionally minimal — `{ skills }`, no source label,
// version, or timestamp. Per-skill hashes are the source of truth for
// "current vs outdated", so any extra top-level field would only add a
// second, confusable signal. The manifest lives at the repo root
// (`skills-manifest.json`) and is copied into the built CLI (`dist/`).

import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

// File extensions we treat as text — line endings are normalised (CRLF→LF)
// before hashing so a Windows checkout doesn't read as "outdated". Everything
// else is hashed as raw bytes.
const TEXT_EXT = new Set([
  ".md",
  ".txt",
  ".mjs",
  ".js",
  ".ts",
  ".jsx",
  ".tsx",
  ".html",
  ".css",
  ".json",
  ".svg",
  ".csv",
  ".yml",
  ".yaml",
]);

export interface SkillEntry {
  /** Short sha256 (16 hex chars) over the skill's whole directory. */
  hash: string;
  /** Number of files in the bundle (for a quick human sanity signal). */
  files: number;
}

export interface SkillsManifest {
  /** Per-skill fingerprint, keyed by skill name. */
  skills: Record<string, SkillEntry>;
}

// "removed" = installed under the located root but no longer in the bundled
// manifest (renamed or dropped from the bundle). Detected structurally — see
// detectRemoved.
export type SkillStatus = "current" | "outdated" | "missing" | "removed";

export interface SkillDiff {
  name: string;
  status: SkillStatus;
  installedHash?: string;
  latestHash?: string;
}

/** The pure manifest diff (current / outdated / missing — what `diffSkills` returns). */
export interface SkillsDiff {
  updateAvailable: boolean;
  /** `coreMissing` ⊆ `missing`: the missing skills that are core (see "Skill tiers"). */
  summary: { current: number; outdated: number; missing: number; coreMissing: number };
  skills: SkillDiff[];
}

export interface SkillsCheckResult {
  /** Install location that was checked (absolute path), or null if none found. */
  location: string | null;
  /** Agent convention inferred from the location (claude-code, codex, …). */
  agent: string | null;
  /** Scope of the located install — so a caller prunes in the same scope it attributed from. */
  scope: "project" | "global" | null;
  updateAvailable: boolean;
  summary: {
    current: number;
    outdated: number;
    missing: number;
    coreMissing: number;
    removed: number;
  };
  skills: SkillDiff[];
  /**
   * Always false locally (removed-detection is structural, no lock file).
   * Kept so the check-result shape stays stable for JSON consumers.
   */
  lockMissing: boolean;
}

/** Manifest filename, published at the repo root and copied into the built CLI. */
export const MANIFEST_FILE = "skills-manifest.json";

// ── Skill tiers ──────────────────────────────────────────────────────────────
//
// Two tiers decide what installs eagerly vs on demand:
//
//   core     — the `/hyperframes` entry router plus the shared domain skills
//              (`hyperframes-*`, `media-use`) that every creation workflow
//              references structurally (sibling `../hyperframes-animation/…`
//              paths, "call /media-use" preambles). These must be present and
//              current for ANY workflow to run, so `init` / `skills update`
//              keep them fresh.
//   on-demand — everything else: the end-user workflow skills (pr-to-video,
//              embedded-captions, …) and optional integrations (figma). They
//              install lazily, when their workflow is actually triggered
//              (`hyperframes skills update <name>`), instead of being sprayed
//              onto every machine that runs `init`.

/** The entry/router skill — the capability map that routes every request. */
const ENTRY_SKILL = "hyperframes";

/** True for skills every workflow depends on (see "Skill tiers" above). */
export function isCoreSkill(name: string): boolean {
  return name === ENTRY_SKILL || name.startsWith("hyperframes-") || name === "media-use";
}

/**
 * Pinned enumeration of the core tier, used when the bundled manifest cannot
 * be enumerated directly (e.g. an explicit skill list with no manifest read).
 * isCoreSkill is a pattern, and a pattern can't be enumerated without a name
 * list. A unit test pins this list to the repo's skills/ tree so it can't
 * drift silently; update it when core membership changes.
 */
export const FALLBACK_CORE_SKILLS: readonly string[] = [
  "hyperframes",
  "hyperframes-animation",
  "hyperframes-audio",
  "hyperframes-cli",
  "hyperframes-core",
  "hyperframes-creative",
  "hyperframes-keyframes",
  "hyperframes-registry",
  "hyperframes-studio",
  "media-use",
];

// ── Hashing ────────────────────────────────────────────────────────────────

function listFilesSorted(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string): void => {
    for (const name of readdirSync(d)) {
      if (name === ".DS_Store") continue;
      const p = join(d, name);
      if (statSync(p).isDirectory()) walk(p);
      else out.push(p);
    }
  };
  walk(dir);
  // Sorting the full path list once is what guarantees a deterministic,
  // filesystem-order-independent hash — no need to also sort per directory.
  return out.sort();
}

/**
 * Fingerprint one skill directory. Deterministic: files are sorted by relative
 * POSIX path, text files are line-ending normalised, and the relative path is
 * folded into the hash so a moved file changes the fingerprint.
 */
export function hashSkillBundle(skillDir: string): SkillEntry {
  const files = listFilesSorted(skillDir);
  const h = createHash("sha256");
  for (const f of files) {
    const rel = relative(skillDir, f).split(sep).join("/");
    h.update(rel);
    h.update("\0");
    const ext = rel.slice(rel.lastIndexOf("."));
    const buf = readFileSync(f);
    if (TEXT_EXT.has(ext)) h.update(buf.toString("utf8").replace(/\r\n/g, "\n"), "utf8");
    else h.update(buf);
    h.update("\0");
  }
  return { hash: h.digest("hex").slice(0, 16), files: files.length };
}

/**
 * Build a manifest from a `skills/` root directory (a folder of
 * `<name>/SKILL.md` skill bundles). Used by the manifest generator. Output is
 * fully deterministic — same content in, byte-identical manifest out.
 */
export function buildManifest(skillsRoot: string): SkillsManifest {
  const names = readdirSync(skillsRoot)
    .filter((n) => existsSync(join(skillsRoot, n, "SKILL.md")))
    .sort();
  const skills: Record<string, SkillEntry> = {};
  for (const name of names) skills[name] = hashSkillBundle(join(skillsRoot, name));
  return { skills };
}

// ── Locating installed skills ────────────────────────────────────────────────

interface SkillRoot {
  /** Absolute path to a `.../skills` directory. */
  dir: string;
  /** Agent convention this directory belongs to. */
  agent: string;
  /** project = under cwd, global = under $HOME. */
  scope: "project" | "global";
}

/**
 * Map a host directory name to an agent label: ".claude" → "claude-code",
 * ".factory" → "factory", "opencode" (under .config) → "opencode".
 */
function agentLabel(hostDir: string): string {
  const name = hostDir.replace(/^\.+/, "");
  return name === "claude" ? "claude-code" : name || "unknown";
}

/** Infer the agent from a `.../skills` path by its host segment (the dir above "skills"). */
function agentFromDir(dir: string): string {
  const parts = dir.split(sep).filter(Boolean);
  const i = parts.lastIndexOf("skills");
  return agentLabel(i > 0 ? parts[i - 1]! : (parts[parts.length - 1] ?? ""));
}

/** Immediate subdirectory names of `dir` (including symlinked dirs); [] if unreadable. */
function listSubdirs(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory() || e.isSymbolicLink())
      .map((e) => e.name);
  } catch {
    return [];
  }
}

/**
 * Auto-discover candidate `<host>/skills` dirs under a scope base instead of
 * enumerating a fixed list of agents. Each agent convention lands as
 * `<base>/<host>/skills` (or the XDG `<base>/.config/<host>/skills`), so we
 * find them by structure. claude-code is ordered first; the rest
 * deterministically by agent then path.
 */
function discoverSkillRoots(base: string, scope: "project" | "global"): SkillRoot[] {
  const candidates: SkillRoot[] = [];
  const add = (hostBase: string, host: string): void => {
    const dir = join(hostBase, host, "skills");
    if (existsSync(dir) && statSync(dir).isDirectory())
      candidates.push({ dir, agent: agentLabel(host), scope });
  };
  for (const host of listSubdirs(base)) add(base, host);
  const xdg = join(base, ".config");
  for (const host of listSubdirs(xdg)) add(xdg, host);
  return candidates.sort((a, b) => {
    if (a.agent !== b.agent) {
      if (a.agent === "claude-code") return -1;
      if (b.agent === "claude-code") return 1;
      return a.agent.localeCompare(b.agent);
    }
    return a.dir.localeCompare(b.dir);
  });
}

/**
 * Decide whether an explicit `--dir` is a project- or global-scoped install,
 * so removal reconciles in the scope it inspected.
 *
 * Precedence is CWD-containment FIRST, then HOME — because the common
 * project-local case is *also* under `$HOME` (e.g. `~/work/proj/.claude/skills`,
 * or `--dir .claude/skills` run from `~/work/proj`). Checking HOME first would
 * misclassify every such project install as global. So:
 *   - `dir` under `cwd`  → project (even when that's also under $HOME)
 *   - else `dir` under $HOME → global (a real `~/.claude/skills`-style install)
 *   - else → project (safe default — never prune globally for an unknown path)
 *
 * Each base is normalised with a trailing separator before the prefix test so a
 * sibling like `/home/user2` doesn't false-match `/home/user`.
 */
function scopeForDir(dir: string, home: string, cwd: string): "project" | "global" {
  const norm = (p: string): string => {
    const r = resolve(p);
    return r.endsWith(sep) ? r : r + sep;
  };
  const d = norm(dir);
  if (d.startsWith(norm(cwd))) return "project";
  if (d.startsWith(norm(home))) return "global";
  return "project";
}

/**
 * Find the first skill root that actually contains bundled skills. A `--dir`
 * override (if given) is treated as a `.../skills` directory directly.
 * Otherwise scan global ($HOME) then project (cwd), auto-discovering hosts.
 *
 * Global is checked FIRST to match how agents actually load skills: most
 * agents give the personal/global scope priority over the project scope, and
 * this CLI installs globally. Checking global-first means `check` reports on
 * the copy the agent will really use — not a stale project copy that a newer
 * global install silently overrides.
 */
function locateInstall(
  skillNames: string[],
  opts: { dir?: string; cwd?: string; home?: string } = {},
): SkillRoot | null {
  if (opts.dir) {
    return existsSync(opts.dir)
      ? {
          dir: opts.dir,
          agent: agentFromDir(opts.dir),
          scope: scopeForDir(opts.dir, opts.home ?? homedir(), opts.cwd ?? process.cwd()),
        }
      : null;
  }
  const roots = [
    ...discoverSkillRoots(opts.home ?? homedir(), "global"),
    ...discoverSkillRoots(opts.cwd ?? process.cwd(), "project"),
  ];
  for (const root of roots) {
    if (skillNames.some((n) => existsSync(join(root.dir, n, "SKILL.md")))) return root;
  }
  return null;
}

/**
 * Names from `skillNames` that are present (their SKILL.md exists) in the
 * located install. Fully local, so callers can verify presence offline.
 */
export function presentSkills(
  skillNames: readonly string[],
  opts: { dir?: string; cwd?: string; home?: string } = {},
): string[] {
  const root = locateInstall([...skillNames], opts);
  if (!root) return [];
  return skillNames.filter((name) => existsSync(join(root.dir, name, "SKILL.md")));
}

/** Hash every manifest skill that is installed under `root`. */
function hashInstalled(root: SkillRoot, skillNames: string[]): Record<string, SkillEntry> {
  const out: Record<string, SkillEntry> = {};
  for (const name of skillNames) {
    const skillDir = join(root.dir, name);
    if (existsSync(join(skillDir, "SKILL.md"))) out[name] = hashSkillBundle(skillDir);
  }
  return out;
}

// ── Diff ─────────────────────────────────────────────────────────────────────

export function diffSkills(
  installed: Record<string, SkillEntry>,
  latest: SkillsManifest,
): SkillsDiff {
  // Report only on skills the manifest knows about. A skill on disk that isn't
  // in the manifest is handled separately (see detectRemoved), which reports
  // it structurally without needing lock attribution.
  const skills: SkillDiff[] = [];
  const summary = { current: 0, outdated: 0, missing: 0, coreMissing: 0 };

  for (const name of Object.keys(latest.skills).sort()) {
    const latestEntry = latest.skills[name]!;
    const installedEntry = installed[name];
    let status: SkillStatus;
    if (!installedEntry) status = "missing";
    else if (installedEntry.hash === latestEntry.hash) status = "current";
    else status = "outdated";

    if (status === "current") summary.current++;
    else if (status === "outdated") summary.outdated++;
    else {
      summary.missing++;
      if (isCoreSkill(name)) summary.coreMissing++;
    }

    skills.push({
      name,
      status,
      installedHash: installedEntry?.hash,
      latestHash: latestEntry.hash,
    });
  }

  return {
    // "Update available" means the install is stale, not merely partial:
    // anything installed-but-outdated, or a missing CORE skill (the entry
    // router + shared domain skills every workflow needs). A missing
    // on-demand skill is NOT an update — it installs when its workflow is
    // triggered (`hyperframes skills update <name>`). Counting it here is what
    // used to make `init` re-pull the full skill set onto machines that
    // deliberately installed a subset.
    updateAvailable: summary.outdated > 0 || summary.coreMissing > 0,
    summary,
    skills,
  };
}

// ── Removed (orphaned) skills ────────────────────────────────────────────────
//
// Local installs only ever add or refresh — none of them delete a skill that
// was renamed or dropped from the bundle (e.g. graphic-overlays →
// talking-head-recut), so a stale bundle lingers forever and the manifest-only
// diff above can't see it. We surface these structurally: any installed skill
// directory that is absent from the bundled manifest is "removed". This is
// scoped to installs this CLI manages (the located skill root), never the
// user's unrelated skills — only manifest-listed names are install targets,
// so anything else present-but-unlisted is either ours-but-retired or
// foreign, and both are reported for the caller to decide.

/** Skills installed under a located root that the bundle no longer ships. */
interface RemovedResult {
  removed: SkillDiff[];
  /** Always false locally — kept so the check-result shape stays stable. */
  lockMissing: boolean;
}

/**
 * Skills present on disk under `root` that the manifest no longer lists.
 *
 * Only manifest-listed names are ever install targets, so an installed
 * directory absent from the manifest is either a retired bundle or a foreign
 * skill sharing the directory. Both surface as "removed" for the caller to
 * reconcile; deletion itself only touches names this CLI installed.
 */
function detectRemoved(root: SkillRoot, latest: SkillsManifest): RemovedResult {
  const removed = listSubdirs(root.dir)
    .filter((name) => existsSync(join(root.dir, name, "SKILL.md")))
    .filter((name) => !(name in latest.skills))
    .sort()
    .map((name) => ({ name, status: "removed" as const }));
  return { removed, lockMissing: false };
}

// ── Resolving the bundled manifest ───────────────────────────────────────────
//
// The bundled `skills/` tree is the source of truth — no network, no GitHub.
// Resolution order for the manifest:
//   1. `OPENVIDS_SKILLS_MANIFEST` env override (tests, dev tooling)
//   2. `skills-manifest.json` beside the built CLI (`dist/`, staged by
//      build-copy.mjs and shipped inside the desktop runtime)
//   3. `<repoRoot>/skills-manifest.json` found by walking up from this module
//      (dev checkout)
//   4. A manifest computed on the fly from a bundled `skills/` tree found the
//      same way (dev checkout without a regenerated manifest)

/** Root of the bundled skills tree, or null when it cannot be found. */
export function bundledSkillsRoot(cwd = process.cwd()): string | null {
  const override = process.env["OPENVIDS_SKILLS_DIR"];
  if (override) {
    const dir = isAbsolute(override) ? override : resolve(cwd, override);
    if (existsSync(join(dir, "hyperframes", "SKILL.md"))) return dir;
    return null;
  }
  let here: string | null = null;
  try {
    here = dirname(fileURLToPath(import.meta.url));
  } catch {
    here = null;
  }
  if (here) {
    // Bundled layout: dist/cli.js is flat-bundled, so dist/skills sits
    // beside it. Dev layout: packages/cli/src/utils → repo skills/.
    const bundled = resolve(here, "skills");
    if (existsSync(join(bundled, "hyperframes", "SKILL.md"))) return bundled;
    let dir = resolve(here);
    for (let i = 0; i < 16; i++) {
      if (existsSync(join(dir, "skills", "hyperframes", "SKILL.md"))) return join(dir, "skills");
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }
  return null;
}

/**
 * Narrow an untrusted JSON payload to a SkillsManifest, or throw a clear error.
 * Guards against a hand-edited manifest with a bad shape surfacing later as a
 * cryptic crash in diffSkills.
 */
function asSkillsManifest(data: unknown, sourceLabel: string): SkillsManifest {
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw new Error(`Malformed skills manifest from ${sourceLabel}`);
  }
  const skills = (data as { skills?: unknown }).skills;
  if (!skills || typeof skills !== "object" || Array.isArray(skills)) {
    throw new Error(`Malformed skills manifest from ${sourceLabel}`);
  }
  return { skills: skills as SkillsManifest["skills"] };
}

/** Read the bundled manifest — a manifest file, or a skills/ tree hashed on the fly. */
export function resolveBundledManifest(cwd = process.cwd()): SkillsManifest {
  const override = process.env["OPENVIDS_SKILLS_MANIFEST"];
  if (override) {
    const direct = isAbsolute(override) ? override : resolve(cwd, override);
    if (existsSync(direct))
      return asSkillsManifest(JSON.parse(readFileSync(direct, "utf8")), direct);
    throw new Error(`No skills manifest found at: ${override}`);
  }
  let here: string | null = null;
  try {
    here = dirname(fileURLToPath(import.meta.url));
  } catch {
    here = null;
  }
  if (here) {
    // Bundled layout: dist/cli.js is flat-bundled, so dist/skills-manifest.json
    // sits beside it. Dev layout: walk up to the repo-root manifest.
    const bundled = resolve(here, MANIFEST_FILE);
    if (existsSync(bundled))
      return asSkillsManifest(JSON.parse(readFileSync(bundled, "utf8")), bundled);
    let dir = resolve(here);
    for (let i = 0; i < 16; i++) {
      const candidate = join(dir, MANIFEST_FILE);
      if (existsSync(candidate))
        return asSkillsManifest(JSON.parse(readFileSync(candidate, "utf8")), candidate);
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }
  const skillsRoot = bundledSkillsRoot(cwd);
  if (skillsRoot) return buildManifest(skillsRoot);
  throw new Error("No bundled skills found — reinstall the CLI or run from a source checkout");
}

/** Read a manifest from an explicit local path — a manifest file or a repo root. */
function resolveLocalManifest(source: string): SkillsManifest {
  const direct = source.endsWith(".json") ? source : join(source, MANIFEST_FILE);
  if (existsSync(direct)) return asSkillsManifest(JSON.parse(readFileSync(direct, "utf8")), direct);
  // Fall back to computing from a skills/ tree on disk.
  const skillsRoot = source.endsWith("skills") ? source : join(source, "skills");
  if (existsSync(skillsRoot)) return buildManifest(skillsRoot);
  throw new Error(`No skills manifest found at: ${source}`);
}

/**
 * Resolve the bundled manifest. `source` may be:
 *   - undefined → the bundled manifest (dist/ or repo checkout)
 *   - a local path to a manifest file or a repo root containing `skills/`
 *
 * Fully offline: no fetch, no `git ls-remote`, no GitHub.
 */
function resolveLatestManifest(source?: string, cwd = process.cwd()): SkillsManifest {
  // A local path is a relative one (./ ../) or an absolute one — isAbsolute
  // covers POSIX `/…` and Windows `C:\…` / `\…` on their respective platforms.
  if (source && (source.startsWith(".") || isAbsolute(source))) {
    return resolveLocalManifest(source);
  }
  if (source) {
    throw new Error(
      `Remote skill sources are not supported offline (got ${JSON.stringify(source)}). ` +
        "Omit --source to use the bundled skills.",
    );
  }
  return resolveBundledManifest(cwd);
}

/**
 * End-to-end check: locate the install, hash it, diff against the bundled
 * manifest. Fully local — no network.
 */
export function checkSkills(
  opts: { dir?: string; source?: string; cwd?: string; home?: string } = {},
): SkillsCheckResult {
  const latest = resolveLatestManifest(opts.source, opts.cwd);
  const skillNames = Object.keys(latest.skills);
  const root = locateInstall(skillNames, { dir: opts.dir, cwd: opts.cwd, home: opts.home });
  const installed = root ? hashInstalled(root, skillNames) : {};
  const diff = diffSkills(installed, latest);
  const removedResult = root ? detectRemoved(root, latest) : { removed: [], lockMissing: false };
  const { removed, lockMissing } = removedResult;
  return {
    location: root?.dir ?? null,
    agent: root?.agent ?? null,
    scope: root?.scope ?? null,
    // Removed skills also mean the install isn't reconciled with the manifest —
    // `skills update` now prunes them, so they count toward "update available".
    updateAvailable: diff.updateAvailable || removed.length > 0,
    summary: { ...diff.summary, removed: removed.length },
    skills: [...diff.skills, ...removed],
    lockMissing,
  };
}
