import { setCommandExitCode } from "../utils/commandResult.js";
import { defineCommand } from "citty";
import * as clack from "@clack/prompts";
import { cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { c } from "../ui/colors.js";
import { diag } from "../ui/diagnostics.js";
import { withMeta } from "../utils/jsonMeta.js";
import {
  bundledSkillsRoot,
  checkSkills,
  hashSkillBundle,
  isCoreSkill,
  presentSkills,
  resolveBundledManifest,
  type SkillDiff,
  type SkillsCheckResult,
  type SkillsManifest,
} from "../utils/skillsManifest.js";
import { mirrorGlobalSkills } from "../utils/skillsMirror.js";
import type { Example } from "./_examples.js";

export const examples: Example[] = [
  ["Install all bundled skills", "hyperframes skills"],
  ["Check whether installed skills are up to date", "hyperframes skills check"],
  ["Check, machine-readable (for agents / CI)", "hyperframes skills check --json"],
  ["Update the core set + everything already installed", "hyperframes skills update"],
  ["Also install one workflow (on-demand install)", "hyperframes skills update pr-to-video"],
];

// Skill names are kebab-case directory names. Refuse anything that isn't one
// before copying it into an agent dir: a crafted name could otherwise escape
// as a path (`../escape`) or a flag-like token.
const PLAIN_SKILL_NAME = /^[a-z0-9][a-z0-9._-]*$/i;

/** Copy bundled skill dirs into `targetDir`. Callers pre-filter to manifest names. */
function installBundledSkills(names: readonly string[], targetDir: string): string[] {
  const root = bundledSkillsRoot();
  if (!root)
    throw new Error("No bundled skills found — reinstall the CLI or run from a source checkout");
  const installed: string[] = [];
  for (const name of names) {
    const src = join(root, name);
    const dest = join(targetDir, name);
    if (!existsSync(join(src, "SKILL.md"))) continue;
    mkdirSync(dirname(dest), { recursive: true });
    rmSync(dest, { recursive: true, force: true });
    cpSync(src, dest, { recursive: true });
    installed.push(name);
  }
  return installed;
}

/** Default global install dir: the Claude store (what Claude Code reads). */
function defaultGlobalDir(home: string): string {
  const claudeHome = process.env["CLAUDE_CONFIG_DIR"]?.trim() || join(home, ".claude");
  return join(claudeHome, "skills");
}

/**
 * Fan the canonical global store out to every other installed agent.
 * Best-effort: a mirror failure must not fail the install.
 */
function mirrorToInstalledAgents(names: readonly string[], home?: string): void {
  try {
    const { mirrored, skipped } = mirrorGlobalSkills({ skills: names, home });
    const n = mirrored.length;
    if (n > 0) {
      diag.notice(
        c.dim(`Linked skills into ${n} other agent ${n === 1 ? "directory" : "directories"}.`),
      );
    }
    if (skipped.length > 0) {
      const agents = [...new Set(skipped.map((entry) => entry.agent))].join(", ");
      diag.warn(
        c.warn(
          `Skipped unsafe skill mirror target${skipped.length === 1 ? "" : "s"} for ${agents}; canonical skill stores were left unchanged.`,
        ),
      );
    }
  } catch {
    // best-effort
  }
}

// ── targeted install engine ──────────────────────────────────────────────────

/** What an `updateSkills` run guaranteed, and what it had to do to get there. */
export interface UpdateSkillsResult {
  /** Every skill this run guaranteed: requested + core (+ installed, when refreshing). */
  targets: string[];
  /** Targets that were (re)installed by this run. */
  installed: string[];
  /** Targets that were already current — nothing copied for them. */
  current: string[];
  /**
   * Requested names the bundled manifest doesn't ship (typo, or renamed
   * upstream). Only ever non-empty on a non-strict run: a strict run throws on
   * unknown names before returning, so strict callers never observe this.
   */
  unknown: string[];
  /** Always false locally — kept so the result shape stays stable. */
  presenceOnly: boolean;
}

/**
 * The targeted install engine behind `init` and `skills update [names...]`.
 * Guarantees a small, explicit set is installed and current, copied from the
 * bundled `skills/` tree — fully offline:
 *
 *   - the requested names (a workflow being routed to, e.g. `pr-to-video`),
 *   - the core set (entry router + shared domain skills — see skillsManifest),
 *   - with `refreshInstalled`, whatever is already installed (refreshed, so an
 *     update never *expands* a deliberate partial install),
 *   - with `all`, every skill the manifest publishes.
 *
 * Only targets that are actually missing or outdated are copied; when
 * everything is current the call is a fast no-op with no install.
 */
export function updateSkills(
  opts: {
    requested?: readonly string[];
    refreshInstalled?: boolean;
    /** Every skill the manifest publishes (bare `hyperframes skills`). */
    all?: boolean;
    strict?: boolean;
    cwd?: string;
    home?: string;
    dir?: string;
  } = {},
): UpdateSkillsResult {
  const requested = [...new Set(opts.requested ?? [])];
  const strict = opts.strict ?? false;
  const home = opts.home ?? process.env["HOME"] ?? process.env["USERPROFILE"] ?? "";
  const cwd = opts.cwd ?? process.cwd();

  const check = checkSkills({ dir: opts.dir, cwd, home });

  // "removed" entries are installed-but-unlisted leftovers, not manifest
  // skills — they are `skills update`'s prune concern, never an update target.
  const manifestSkills = check.skills.filter((s) => s.status !== "removed");
  const manifestNames = new Set(manifestSkills.map((s) => s.name));

  const unknown = requested.filter((name) => !manifestNames.has(name));
  if (unknown.length) {
    const message =
      `Unknown skill(s): ${unknown.join(", ")}. ` +
      `Available: ${[...manifestNames].sort().join(", ")}`;
    if (strict) throw new Error(message);
    clack.log.warn(c.warn(message));
  }

  const targets = manifestSkills.filter(
    (s) =>
      opts.all === true ||
      requested.includes(s.name) ||
      isCoreSkill(s.name) ||
      (opts.refreshInstalled === true && s.status !== "missing"),
  );
  const toInstall = targets.filter((s) => s.status === "missing" || s.status === "outdated");

  // The install target: an explicit --dir, else the located install, else the
  // default global store.
  const targetDir = opts.dir ?? check.location ?? (home ? defaultGlobalDir(home) : null);
  if (!targetDir) throw new Error("No skills directory found — pass --dir to choose one");

  const result: UpdateSkillsResult = {
    targets: targets.map((s) => s.name),
    installed: [],
    current: targets.filter((s) => s.status === "current").map((s) => s.name),
    unknown,
    presenceOnly: false,
  };

  if (toInstall.length > 0) {
    const names = toInstall.map((s) => s.name);
    result.installed = installBundledSkills(names, targetDir);
    verifyInstalled(result.installed, { strict, cwd, home, dir: targetDir });
    // Mirror the canonical global store out to every other installed agent.
    // Thread `home` through so tests (and callers with a custom HOME) mirror
    // under the same isolated home instead of the real one.
    if (!opts.dir) mirrorToInstalledAgents(result.installed, home);
  }
  return result;
}

/**
 * The presence half of the guarantee, after an install claims success: every
 * name must now exist on disk. Catches the "install exited 0 but delivered
 * nothing" failure mode, which would otherwise surface much later as a
 * workflow reading skill files that aren't there.
 *
 * Strictness mirrors the caller's tolerance: a strict run (the `check ||
 * update` CI contract, the router's trigger-time guarantee) throws so the
 * failure is loud; a non-strict run (init) only warns and proceeds, since a
 * skills hiccup must never break scaffolding.
 */
function verifyInstalled(
  names: readonly string[],
  opts: { strict: boolean; cwd?: string; home?: string; dir?: string },
): void {
  const present = new Set(presentSkills(names, { cwd: opts.cwd, home: opts.home, dir: opts.dir }));
  const absent = names.filter((name) => !present.has(name));
  if (absent.length === 0) return;
  const message = `Skill(s) still missing after install: ${absent.join(", ")}`;
  if (opts.strict) throw new Error(message);
  clack.log.warn(c.warn(message));
}

// ── check ────────────────────────────────────────────────────────────────────

/** Print a labelled list of skills (nothing if empty), each line uniformly coloured. */
function printSkillSection(
  result: SkillsCheckResult,
  status: SkillDiff["status"],
  title: string,
  mark: string,
  color: (s: string) => string,
  filter: (s: SkillDiff) => boolean = () => true,
): void {
  const items = result.skills.filter((s) => s.status === status && filter(s));
  if (!items.length) return;
  console.log();
  console.log(`  ${color(title)}`);
  for (const s of items) console.log(`    ${color(`${mark} ${s.name}`)}`);
}

function renderCheck(result: SkillsCheckResult): void {
  const { summary } = result;
  console.log();
  console.log(c.bold("hyperframes skills"));
  console.log();

  if (!result.location) {
    console.log(`  ${c.dim("No bundled skills found in the usual locations.")}`);
    console.log(`  ${c.accent("Install: npx hyperframes skills")}`);
    console.log();
    return;
  }

  console.log(`  ${c.bold("Location")}  ${c.dim(result.location)} ${c.dim(`(${result.agent})`)}`);
  console.log();

  const onDemandMissing = summary.missing - summary.coreMissing;
  const parts = [c.success(`✓ ${summary.current} current`)];
  if (summary.outdated) parts.push(c.warn(`↑ ${summary.outdated} outdated`));
  if (summary.coreMissing) parts.push(c.warn(`◦ ${summary.coreMissing} core not installed`));
  if (onDemandMissing) parts.push(c.dim(`◦ ${onDemandMissing} available on demand`));
  if (summary.removed) parts.push(c.warn(`✗ ${summary.removed} no longer bundled`));
  console.log(`  ${parts.join("   ")}`);

  printSkillSection(result, "outdated", "Outdated:", "↑", c.warn);
  printSkillSection(
    result,
    "missing",
    "Core not installed (skills update installs these):",
    "◦",
    c.warn,
    (s) => isCoreSkill(s.name),
  );
  printSkillSection(
    result,
    "missing",
    "Available on demand (installed when their workflow first runs):",
    "◦",
    c.dim,
    (s) => !isCoreSkill(s.name),
  );
  printSkillSection(
    result,
    "removed",
    "No longer bundled (renamed or dropped — safe to delete):",
    "✗",
    c.warn,
  );

  console.log();
  if (result.updateAvailable) {
    console.log(`  ${c.accent("Update: npx hyperframes skills update")}`);
  } else {
    console.log(`  ${c.success("◇")}  ${c.success("Installed skills are up to date")}`);
  }
  console.log();
}

const checkCommand = defineCommand({
  meta: { name: "check", description: "Check whether installed skills match the bundled set" },
  args: {
    json: { type: "boolean", description: "Output as JSON", default: false },
    dir: { type: "string", description: "Skills directory to check (default: auto-detect)" },
    source: {
      type: "string",
      description: "Local path to a manifest file or repo root (default: bundled skills)",
    },
  },
  run({ args }) {
    const result = checkSkills({
      dir: args.dir,
      source: args.source,
    });

    if (args.json) console.log(JSON.stringify(withMeta(result), null, 2));
    else renderCheck(result);

    // Exit non-zero when installed skills are stale, so agents and CI can gate:
    //   hyperframes skills check || npx hyperframes skills update
    if (result.updateAvailable) setCommandExitCode(1);
  },
});

// ── update ───────────────────────────────────────────────────────────────────

/**
 * Positional skill names from argv, split into plain-slug names and rejected
 * tokens — each name is copied into an agent dir, so flag-like tokens are
 * refused up front (the caller reports and exits).
 */
function requestedNamesFrom(positionals: readonly unknown[]): {
  requested: string[];
  rejected: string[];
} {
  const names = positionals.map(String).filter((n) => n.length > 0);
  return {
    requested: names.filter((n) => PLAIN_SKILL_NAME.test(n)),
    rejected: names.filter((n) => !PLAIN_SKILL_NAME.test(n)),
  };
}

/** Result line(s) for `skills update` — JSON for agents, one calm line for humans. */
function reportUpdate(
  result: UpdateSkillsResult,
  requested: readonly string[],
  json: boolean,
): void {
  if (json) {
    console.log(JSON.stringify(withMeta(result), null, 2));
    return;
  }
  if (result.installed.length > 0) {
    console.log(
      c.success(
        `Installed/updated ${result.installed.length} skill(s): ${result.installed.join(", ")}`,
      ),
    );
  } else {
    console.log(c.success("Installed skills are already up to date."));
  }
  // The named skills are the caller's actual question ("is my workflow ready?")
  // — answer it explicitly, whatever the install had to do.
  if (requested.length) console.log(c.success(`◇ Ready: ${requested.join(", ")}`));
}

/**
 * Failure line for `skills update`. In --json mode the failure must land on
 * stdout as JSON (an agent piping to a parser gets structure, not clack
 * prose); the human path keeps the clack error.
 */
function reportUpdateFailure(message: string, json: boolean): void {
  if (json) {
    console.log(JSON.stringify(withMeta({ error: message }), null, 2));
    return;
  }
  clack.log.error(c.error(message));
}

const updateCommand = defineCommand({
  meta: {
    name: "update",
    description:
      "Update the core set plus every installed bundled skill to the bundled version, and remove any no longer bundled. Pass skill names to also install those (how workflow skills install on demand) — without names it never expands a partial install",
  },
  args: {
    json: { type: "boolean", description: "Output as JSON", default: false },
    dir: {
      type: "string",
      description: "Skills dir to install into (default: auto-detect, else the global store)",
    },
    source: {
      type: "string",
      description: "Local path to a manifest file or repo root (default: bundled skills)",
    },
  },
  run({ args }) {
    const dir = args.dir;
    const source = args.source;

    // Positional skill names (e.g. `hyperframes skills update pr-to-video`) are
    // the ONLY way update expands an install: each named skill is guaranteed
    // present and current. This is the router's trigger-time step — the
    // /hyperframes router runs it after picking a workflow, before reading the
    // workflow's skill.
    const { requested, rejected } = requestedNamesFrom(args._ ?? []);
    if (rejected.length) {
      reportUpdateFailure(`Invalid skill name(s): ${rejected.join(", ")}`, args.json === true);
      setCommandExitCode(1);
      return;
    }

    // Targeted, not full-set: refresh the core set (entry router + shared
    // domain skills) plus whatever is already installed, plus anything named
    // above. Without names a deliberate partial install stays partial
    // (refreshed, but never expanded) — the end-user workflow skills install
    // on demand, when their workflow is triggered.
    //
    // strict: this is the documented recovery path for the agent/CI contract
    // `hyperframes skills check || hyperframes skills update`, and the router's
    // trigger-time guarantee. If the install fails (a named skill still absent
    // afterwards) it must exit non-zero too — otherwise the `||` chain passes
    // while nothing actually changed.
    try {
      const result = updateSkills({ requested, refreshInstalled: true, strict: true, dir });
      reportUpdate(result, requested, args.json === true);
    } catch (err) {
      reportUpdateFailure(`Update failed: ${(err as Error).message}`, args.json === true);
      setCommandExitCode(1);
      return;
    }

    // Local installs never delete, so a skill renamed or dropped from the
    // bundle would linger forever. Prune skills the located install still
    // carries that the bundled manifest no longer ships, so `check || update`
    // fully reconciles the install to the bundle. Only manifest-unlisted names
    // under the located root are removed — never a user's own skills elsewhere.
    try {
      const { skills, location } = checkSkills({ dir, source });
      const removed = skills.filter((s) => s.status === "removed").map((s) => s.name);
      if (removed.length && location) {
        console.log();
        console.log(
          c.dim(`Removing ${removed.length} skill(s) no longer bundled: ${removed.join(", ")}`),
        );
        for (const name of removed) {
          if (!PLAIN_SKILL_NAME.test(name)) {
            clack.log.warn(c.warn(`Skipping unexpected skill name(s): ${name}`));
            continue;
          }
          rmSync(join(location, name), { recursive: true, force: true });
        }
      }
    } catch (err) {
      clack.log.warn(c.warn(`Skipped removed-skill cleanup: ${(err as Error).message}`));
    }
  },
});

// ── validate ─────────────────────────────────────────────────────────────────

/**
 * Validate bundled skills: every bundle must hash cleanly and match the
 * bundled manifest. Reads only local files — no network.
 */
function validateBundled(): { ok: boolean; errors: string[] } {
  const root = bundledSkillsRoot();
  if (!root) return { ok: false, errors: ["No bundled skills found"] };
  const errors: string[] = [];
  let manifest: SkillsManifest;
  try {
    manifest = resolveBundledManifest();
  } catch (err) {
    return { ok: false, errors: [(err as Error).message] };
  }
  for (const name of Object.keys(manifest.skills).sort()) {
    const dir = join(root, name);
    if (!existsSync(join(dir, "SKILL.md"))) {
      errors.push(`${name}: missing SKILL.md in bundled tree`);
      continue;
    }
    try {
      const entry = hashSkillBundle(dir);
      const latest = manifest.skills[name];
      if (latest && entry.hash !== latest.hash) {
        errors.push(`${name}: content drift vs bundled manifest (run gen:skills-manifest)`);
      }
    } catch (err) {
      errors.push(`${name}: ${(err as Error).message}`);
    }
  }
  return { ok: errors.length === 0, errors };
}

const validateCommand = defineCommand({
  meta: { name: "validate", description: "Validate bundled skills against the bundled manifest" },
  args: {
    json: { type: "boolean", description: "Output as JSON", default: false },
  },
  run({ args }) {
    const result = validateBundled();
    if (args.json) console.log(JSON.stringify(withMeta(result), null, 2));
    else if (result.ok) console.log(c.success("All bundled skills validate."));
    else {
      for (const e of result.errors) clack.log.error(c.error(e));
      setCommandExitCode(1);
    }
  },
});

export default defineCommand({
  meta: {
    name: "skills",
    description: "Install, check, and update bundled skills for AI coding tools",
  },
  subCommands: {
    check: checkCommand,
    update: updateCommand,
    validate: validateCommand,
  },
  args: {},
  run({ args }) {
    // citty runs this parent handler even when a subcommand matches; guard on
    // the positional so bare `hyperframes skills` installs, while
    // `hyperframes skills check|update|validate` does not also re-install.
    if (!args._?.[0]) {
      try {
        const result = updateSkills({ all: true, home: process.env["HOME"] });
        reportUpdate(result, [], false);
      } catch (err) {
        reportUpdateFailure(`Update failed: ${(err as Error).message}`, false);
        setCommandExitCode(1);
      }
    }
  },
});
