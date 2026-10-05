#!/usr/bin/env node

// ── EPIPE suppression (must run before ANY stdout/stderr write) ────────────
// When the CLI runs inside a piped agent environment (Claude Code, Codex,
// Cursor, etc.), the reader may close the pipe before we finish writing.
// Node treats EPIPE on stdout/stderr as an uncaughtException, which crashes
// the process. This is a normal lifecycle event — suppress it.
//
// commandFailed must be declared here (before the handlers) so the EPIPE
// stream-error path can set it before process.exit(0). The root exit handler
// reads this flag to determine success/failure — an EPIPE that
// interrupts a command should NOT score as success:true, but one that
// arrives after the render artifact was validated is the normal agent-pipe
// teardown and must stay success:true (see handleStreamEpipe).
let commandFailed = false;

for (const stream of [process.stdout, process.stderr]) {
  stream.on("error", (err) => {
    if ((err as NodeJS.ErrnoException).code === "EPIPE") {
      handleStreamEpipe();
    }
  });
}
completeConsoleOutputUnderBun();

// ── Worker entry path bootstrap (must run before any producer/engine load) ──
// The shaderTransitionWorkerPool lives in the producer package and resolves
// its worker entry by probing for a sibling `.js` file next to
// `import.meta.url`. When this CLI is bundled by tsup, the producer code is
// inlined into `cli.js`, but `import.meta.url` resolves to the producer's
// own dist path (NOT cli.js) on some module-graph layouts — so the sibling
// probe lands in a directory that does not contain the bundled worker.
// We emit the worker entry next to cli.js (see tsup.config.ts) and tell
// the pool where to find it via the published env-var override.
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";

(() => {
  const here = dirname(fileURLToPath(import.meta.url));
  const shader = join(here, "shaderTransitionWorker.js");
  if (!process.env.HF_SHADER_WORKER_ENTRY && existsSync(shader)) {
    process.env.HF_SHADER_WORKER_ENTRY = shader;
  }
})();

// ── Fast-path exits ─────────────────────────────────────────────────────────
// Check --version before importing anything heavy. This makes
// `hyperframes --version` near-instant (~10ms vs ~80ms).
import { completeConsoleOutputUnderBun, flushStdio } from "./utils/bunStdio.js";
import { VERSION } from "./version.js";

const argv = process.argv.slice(2);
const commandArg = argv[0];
const rootVersionRequested =
  commandArg === "--version" ||
  commandArg === "-V" ||
  (commandArg === undefined && (argv.includes("--version") || argv.includes("-V")));

if (rootVersionRequested) {
  console.log(VERSION);
  process.exit(0);
}

