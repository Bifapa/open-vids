import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { recordBrowserOwner, sweepOrphanBrowsers } from "./orphanBrowsers.js";

const children: ChildProcess[] = [];
const roots: string[] = [];

afterEach(() => {
  for (const child of children.splice(0)) child.kill("SIGKILL");
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const root = () => {
  const dir = mkdtempSync(join(tmpdir(), "hf-orphan-browsers-"));
  roots.push(dir);
  return dir;
};

/** A live process whose command line carries `label` and `args`: stands in for a browser. */
async function sleeper(label: string, ...args: string[]): Promise<ChildProcess & { pid: number }> {
  const child = spawn(
    process.execPath,
    ["-e", "setInterval(() => {}, 1000)", "--", label, ...args],
    {
      stdio: "ignore",
      // A GUI-launched test run has no console; without this every sleeper
      // flashes one on Windows. No-op on POSIX.
      windowsHide: true,
    },
  );
  children.push(child);
  await once(child, "spawn");
  if (child.pid === undefined) throw new Error("no pid");
  return Object.assign(child, { pid: child.pid });
}

const deadPid = () => {
  const done = spawnSync(process.execPath, ["-e", "process.stdout.write(String(process.pid))"]);
  return Number(done.stdout.toString());
};

const isAlive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const record = (base: string, browserPid: number, ownerPid: number) => {
  mkdirSync(join(base, "hyperframes-browsers"), { recursive: true });
  writeFileSync(
    join(base, "hyperframes-browsers", `${browserPid}.json`),
    JSON.stringify({ ownerPid }),
  );
};
const recordFile = (base: string, pid: number) => join(base, "hyperframes-browsers", `${pid}.json`);

/** The profile argument every browser the engine launches carries (puppeteer's default profile in the temp dir). */
const engineProfile = (suffix: string, parent = join(tmpdir(), "hf-orphan-profiles")) =>
  `--user-data-dir=${join(parent, `puppeteer_dev_chrome_profile-${suffix}`)}`;

describe("sweepOrphanBrowsers", () => {
  it("kills a browser whose owner died, and only that one", async () => {
    const base = root();
    const orphan = await sleeper("chrome-headless-shell", engineProfile("orphan"));
    const kept = await sleeper("chrome-headless-shell", engineProfile("kept"));
    record(base, orphan.pid, deadPid());
    record(base, kept.pid, process.pid);

    expect(sweepOrphanBrowsers(base)).toEqual([orphan.pid]);
    await once(orphan, "exit");
    expect(isAlive(kept.pid), "a live owner's browser stays").toBe(true);
    expect(existsSync(recordFile(base, orphan.pid))).toBe(false);
    expect(existsSync(recordFile(base, kept.pid))).toBe(true);
  });

  it("finds the profile when its directory has spaces", async () => {
    const base = root();
    const orphan = await sleeper(
      "chrome-headless-shell",
      engineProfile("spaced", join(tmpdir(), "hf orphan profiles", "with spaces")),
    );
    record(base, orphan.pid, deadPid());

    expect(sweepOrphanBrowsers(base)).toEqual([orphan.pid]);
    await once(orphan, "exit");
  });

  it("never kills a pid that no longer runs a browser (reused by another program)", async () => {
    const base = root();
    const unrelated = await sleeper("some-other-program");
    record(base, unrelated.pid, deadPid());

    expect(sweepOrphanBrowsers(base)).toEqual([]);
    expect(isAlive(unrelated.pid)).toBe(true);
    expect(existsSync(recordFile(base, unrelated.pid)), "the stale record is dropped").toBe(false);
  });

  it("never kills a Chrome that is not running an engine profile", async () => {
    const base = root();
    // The user's own browser: right image name, wrong (or no) profile.
    const plain = await sleeper("chrome");
    const headlessShell = await sleeper("chrome-headless-shell");
    const userProfile = await sleeper(
      "chrome",
      `--user-data-dir=${join(tmpdir(), "Google", "Chrome", "User Data")}`,
    );
    // The profile name must be the directory, not a substring of another path segment.
    const lookalike = await sleeper(
      "chrome",
      `--user-data-dir=${join(tmpdir(), "puppeteer_dev_chrome_profile-elsewhere", "Default")}`,
    );
    for (const survivor of [plain, headlessShell, userProfile, lookalike]) {
      record(base, survivor.pid, deadPid());
    }

    expect(sweepOrphanBrowsers(base)).toEqual([]);
    for (const survivor of [plain, headlessShell, userProfile, lookalike]) {
      expect(isAlive(survivor.pid)).toBe(true);
      expect(existsSync(recordFile(base, survivor.pid)), "the stale record is dropped").toBe(false);
    }
  });

  it("drops a damaged record and records this process as the owner of a launch", () => {
    const base = root();
    mkdirSync(join(base, "hyperframes-browsers"));
    writeFileSync(recordFile(base, 4242), "{not json");
    recordBrowserOwner(4343, base);

    expect(sweepOrphanBrowsers(base)).toEqual([]);
    expect(existsSync(recordFile(base, 4242))).toBe(false);
    expect(existsSync(recordFile(base, 4343)), "this process is alive, so its record stays").toBe(
      true,
    );
  });
});
