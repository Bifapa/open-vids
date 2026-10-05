#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(fileURLToPath(new URL("../../../", import.meta.url)));
const dist = join(root, "packages/cli/dist/cli.js");
const source = join(root, "packages/cli/src/cli.ts");
const forwarded = ["media-use", "resolve", ...process.argv.slice(2)];

// Monorepo checkout: run its own CLI. Standalone global skill installs have no
// packages/ tree and use the OpenVids CLI `hyperframes` from PATH.
const [command, commandArgs] = existsSync(dist)
  ? [process.execPath, [dist, ...forwarded]]
  : existsSync(source)
    ? ["bun", [source, ...forwarded]]
    : ["hyperframes", forwarded];
const result = spawnSync(command, commandArgs, { stdio: "inherit" });
if (result.error?.code === "ENOENT" && command === "hyperframes") {
  console.error(
    "The OpenVids CLI `hyperframes` was not found on PATH. Link it first (for example `bun link` in packages/cli).",
  );
} else if (result.error) {
  console.error(result.error.message);
}
process.exit(result.status ?? 1);
