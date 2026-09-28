#!/usr/bin/env node
/**
 * Assemble the production sidecar payload under `apps/desktop/runtime/`.
 *
 * Tauri bundles this directory as app resources. Two pieces end up inside the
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

// ── 3. The JS runtime ───────────────────────────────────────────────────────

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

// ── 4. Manifest the Rust side reads at startup ──────────────────────────────

writeFileSync(
  join(RUNTIME, "runtime.json"),
  `${JSON.stringify(
    {
      bun: "bun",
      hyperframes: "hyperframes",
      cli: join("hyperframes", "cli.js"),
      studioIndex: join("hyperframes", "studio", "index.html"),
      version: cliPkg.version,
    },
    null,
    2,
  )}\n`,
);

log(`runtime ready at ${RUNTIME}`);