// ── Load .env from CWD ─────────────────────────────────────────────────────
// Agents run from the project directory where .env holds API keys (Gemini,
// HeyGen, ElevenLabs). Load it automatically so they don't need `source .env`.
try {
  const { readFileSync } = await import("node:fs");
  const { resolve } = await import("node:path");
  const envPath = resolve(process.cwd(), ".env");
  const envContent = readFileSync(envPath, "utf-8");
  for (const rawLine of envContent.split("\n")) {
    let line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    // Tolerate `export FOO=bar` (common in dotfile-style .env files).
    if (line.startsWith("export ")) line = line.slice(7).trim();
    const eqIdx = line.indexOf("=");
    if (eqIdx < 1) continue;
    const key = line.slice(0, eqIdx).trim();
    let val = line.slice(eqIdx + 1).trim();
    if (val.startsWith('"') || val.startsWith("'")) {
      // Quoted value: take until the matching closing quote; leave the rest.
      // Anything after a closing quote (including `# comment`) is dropped.
      const quote = val.charAt(0);
      const end = val.indexOf(quote, 1);
      if (end > 0) val = val.slice(1, end);
      else val = val.slice(1); // unterminated quote — best-effort, strip opener
    } else {
      // Unquoted value: strip inline `# comment` (requires whitespace before #
      // to avoid eating `pass#word` style values).
      const commentMatch = val.match(/\s+#/);
      if (commentMatch?.index !== undefined) val = val.slice(0, commentMatch.index).trim();
    }
    if (key && !(key in process.env)) process.env[key] = val;
  }
} catch {
  /* .env not present — fine, env vars may be set another way */
}

// ── Lazy imports ────────────────────────────────────────────────────────────
// Heavy modules are imported only when needed.

import { defineCommand, runCommand } from "citty";
import type { ArgsDef, CommandDef } from "citty";
import { guardUnknownFlags } from "./utils/flagGuard.js";
import { isRenderSucceeded } from "./utils/render-success-state.js";
import { resolveCommandUsage } from "./utils/commandUsageResolution.js";
import { isDevMode } from "./utils/env.js";
import {
  CliResultSignal,
  CliRuntimeError,
  CliUsageError,
  consumeCommandResult,
  registerRootExitCodeSanitizer,
  registerRootExitRequester,
  type CommandResult,
} from "./utils/commandResult.js";

const isHelp = process.argv.includes("--help") || process.argv.includes("-h");

// Runs before commands/preview.js is imported, so a missing or stale
// package is named here instead of crashing deep inside that import.
async function assertStudioWorkspaceBuilt(): Promise<void> {
  if (!isDevMode()) return;
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
  const { checkStudioWorkspaceBuild, formatWorkspaceBuildProblems } =
    await import("./utils/workspaceBuildCheck.js");
  const problems = checkStudioWorkspaceBuild(repoRoot);
  if (problems.length === 0) return;
  console.error(formatWorkspaceBuildProblems(problems));
  throw new CliRuntimeError("Studio workspace build check failed", {
    exitCode: 1,
    presented: true,
  });
}

// ---------------------------------------------------------------------------
// CLI definition — all commands are lazy-loaded via dynamic import()
// ---------------------------------------------------------------------------

const commandLoaders = {
  init: () => import("./commands/init.js").then((m) => m.default),
  add: () => import("./commands/add.js").then((m) => m.default),
  catalog: () => import("./commands/catalog.js").then((m) => m.default),
  "media-use": () => import("./commands/media-use.js").then((m) => m.default),
  play: () => import("./commands/play.js").then((m) => m.default),
  present: () => import("./commands/present.js").then((m) => m.default),
  preview: () =>
    assertStudioWorkspaceBuilt().then(() => import("./commands/preview.js").then((m) => m.default)),
  render: () => import("./commands/render.js").then((m) => m.default),
  lint: () => import("./commands/lint.js").then((m) => m.default),
  check: () => import("./commands/check.js").then((m) => m.default),
  beats: () => import("./commands/beats.js").then((m) => m.default),
  "normalize-audio": () => import("./commands/normalize-audio.js").then((m) => m.default),
  inspect: () => import("./commands/inspect.js").then((m) => m.default),
  keyframes: () => import("./commands/keyframes.js").then((m) => m.default),
  layout: () => import("./commands/layout.js").then((m) => m.default),
  info: () => import("./commands/info.js").then((m) => m.default),
  compositions: () => import("./commands/compositions.js").then((m) => m.default),
  timeline: () => import("./commands/timeline.js").then((m) => m.default),
  history: () => import("./commands/history.js").then((m) => m.default),
  benchmark: () => import("./commands/benchmark.js").then((m) => m.default),
  browser: () => import("./commands/browser.js").then((m) => m.default),
  "remove-background": () => import("./commands/remove-background.js").then((m) => m.default),
  transcribe: () => import("./commands/transcribe.js").then((m) => m.default),
  diarize: () => import("./commands/diarize.js").then((m) => m.default),
  "inspect-site": () => import("./commands/inspect-site.js").then((m) => m.default),
  "record-site": () => import("./commands/record-site.js").then((m) => m.default),
  frames: () => import("./commands/frames.js").then((m) => m.default),
  models: () => import("./commands/models.js").then((m) => m.default),
  tts: () => import("./commands/tts.js").then((m) => m.default),
  docs: () => import("./commands/docs.js").then((m) => m.default),
  doctor: () => import("./commands/doctor.js").then((m) => m.default),
  skills: () => import("./commands/skills.js").then((m) => m.default),
  validate: () => import("./commands/validate.js").then((m) => m.default),
  snapshot: () => import("./commands/snapshot.js").then((m) => m.default),
  "media-treatment": () =>
    import("./commands/media-treatment.js").then((m) => m.mediaTreatmentCommand),
  "grade-compare": () => import("./commands/grade-compare.js").then((m) => m.default),
  compare: () => import("./commands/compare.js").then((m) => m.default),
  capture: () => import("./commands/capture.js").then((m) => m.default),
  figma: () => import("./commands/figma.js").then((m) => m.default),
};

const subCommands = Object.fromEntries(
  Object.entries(commandLoaders).map(([name, load]) => [name, guardUnknownFlags(load)]),
);

const main = defineCommand({
  meta: {
    name: "hyperframes",
    version: VERSION,
    description: "Create and render HTML video compositions",
  },
  subCommands,
});

// ---------------------------------------------------------------------------
// Root lifecycle — exit code only. The CLI is fully local and
// offline-capable, so every invocation runs exactly the requested command.
// ---------------------------------------------------------------------------

const cliCommandArg = process.argv[2];
// Explicit annotation breaks a type cycle: `subCommands` references `command`
// (in the failure reporter) and `command` references `subCommands` (the `in`
// check), so its type can't be inferred from its own initializer.
const command: string = cliCommandArg && cliCommandArg in subCommands ? cliCommandArg : "unknown";

let finalized = false;

// Root-only lifecycle fan-in: exit code, then done.
async function finalizeCli(result: CommandResult): Promise<void> {
  if (finalized) return;
  finalized = true;
  // Once the artifact has validated and been committed to disk, the run
  // delivered — anything recorded as a failure after that is teardown noise.
  // The uncaughtException / unhandledRejection handlers already consult
  // isRenderSucceeded(), but a post-render throw that the command wrapper
  // CATCHES never reaches them: it becomes an ordinary non-zero
  // CommandResult, and a valid render is reported as a failure. Sanitizing
  // here, once, is what those handlers cannot cover.
  const exitCode = isRenderSucceeded() ? 0 : result.exitCode;
  commandFailed ||= exitCode !== 0;
  process.exitCode = exitCode;
}

registerRootExitRequester((exitCode) => {
  void finalizeCli({
    exitCode,
    kind: exitCode === 0 ? "success" : "runtime_error",
    presented: true,
  })
    .then(flushStdio)
    .finally(() => process.exit(exitCode));
});

registerRootExitCodeSanitizer(() => {
  if (process.exitCode !== undefined && process.exitCode !== 0) {
    process.exitCode = 0;
  }
});

// Handle a post-artifact-validated throw: record the diagnostic, but do NOT
// mark the run as failed. The render is valid — a worker teardown / browser
// shutdown / stray subprocess stream error after `renderSucceeded` was set
// must not flip the exit code to failure.
function reportPostRenderTerminationEvent(label: "uncaughtException" | "unhandledRejection"): void {
  process.stderr.write(`  [hyperframes] Post-render ${label} (render already succeeded)\n`);
}

// Terminate the process after a post-artifact-validated throw. Wraps
// report + exit(0) so the caller arrow handler stays linear.
function exitAfterPostRenderTermination(label: "uncaughtException" | "unhandledRejection"): never {
  reportPostRenderTerminationEvent(label);
  process.exit(0);
}

// A closed pipe (EPIPE) is the NORMAL teardown when the CLI runs under a
// piped agent (Claude Code, Codex, …) — the reader may stop consuming as
// soon as it has what it needs. Exit cleanly, but only score the run as a
// failure when the pipe died BEFORE the render artifact was validated:
// unconditionally setting `commandFailed = true` here marked every piped
// successful render as a failure (0.7.65–0.7.90).
function handleStreamEpipe(): never {
  if (!isRenderSucceeded()) commandFailed = true;
  process.exit(0);
}

// Terminate the process after a genuine CLI failure — mark commandFailed,
// exit(1). Same rationale as above: keeps the arrow handler linear.
function exitAfterCliFailure(): never {
  commandFailed = true;
  process.exit(1);
}

process.on("uncaughtException", (error) => {
  if ((error as NodeJS.ErrnoException).code === "EPIPE") {
    handleStreamEpipe();
  }
  // Post-artifact-validated shutdown throws must not turn a valid render
  // into an exit-1 "no final error message" failure. The render command
  // sets `renderSucceeded` right after the producer resolves and the
  // artifact is committed.
  if (isRenderSucceeded()) {
    exitAfterPostRenderTermination("uncaughtException");
  }
  exitAfterCliFailure();
});

// unhandledRejection does not call process.exit() — Node may continue
// running if the rejection is non-fatal (e.g. a fire-and-forget promise).
process.on("unhandledRejection", (reason) => {
  const error = reason instanceof Error ? reason : new Error(String(reason));
  void error;
  // Same rationale as the uncaughtException branch above: a stray promise
  // rejection during post-artifact-validated cleanup must not mark a valid
  // render as failed. `commandFailed` only scores the exit code — keep it
  // false when the render actually succeeded.
  if (isRenderSucceeded()) {
    reportPostRenderTerminationEvent("unhandledRejection");
    return;
  }
  commandFailed = true;
  process.exitCode = 1;
});

// Lazy-load help renderer — avoids allocating help data on non-help invocations
async function showUsage<T extends ArgsDef>(
  cmd: CommandDef<T>,
  parent?: CommandDef<T>,
): Promise<void> {
  const { showUsage: impl } = await import("./help.js");
  return impl(cmd as CommandDef, parent as CommandDef | undefined);
}

async function showRequestedUsage(): Promise<void> {
  const requested = await resolveCommandUsage(main as CommandDef, argv);
  return showUsage(requested.command, requested.parent);
}

function commandResultForError(error: unknown): CommandResult {
  if (error instanceof CliResultSignal) return error.result;
  if (error instanceof CliUsageError || error instanceof CliRuntimeError) return error.result;
  return { exitCode: 1, kind: "runtime_error" };
}

// Root-only command boundary; keeping every result path here prevents modules
// from bypassing output or finalizers.
async function executeCli(): Promise<void> {
  let result: CommandResult = { exitCode: 0, kind: "success" };
  try {
    if (isHelp) await showRequestedUsage();
    else await runCommand(main, { rawArgs: argv });
  } catch (error) {
    result = commandResultForError(error);
    if (!(error instanceof CliResultSignal)) {
      commandFailed = true;
      void command;
      const typed = error instanceof CliUsageError || error instanceof CliRuntimeError;
      if (error instanceof CliUsageError && !error.result.presented) await showRequestedUsage();
      if (!typed || !error.result.presented) {
        console.error(error instanceof Error ? error.message : String(error));
      }
    }
  } finally {
    const pending = consumeCommandResult();
    if (pending.exitCode !== 0 || result.exitCode === 0) result = pending;
    await finalizeCli(result);
  }
}

await executeCli();
