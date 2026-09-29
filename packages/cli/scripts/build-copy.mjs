// Cross-platform replacement for the previous `mkdir -p … && cp -r …` shell
// chain, which failed on Windows because `cp` doesn't accept `-r` there.

import { cpSync, existsSync, mkdirSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI_ROOT = resolve(HERE, "..");
const REPO_ROOT = resolve(CLI_ROOT, "..", "..");
const DIST = join(CLI_ROOT, "dist");

// Studio's vite build clears its dist before rewriting it; don't start the
// copy until both sentinels are present so we never observe a partial tree.
const STUDIO_WAIT_TIMEOUT_MS = 30_000;
const STUDIO_POLL_INTERVAL_MS = 250;

async function waitForStudioDist(dir) {
  const deadline = Date.now() + STUDIO_WAIT_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      const entries = new Set(readdirSync(dir));
      // vite emits `assets/` before rewriting `index.html` at the end of the
      // build — so once both are present, the tree is complete.
      if (entries.has("index.html") && entries.has("assets")) return;
    } catch {
      // dir doesn't exist yet — vite will create it
    }
    await sleep(STUDIO_POLL_INTERVAL_MS);
  }
  throw new Error(`[build-copy] timed out waiting for studio dist at ${dir}`);
}

function copyDir(src, dest) {
  cpSync(src, dest, { recursive: true, force: true });
}

function copyDirContents(src, dest) {
  for (const entry of readdirSync(src)) {
    cpSync(join(src, entry), join(dest, entry), {
      recursive: true,
      force: true,
    });
  }
}

function copyMdFiles(srcDir, destDir) {
  if (!existsSync(srcDir)) return;
  for (const name of readdirSync(srcDir)) {
    if (name.endsWith(".md")) {
      cpSync(join(srcDir, name), join(destDir, name));
    }
  }
}

