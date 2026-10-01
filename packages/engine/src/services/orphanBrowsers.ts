/**
 * Chrome the engine launched that outlived a killed owner.
 *
 * A browser is a separate process: when its owner dies without running any handler (SIGKILL, crash, power-cycled
 * parent), Chrome keeps running under init with its DevTools port open and holds hundreds of MB until reboot. Each
 * launch leaves a small record (browser pid -> owner pid) in the temp dir; `sweepOrphanBrowsers` kills the browsers
 * whose owner is gone. A live owner's browsers are never touched, and a record whose pid now belongs to an
 * unrelated program is dropped, not killed.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const RECORD_DIR = "hyperframes-browsers";

function recordDir(root: string): string {
  return join(root, RECORD_DIR);
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: the process exists but belongs to someone else.
    return error instanceof Error && "code" in error && error.code === "EPERM";
  }
}

/** The command line of `pid`, or null when it is gone or cannot be read. */
function commandOf(pid: number): string | null {
  if (process.platform === "win32") return null;
  try {
    return execFileSync("ps", ["-o", "command=", "-p", String(pid)], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return null;
  }
}

const looksLikeChrome = (command: string) => /chrom/i.test(command);

/** Notes that this process owns the browser `browserPid`. Best effort: the registry is a safety net, not a contract. */
export function recordBrowserOwner(browserPid: number, root: string = tmpdir()): void {
  try {
    mkdirSync(recordDir(root), { recursive: true });
    writeFileSync(
      join(recordDir(root), `${browserPid}.json`),
      JSON.stringify({ ownerPid: process.pid }),
    );
  } catch {
    // An unwritable temp dir only costs the crash cleanup.
  }
}

/** Drops the record of a browser that closed normally. */
export function forgetBrowserOwner(browserPid: number, root: string = tmpdir()): void {
  rmSync(join(recordDir(root), `${browserPid}.json`), { force: true });
}

function ownerOf(file: string): number | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, "utf-8"));
    if (typeof parsed !== "object" || parsed === null || !("ownerPid" in parsed)) return null;
    const { ownerPid } = parsed;
    return typeof ownerPid === "number" && Number.isInteger(ownerPid) && ownerPid > 0
      ? ownerPid
      : null;
  } catch {
    return null;
  }
}

/** Kills browsers whose owner died and clears their records. Returns the pids killed. */
export function sweepOrphanBrowsers(root: string = tmpdir()): number[] {
  const dir = recordDir(root);
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  const killed: number[] = [];
  for (const name of names) {
    const file = join(dir, name);
    const browserPid = Number(name.replace(/\.json$/, ""));
    const ownerPid = ownerOf(file);
    if (!Number.isInteger(browserPid) || browserPid <= 0 || ownerPid === null) {
      rmSync(file, { force: true });
      continue;
    }
    if (ownerPid === process.pid || isAlive(ownerPid)) continue;
    const command = commandOf(browserPid);
    if (command !== null && looksLikeChrome(command)) {
      try {
        process.kill(browserPid, "SIGKILL");
        killed.push(browserPid);
      } catch {
        // Already gone.
      }
    }
    rmSync(file, { force: true });
  }
  return killed;
}
