// @vitest-environment node
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HistoryBusyError, processStartKey, sameStart, takeHistoryOwnership } from "./ownerLock";

const spawned = vi.hoisted((): string[] => []);

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  const run = promisify(actual.execFile);
  const counted = (...args: Parameters<typeof actual.execFile>) => actual.execFile(...args);
  return {
    ...actual,
    execFile: Object.assign(counted, {
      [promisify.custom]: (file: string, args: string[], options: { encoding: "utf-8" }) => {
        spawned.push(file);
        return run(file, args, options);
      },
    }),
  };
});

const dirs: string[] = [];

afterEach(() => {
  spawned.length = 0;
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempHome(): string {
  const dir = mkdtempSync(join(tmpdir(), "hf-owner-lock-"));
  dirs.push(dir);
  return dir;
}

describe("takeHistoryOwnership", () => {
  it("asks for a live owner's start once per wait, not on every poll", async () => {
    const start = await processStartKey(process.pid);
    // Linux reads /proc, which spawns nothing to count.
    if (start === null || process.platform === "linux") return;
    const home = tempHome();
    // This process stands in for a live owner; the wait polls every 50 ms for 300 ms.
    writeFileSync(join(home, "owner.pid"), `${process.pid} ${start}`);
    spawned.length = 0;

    await expect(takeHistoryOwnership(home, 300)).rejects.toThrow(HistoryBusyError);

    // This process's own start (once per process) and the owner's (once per wait).
    expect(spawned.length).toBeLessThanOrEqual(2);
  });

  it("keeps a live owner whose start matches, and takes over one whose pid was reused", async () => {
    const start = await processStartKey(process.pid);
    if (start === null) return;
    const home = tempHome();
    writeFileSync(join(home, "owner.pid"), `${process.pid} ${start}`);
    await expect(takeHistoryOwnership(home, 0)).rejects.toThrow(HistoryBusyError);

    writeFileSync(join(home, "owner.pid"), `${process.pid} started-before-this-process`);
    const release = await takeHistoryOwnership(home, 0);
    release();
  });

  it("takes over a lock file that holds no pid", async () => {
    const home = tempHome();
    writeFileSync(join(home, "owner.pid"), "");
    const release = await takeHistoryOwnership(home, 0);
    release();
  });
});

describe("sameStart", () => {
  it("matches Windows starts within the tolerance and nothing further apart", () => {
    expect(sameStart("win-ms:1000000", "win-ms:1008000")).toBe(true);
    expect(sameStart("win-ms:1000000", "win-ms:1020000")).toBe(false);
  });

  it("compares other platforms' starts exactly", () => {
    expect(sameStart("Mon Oct  5 10:00:00 2026", "Mon Oct  5 10:00:00 2026")).toBe(true);
    expect(sameStart("Mon Oct  5 10:00:00 2026", "Mon Oct  5 10:00:01 2026")).toBe(false);
  });
});
