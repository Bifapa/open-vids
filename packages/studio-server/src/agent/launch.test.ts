import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveAgentRuntimeLaunch } from "./launch.js";

const tempDirs: string[] = [];
const runtimeEntryBefore = process.env.OPENVIDS_AGENT_RUNTIME_ENTRY;
const bunOverrideBefore = process.env.OPENVIDS_AGENT_BUN;

afterEach(() => {
  if (runtimeEntryBefore === undefined) delete process.env.OPENVIDS_AGENT_RUNTIME_ENTRY;
  else process.env.OPENVIDS_AGENT_RUNTIME_ENTRY = runtimeEntryBefore;
  if (bunOverrideBefore === undefined) delete process.env.OPENVIDS_AGENT_BUN;
  else process.env.OPENVIDS_AGENT_BUN = bunOverrideBefore;
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function createTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "openvids-agent-launch-"));
  tempDirs.push(dir);
  return dir;
}

function createEntry(path: string): string {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, "process.exit(0);\n");
  return resolve(path);
}

describe("resolveAgentRuntimeLaunch", () => {
  it("prefers an absolute environment entry over the packaged sibling", () => {
    const dir = createTempDir();
    const cliDir = join(dir, "runtime", "hyperframes");
    const configured = createEntry(join(dir, "custom", "main.ts"));
    createEntry(join(dir, "runtime", "agent-runtime", "main.ts"));
    process.env.OPENVIDS_AGENT_RUNTIME_ENTRY = configured;
    process.env.OPENVIDS_AGENT_BUN = "/custom/bun";

    const launch = resolveAgentRuntimeLaunch(cliDir);
    expect(launch?.args).toEqual(["--no-install", configured]);
    expect(launch?.command).toBe("/custom/bun");
    expect(launch?.cwd).toBe(dirname(configured));
  });

  it("uses the sibling runtime before resolving the workspace package", () => {
    const dir = createTempDir();
    const cliDir = join(dir, "runtime", "hyperframes");
    const sibling = createEntry(join(dir, "runtime", "agent-runtime", "main.ts"));
    delete process.env.OPENVIDS_AGENT_RUNTIME_ENTRY;
    delete process.env.OPENVIDS_AGENT_BUN;

    const launch = resolveAgentRuntimeLaunch(cliDir);
    expect(launch?.args).toEqual(["--no-install", sibling]);
  });

  it("falls back to the workspace source runtime when the package is not linked", () => {
    const dir = createTempDir();
    const workspaceEntry = resolve(
      dirname(fileURLToPath(import.meta.url)),
      "../../../agent-runtime/src/main.ts",
    );
    delete process.env.OPENVIDS_AGENT_RUNTIME_ENTRY;
    delete process.env.OPENVIDS_AGENT_BUN;

    const launch = resolveAgentRuntimeLaunch(join(dir, "cli"));
    expect(launch?.args).toEqual(["--no-install", workspaceEntry]);
    expect(launch?.command).toBe(process.versions.bun ? process.execPath : "bun");
  });
});
