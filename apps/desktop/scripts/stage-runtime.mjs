#!/usr/bin/env node
/**
 * Assemble the production sidecar payload under `apps/desktop/runtime/`.
 *
 * Tauri bundles this directory as app resources. Three pieces end up inside the
 * shipped .app:
 *
 *   runtime/hyperframes/
 *     The output of the HyperFrames build — `packages/cli/dist`, whose
 *     `dist/studio` subdirectory is the prebuilt Studio SPA. The CLI's
 *     embedded server (`createStudioServer`) serves that SPA and mounts the
 *     Studio API on the same listener, so a project directory is all it needs
 *     to run. No monorepo path survives into the bundle.
 *
 *   runtime/hyperframes/node_modules/
 *     The CLI's *published* dependencies and nothing else. `packages/cli`
 *     bundles every `@hyperframes/*` workspace package (tsup `noExternal`), so
 *     only its npm dependencies stay external at runtime. The list is derived
 *     from that package.json rather than hand-written so it cannot drift.
 *
 *   runtime/agent-runtime/
 *     The OpenVids Agent Runtime sources, its copied protocol package, and its
 *     published OMP-backed dependencies. Set OPENVIDS_SKIP_AGENT_RUNTIME=1 to
 *     omit this optional chat feature from a staging run.
 *
 * The JS runtime is `bun`, not Node: it is a single self-contained Mach-O that
 * links only against stock macOS system libraries, so it copies into a .app
 * without dragging a Homebrew Cellar of dylibs along. It is also the runtime
 * that already builds this repo, so dev and production run identical JS.
 */
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const DESKTOP = resolve(HERE, "..");
const REPO_ROOT = resolve(DESKTOP, "..", "..");

const RUNTIME = join(DESKTOP, "runtime");
const HF_DIR = join(RUNTIME, "hyperframes");
const CLI_DIST = join(REPO_ROOT, "packages", "cli", "dist");
const AGENT_RUNTIME_SOURCE = join(REPO_ROOT, "packages", "agent-runtime");
const AGENT_PROTOCOL_SOURCE = join(REPO_ROOT, "packages", "agent-protocol");
const AGENT_DIR = join(RUNTIME, "agent-runtime");

function log(message) {
  process.stderr.write(`[openvids:stage] ${message}\n`);
}

function fail(message) {
  process.stderr.write(`[openvids:stage] ${message}\n`);
  process.exit(1);
}

// ── 1. The Studio + CLI bundle ──────────────────────────────────────────────

if (!existsSync(join(CLI_DIST, "studio", "index.html"))) {
  fail(
    `HyperFrames is not built: ${join(CLI_DIST, "studio", "index.html")} is missing.\n` +
      `  Run \`bun run build\` first (\`bun run build:hyperframes\` in this package does it).`,
  );
}

rmSync(RUNTIME, { recursive: true, force: true });
mkdirSync(HF_DIR, { recursive: true });
cpSync(CLI_DIST, HF_DIR, { recursive: true, dereference: true });
log(`staged ${join(HF_DIR)}`);

// ── 2. The published runtime dependencies ───────────────────────────────────

const cliPkg = JSON.parse(readFileSync(join(REPO_ROOT, "packages", "cli", "package.json"), "utf8"));
const runtimeDeps = Object.fromEntries(
  Object.entries(cliPkg.dependencies ?? {}).filter(
    ([, range]) => !String(range).startsWith("workspace:"),
  ),
);

// A package.json named `hyperframes` beside the bundle. The render pipeline
// stamps provenance by walking up from its own module URL looking for a
// package.json whose name matches /^(?:hyperframes|@hyperframes\/[^/]+)$/; without
// this it logs "could not resolve the engine version" on every boot.
// `type: module` is load-bearing: `cli.js` is ESM and this is now the nearest
// package.json to it.
writeFileSync(
  join(HF_DIR, "package.json"),
  `${JSON.stringify(
    {
      name: "hyperframes",
      version: cliPkg.version,
      private: true,
      type: "module",
      dependencies: runtimeDeps,
    },
    null,
    2,
  )}\n`,
);

log(`installing ${Object.keys(runtimeDeps).length} runtime dependencies`);
// A fresh directory has no lockfile to freeze against. The dependency set is
// pinned by the range table generated above, which is itself derived from the
// CLI manifest rather than hand-written.
execFileSync("bun", ["install"], { cwd: HF_DIR, stdio: ["ignore", "inherit", "inherit"] });

// ── 3. The separate, optional local Agent Runtime ────────────────────────────

