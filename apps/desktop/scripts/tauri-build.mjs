#!/usr/bin/env bun
/**
 * `tauri build` for the desktop app, with one twist around updater artifacts.
 *
 * `bundle.createUpdaterArtifacts` is true in `src-tauri/tauri.conf.json`, and with it the Tauri
 * CLI fails the build when `TAURI_SIGNING_PRIVATE_KEY` is missing. Local builds without the key
 * therefore turn updater artifacts off with an extra `--config` (the CLI merges configs in order,
 * so the last one wins). A release build — `OPENVIDS_RELEASE=1`, set by the release workflow —
 * fails loudly instead: shipping without updater artifacts would strand installed apps on the
 * previous version.
 *
 * All arguments are forwarded to `tauri build` after the `--config` flags, so an explicit
 * `--config` from the caller still overrides both.
 *
 * Usage: bun scripts/tauri-build.mjs [extra tauri build args]
 */

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

const appDir = join(import.meta.dirname, "..");
const repoRoot = join(appDir, "..", "..");

const tauriBin = [
  join(repoRoot, "node_modules", ".bin", "tauri"),
  join(appDir, "node_modules", ".bin", "tauri"),
].find((candidate) => existsSync(candidate));
if (tauriBin === undefined) {
  console.error("[desktop-build] the tauri CLI is not installed; run `bun install` first");
  process.exit(1);
}

const args = ["build", "--config", "src-tauri/tauri.prod.conf.json"];

const signingKey = (process.env.TAURI_SIGNING_PRIVATE_KEY ?? "").trim();
if (signingKey === "") {
  if (process.env.OPENVIDS_RELEASE === "1") {
    console.error(
      "[desktop-build] TAURI_SIGNING_PRIVATE_KEY is required for a release build (OPENVIDS_RELEASE=1); " +
        "set the updater signing key and its password, or build locally without OPENVIDS_RELEASE",
    );
    process.exit(1);
  }
  args.push("--config", JSON.stringify({ bundle: { createUpdaterArtifacts: false } }));
  console.log(
    "[desktop-build] TAURI_SIGNING_PRIVATE_KEY is not set: updater artifacts (OpenVids.app.tar.gz and its .sig) are skipped for this local build",
  );
}

args.push(...process.argv.slice(2));

const result = spawnSync(tauriBin, args, { cwd: appDir, stdio: "inherit", env: process.env });
if (result.error !== undefined) {
  console.error(`[desktop-build] could not run ${tauriBin}: ${result.error.message}`);
  process.exit(1);
}
process.exit(result.status ?? 1);
