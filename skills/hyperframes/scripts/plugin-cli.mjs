#!/usr/bin/env node
// Launcher for the OpenVids CLI: runs the bare `hyperframes` command resolved
// from PATH (no package-manager download), or a Node script with the same
// skill-friendly environment via `--script`.
import { spawnSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";

export function invocation(args, { env = process.env, node = process.execPath } = {}) {
  if (args[0] === "skills")
    throw new Error(
      "Update HyperFrames through your agent's plugin manager; bundled skills are release-managed.",
    );
  const childEnv = {
    ...env,
    HYPERFRAMES_SKIP_SKILLS: "1",
    HYPERFRAMES_NO_UPDATE_CHECK: "1",
  };
  if (args[0] === "--script") {
    if (!args[1]) throw new Error("--script requires a Node script path.");
    return { command: node, args: args.slice(1), env: childEnv };
  }
  return { command: "hyperframes", args, env: childEnv };
}

if (process.argv[1] && pathToFileURL(realpathSync(process.argv[1])).href === import.meta.url) {
  try {
    const command = invocation(process.argv.slice(2));
    const result = spawnSync(command.command, command.args, {
      env: command.env,
      stdio: "inherit",
      windowsHide: true,
    });
    if (result.error?.code === "ENOENT" && command.command === "hyperframes") {
      throw new Error(
        "The OpenVids CLI `hyperframes` was not found on PATH. Link it first (for example `bun link` in packages/cli).",
      );
    }
    if (result.error) throw result.error;
    process.exitCode = result.status ?? 1;
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
