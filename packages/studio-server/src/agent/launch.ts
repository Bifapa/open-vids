import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentRuntimeLaunch } from "./gateway.js";

const require = createRequire(import.meta.url);
const moduleDir = dirname(fileURLToPath(import.meta.url));

function makeLaunch(entry: string): AgentRuntimeLaunch {
  return {
    command: process.env.OPENVIDS_AGENT_BUN || (process.versions.bun ? process.execPath : "bun"),
    args: [entry],
    cwd: dirname(entry),
  };
}

/** Locate the staged runtime first, then the workspace source runtime. */
export function resolveAgentRuntimeLaunch(
  cliFileDir: string = process.argv[1] ? dirname(process.argv[1]) : process.cwd(),
): AgentRuntimeLaunch | null {
  const configuredEntry = process.env.OPENVIDS_AGENT_RUNTIME_ENTRY;
  if (configuredEntry && isAbsolute(configuredEntry) && existsSync(configuredEntry)) {
    return makeLaunch(resolve(configuredEntry));
  }

  const siblingEntry = resolve(cliFileDir, "..", "agent-runtime", "main.ts");
  if (existsSync(siblingEntry)) return makeLaunch(siblingEntry);

  try {
    const runtimePackage = require.resolve("@hyperframes/agent-runtime/package.json");
    const workspaceEntry = join(dirname(runtimePackage), "src", "main.ts");
    if (existsSync(workspaceEntry)) return makeLaunch(workspaceEntry);
  } catch {
    // The source paths below work even when the optional runtime package is not linked.
  }

  const cliWorkspaceEntry = resolve(cliFileDir, "..", "..", "agent-runtime", "src", "main.ts");
  if (existsSync(cliWorkspaceEntry)) return makeLaunch(cliWorkspaceEntry);
  const sourceWorkspaceEntry = resolve(
    moduleDir,
    "..",
    "..",
    "..",
    "agent-runtime",
    "src",
    "main.ts",
  );
  if (existsSync(sourceWorkspaceEntry)) return makeLaunch(sourceWorkspaceEntry);
  return null;
}
