import { defineCommand } from "citty";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { finishCommand } from "../utils/commandResult.js";
import { selfInvocation } from "../server/cliChild.js";

const MEDIA_USE_ARGS = {
  type: { type: "string" },
  intent: { type: "string" },
  entity: { type: "string" },
  project: { type: "string", alias: "p" },
  adopt: { type: "boolean" },
  candidates: { type: "boolean" },
  doctor: { type: "boolean" },
  stats: { type: "boolean" },
  days: { type: "string" },
  "dry-run": { type: "boolean" },
  reuse: { type: "string" },
  from: { type: "string" },
  params: { type: "string" },
  for: { type: "string" },
  analyze: { type: "boolean" },
  "local-only": { type: "boolean" },
  provider: { type: "string" },
  "avatar-id": { type: "string" },
  "voice-id": { type: "string" },
  json: { type: "boolean" },
  help: { type: "boolean", alias: "h" },
} as const;

export const MEDIA_USE_VERBS = [
  "resolve",
  "doctor",
  "stats",
  "adopt",
  "candidates",
  "reuse",
  "from",
  "params",
  "analyze",
] as const;
export type MediaUseVerb = (typeof MEDIA_USE_VERBS)[number];

export function resolveMediaUseEnginePath(
  here: string,
  fileExists: (path: string) => boolean = existsSync,
): string {
  // Prefer the real engine (`dist/media-use/` in the built CLI,
  // `src/media-use/` in dev) over the skill-tree shim
  // (`skills/media-use/scripts/resolve.mjs`), which just re-spawns the CLI
  // and breaks out of dist (it resolves the repo root, not the CLI root).
  const candidates = [
    join(here, "..", "media-use", "resolve.mjs"),
    join(here, "media-use", "resolve.mjs"),
    join(here, "skills", "media-use", "scripts", "resolve.mjs"),
  ];
  const engine = candidates.find((candidate) => fileExists(candidate));
  if (!engine) {
    throw new Error(
      "media-use engine is missing from this CLI build; reinstall the CLI or run from a source checkout",
    );
  }
  return engine;
}

export function mediaUsePassthroughArgs(argv: readonly string[]): string[] {
  const commandIndex = argv.indexOf("media-use");
  return argv.slice(commandIndex + 2);
}

/**
 * Hands the engine this CLI's own invocation (runtime flags, then the CLI entry) so it can run
 * `tts` and friends without a `hyperframes` binary on PATH, which neither the packaged app nor a
 * source checkout provides. The engine runs under `process.execPath`, so only the prefix travels.
 */
export function mediaUseEngineEnv(
  base: NodeJS.ProcessEnv = process.env,
  invocation: () => { prefix: string[] } = selfInvocation,
): NodeJS.ProcessEnv {
  try {
    return { ...base, HYPERFRAMES_CLI_INVOCATION: JSON.stringify(invocation().prefix) };
  } catch {
    return base;
  }
}

export function mediaUseVerbFlags(verb: MediaUseVerb): string[] {
  return verb === "resolve" ? [] : [`--${verb}`];
}

type InvokeMediaUse = (verb: MediaUseVerb) => never;

function invokeEngine(verb: MediaUseVerb): never {
  const here = dirname(fileURLToPath(import.meta.url));
  const passed = mediaUsePassthroughArgs(process.argv);
  const flag = mediaUseVerbFlags(verb);
  const result = spawnSync(
    process.execPath,
    [resolveMediaUseEnginePath(here), ...flag, ...passed],
    {
      stdio: "inherit",
      env: mediaUseEngineEnv(),
    },
  );
  if (result.error) throw result.error;
  finishCommand(result.status ?? 1);
}

function subcommand(name: MediaUseVerb, invoke: InvokeMediaUse) {
  return defineCommand({
    meta: { name, description: `media-use ${name}` },
    args: MEDIA_USE_ARGS,
    run: () => invoke(name),
  });
}

export function createMediaUseCommand(invoke: InvokeMediaUse = invokeEngine) {
  const subCommands = Object.fromEntries(
    MEDIA_USE_VERBS.map((name) => [name, () => subcommand(name, invoke)]),
  );
  return defineCommand({
    meta: { name: "media-use", description: "Resolve and operate on project media" },
    subCommands,
    run: () => console.log("Run `hyperframes media-use <resolve|doctor|stats|...> --help`"),
  });
}

export default createMediaUseCommand();