async function main() {
  for (const sub of ["studio", "docs", "templates", "skills"]) {
    mkdirSync(join(DIST, sub), { recursive: true });
  }
  mkdirSync(join(DIST, "commands"), { recursive: true });

  const studioDist = resolve(CLI_ROOT, "..", "studio", "dist");
  await waitForStudioDist(studioDist);
  copyDirContents(studioDist, join(DIST, "studio"));

  for (const tmpl of ["blank", "from-file", "_shared"]) {
    copyDir(join(CLI_ROOT, "src", "templates", tmpl), join(DIST, "templates", tmpl));
  }

  // Bundle warm-grain from the repo registry so the built CLI can scaffold it
  // offline and CI smoke tests pick up PR-branch changes before merge to main.
  const warmGrainSrc = join(REPO_ROOT, "registry", "examples", "warm-grain");
  if (existsSync(warmGrainSrc)) {
    copyDir(warmGrainSrc, join(DIST, "templates", "warm-grain"));
  }

  // Bundle the local registry tree (manifests + item files + vector
  // artifacts) so the built CLI resolves everything offline via
  // localRegistryRoot(): dist/registry sits beside cli.js, which is exactly
  // where the resolver looks. Text-only: remotely-hosted `file.url` assets
  // have no local bytes by definition and fail at install with a clear error.
  {
    const src = join(REPO_ROOT, "registry");
    const dest = join(DIST, "registry");
    rmSync(dest, { recursive: true, force: true });
    mkdirSync(dest, { recursive: true });
    copyDirContents(src, dest);
  }

  // Skills bundled into the built CLI. The whole `skills/` tree is the source
  // of truth (see skills-manifest.json + bundledSkillsRoot()), so copy it in
  // full: the previous allowlist (hyperframes, hyperframes-cli, media-use,
  // …) silently dropped every workflow skill and broke `skills list` offline.
  // Directory entries that are not skill bundles (e.g. stray test files at
  // the tree root) are skipped. `skills-manifest.json` rides alongside so the
  // staged desktop runtime (which copies dist wholesale) resolves the same
  // manifest without a repo checkout.
  {
    const skillsSrc = join(REPO_ROOT, "skills");
    const skillsDest = join(DIST, "skills");
    rmSync(skillsDest, { recursive: true, force: true });
    mkdirSync(skillsDest, { recursive: true });
    for (const entry of readdirSync(skillsSrc)) {
      const src = join(skillsSrc, entry);
      if (!existsSync(join(src, "SKILL.md"))) continue;
      copyDir(src, join(skillsDest, entry));
    }
    const manifestSrc = join(REPO_ROOT, "skills-manifest.json");
    if (existsSync(manifestSrc)) {
      cpSync(manifestSrc, join(DIST, "skills-manifest.json"));
    } else {
      console.warn("[build-copy] skills-manifest.json not found, skipping");
    }
  }

  // The media-use engine runs from source (`src/media-use/`) in dev, but the
  // bundled CLI is flat (`dist/cli.js`) so `dist/media-use/` does not exist.
  // Ship the full engine tree at `dist/media-use/` — the first candidate
  // resolveMediaUseEnginePath() probes — so `media-use resolve` works from
  // the staged desktop runtime without a repo checkout. The engine imports
  // `../audio/scripts/lib/*`, so ship that tree too (same relative layout).
  {
    const mediaSrc = join(CLI_ROOT, "src", "media-use");
    const mediaDest = join(DIST, "media-use");
    rmSync(mediaDest, { recursive: true, force: true });
    mkdirSync(mediaDest, { recursive: true });
    copyDirContents(mediaSrc, mediaDest);
    // `src/audio/scripts` is a symlink into `skills/media-use/audio/scripts`
    // and cpSync copies the link itself — so copy the real trees explicitly
    // (top-level files via the src dir, scripts via realpath), otherwise
    // `dist/audio/scripts/lib/*.mjs` never lands.
    const audioSrc = join(CLI_ROOT, "src", "audio");
    const audioDest = join(DIST, "audio");
    rmSync(audioDest, { recursive: true, force: true });
    mkdirSync(audioDest, { recursive: true });
    copyDirContents(audioSrc, audioDest);
    rmSync(join(audioDest, "scripts"), { recursive: true, force: true });
    copyDir(realpathSync(join(audioSrc, "scripts")), join(audioDest, "scripts"));
    // The audio helpers import `../../../scripts/lib/*` — resolved from the
    // real skill tree (`skills/media-use/audio/scripts/lib` → up three to
    // `skills/media-use/scripts/lib`). Mirror that layout in dist so the
    // same relative import resolves without a repo checkout.
    const skillScriptsSrc = join(REPO_ROOT, "skills", "media-use", "scripts");
    const skillScriptsDest = join(DIST, "scripts");
    rmSync(skillScriptsDest, { recursive: true, force: true });
    mkdirSync(skillScriptsDest, { recursive: true });
    copyDirContents(skillScriptsSrc, skillScriptsDest);
  }

  const layoutAuditScript = join(CLI_ROOT, "src", "commands", "layout-audit.browser.js");
  if (existsSync(layoutAuditScript)) {
    cpSync(layoutAuditScript, join(DIST, "commands", "layout-audit.browser.js"));
  }

  const contrastAuditScript = join(CLI_ROOT, "src", "commands", "contrast-audit.browser.js");
  if (existsSync(contrastAuditScript)) {
    cpSync(contrastAuditScript, join(DIST, "commands", "contrast-audit.browser.js"));
  }

  const motionSampleScript = join(CLI_ROOT, "src", "commands", "motion-sample.browser.js");
  if (existsSync(motionSampleScript)) {
    cpSync(motionSampleScript, join(DIST, "commands", "motion-sample.browser.js"));
  }

  // Player bundles for the standalone browser player used by `present` and
  // `play`. resolvePlayerPath/resolveSlideshowPath look for these alongside the
  // built CLI (dist/<name>.global.js), so they must ship in the package — the
  // monorepo-dev fallback paths don't exist once installed from npm. Without
  // this, `npx hyperframes present` fails with "@hyperframes/player not found".
  const playerDist = join(REPO_ROOT, "packages", "player", "dist");
  const playerGlobals = [
    [join(playerDist, "hyperframes-player.global.js"), join(DIST, "hyperframes-player.global.js")],
    [
      join(playerDist, "slideshow", "hyperframes-slideshow.global.js"),
      join(DIST, "hyperframes-slideshow.global.js"),
    ],
  ];
  for (const [src, dest] of playerGlobals) {
    if (existsSync(src)) {
      cpSync(src, dest);
    } else {
      console.warn(`[build-copy] player bundle not found, skipping: ${src}`);
    }
  }

  copyMdFiles(join(CLI_ROOT, "src", "docs"), join(DIST, "docs"));

  console.log("[build-copy] done");
}

await main();