const agentRuntimeStaged = process.env.OPENVIDS_SKIP_AGENT_RUNTIME !== "1";
if (agentRuntimeStaged) {
  const agentRuntimePackage = JSON.parse(
    readFileSync(join(AGENT_RUNTIME_SOURCE, "package.json"), "utf8"),
  );
  const agentRuntimeDependencies = Object.fromEntries(
    Object.entries(agentRuntimePackage.dependencies ?? {}).filter(
      ([, range]) => !String(range).startsWith("workspace:"),
    ),
  );
  const protocolVendor = join(AGENT_DIR, "vendor", "agent-protocol");
  mkdirSync(AGENT_DIR, { recursive: true });
  // Tests and test fixtures import dev-only packages (vitest, studio-server) that are not staged.
  const runtimeSourceOnly = (path) =>
    !/\.test\.ts$/.test(path) && !/[\\/]testing([\\/]|$)/.test(path);
  cpSync(join(AGENT_RUNTIME_SOURCE, "src"), join(AGENT_DIR, "src"), {
    recursive: true,
    dereference: true,
    filter: runtimeSourceOnly,
  });
  writeFileSync(join(AGENT_DIR, "main.ts"), 'import "./src/main.ts";\n');
  mkdirSync(protocolVendor, { recursive: true });
  cpSync(join(AGENT_PROTOCOL_SOURCE, "package.json"), join(protocolVendor, "package.json"));
  cpSync(join(AGENT_PROTOCOL_SOURCE, "src"), join(protocolVendor, "src"), {
    recursive: true,
    dereference: true,
  });
  agentRuntimeDependencies["@hyperframes/agent-protocol"] = "file:./vendor/agent-protocol";
  writeFileSync(
    join(AGENT_DIR, "package.json"),
    `${JSON.stringify(
      {
        ...agentRuntimePackage,
        dependencies: agentRuntimeDependencies,
        devDependencies: undefined,
      },
      null,
      2,
    )}\n`,
  );
  log(`installing ${Object.keys(agentRuntimeDependencies).length} Agent Runtime dependencies`);
  execFileSync("bun", ["install"], {
    cwd: AGENT_DIR,
    stdio: ["ignore", "inherit", "inherit"],
  });
  // The Director enables no memory/voice features, but the OMP SDK declares their engines as hard
  // dependencies (~500 MB: onnxruntime, sherpa-onnx, huggingface tokenizers, an icon set). They are
  // loaded lazily, so the runtime starts and runs sessions without them (verified with the staged bun).
  for (const unused of [
    "onnxruntime-node",
    "onnxruntime-web",
    "sherpa-onnx-darwin-arm64",
    "sherpa-onnx-node",
    "@huggingface",
    "lucide-react",
  ]) {
    rmSync(join(AGENT_DIR, "node_modules", unused), { recursive: true, force: true });
  }
} else {
  mkdirSync(AGENT_DIR, { recursive: true });
  cpSync(join(AGENT_RUNTIME_SOURCE, "package.json"), join(AGENT_DIR, "package.json"));
  log("skipping Agent Runtime sources and dependencies (OPENVIDS_SKIP_AGENT_RUNTIME=1)");
}

// ── 4. The JS runtime ───────────────────────────────────────────────────────

function resolveBun() {
  if (process.versions.bun && process.execPath) return realpathSync(process.execPath);
  const found = execFileSync("which", ["bun"], { encoding: "utf8" }).trim();
  if (!found) {
    fail("bun is not on PATH; it is both this repo's package manager and the sidecar runtime");
  }
  return realpathSync(found);
}

const bunPath = resolveBun();
cpSync(bunPath, join(RUNTIME, "bun"), { dereference: true });
// 0755, not whatever the source carries. tauri-build copies resources with
// `fs::copy`, which propagates the mode and then re-copies on the next build —
// and overwriting a 0555 destination fails with EACCES on macOS, which
// surfaces as an opaque "Permission denied" from the build script.
chmodSync(join(RUNTIME, "bun"), 0o755);
log(`staged bun runtime from ${bunPath}`);
// The launcher the app spawns instead of `cli.js` directly. See its header for
// why the parent-death watch has to live in the child.
cpSync(join(DESKTOP, "sidecar", "serve.mjs"), join(RUNTIME, "serve.mjs"), { dereference: true });

// ── 5. Manifest the Rust side reads at startup ──────────────────────────────

writeFileSync(
  join(RUNTIME, "runtime.json"),
  `${JSON.stringify(
    {
      bun: "bun",
      hyperframes: "hyperframes",
      cli: join("hyperframes", "cli.js"),
      studioIndex: join("hyperframes", "studio", "index.html"),
      agentRuntime: agentRuntimeStaged ? "agent-runtime" : null,
      version: cliPkg.version,
    },
    null,
    2,
  )}\n`,
);

log(`runtime ready at ${RUNTIME}`);
