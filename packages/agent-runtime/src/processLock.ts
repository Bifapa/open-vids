import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { linkSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { promisify } from "node:util";

const run = promisify(execFile);

/** Another live process holds the lock. */
export class LockBusyError extends Error {
  constructor(readonly pid: number) {
    super(`Another process (pid ${pid}) holds this lock.`);
    this.name = "LockBusyError";
  }
}

/** Windows starts are epoch milliseconds; this process's own is computed in place (PowerShell takes seconds to start). */
const WINDOWS_START_PREFIX = "win-ms:";
const WINDOWS_START_TOLERANCE_MS = 10_000;

/**
 * A process's identity beyond its pid: when it started. Null when the process does not exist, may not be queried, or the
 * platform gives no way to tell. Asked of a child process without blocking the event loop.
 */
async function processStartKey(pid: number): Promise<string | null> {
  try {
    if (process.platform === "linux") {
      const stat = readFileSync(`/proc/${pid}/stat`, "utf-8");
      // The command name sits in parentheses and may hold spaces; field 22 (starttime) is the 20th after it.
      const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
      const boot = readFileSync("/proc/sys/kernel/random/boot_id", "utf-8").trim();
      return fields[19] ? `${boot}:${fields[19]}` : null;
    }
    if (process.platform === "win32") {
      const { stdout } = await run(
        "powershell.exe",
        [
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          `[DateTimeOffset]::new((Get-Process -Id ${pid} -ErrorAction Stop).StartTime).ToUnixTimeMilliseconds()`,
        ],
        { encoding: "utf-8", timeout: 10_000, windowsHide: true },
      );
      const ms = Number(stdout.trim());
      return Number.isFinite(ms) && ms > 0 ? `${WINDOWS_START_PREFIX}${ms}` : null;
    }
    // TZ is pinned so a changed time zone never changes what the same process reports.
    const { stdout } = await run("ps", ["-o", "lstart=", "-p", String(pid)], {
      encoding: "utf-8",
      timeout: 5_000,
      env: { ...process.env, TZ: "UTC", LC_ALL: "C" },
    });
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

function ownStartKey(): Promise<string | null> {
  if (process.platform !== "win32") return processStartKey(process.pid);
  return Promise.resolve(
    `${WINDOWS_START_PREFIX}${Math.round(Date.now() - process.uptime() * 1000)}`,
  );
}

function windowsStartMs(key: string): number | null {
  if (!key.startsWith(WINDOWS_START_PREFIX)) return null;
  const ms = Number(key.slice(WINDOWS_START_PREFIX.length));
  return Number.isFinite(ms) ? ms : null;
}

function sameStart(a: string, b: string): boolean {
  const msA = windowsStartMs(a);
  const msB = windowsStartMs(b);
  if (msA === null || msB === null) return a === b;
  return Math.abs(msA - msB) <= WINDOWS_START_TOLERANCE_MS;
}

let ownStart: Promise<string | null> | undefined;

function alive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return isErrno(error) && error.code === "EPERM";
  }
}

function isErrno(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

/** Who a lock file names: a pid, and the start of the process that wrote it. */
interface Owner {
  pid: number;
  start: string | null;
}

/** The owner in `file`; null when there is no file, a NaN pid when it holds none (so it reads as dead). */
function ownerOf(file: string): Owner | null {
  try {
    const text = readFileSync(file, "utf-8");
    const match = /^(\d+)(?: (.+))?$/s.exec(text);
    return match?.[1] === undefined
      ? { pid: Number.NaN, start: null }
      : { pid: Number(match[1]), start: match[2] ?? null };
  } catch (error) {
    if (isErrno(error) && error.code === "ENOENT") return null;
    throw error;
  }
}

/**
 * Whether the process that wrote the lock still runs. The pid alone is not enough (a lock survives a hard kill, and the
 * pid may since belong to any process): it must also have started when the lock's writer did. A live process whose
 * start cannot be told counts as the owner: better a busy lock than two writers.
 */
async function holds(owner: Owner): Promise<boolean> {
  if (!alive(owner.pid)) return false;
  if (owner.start === null) return true;
  const now =
    owner.pid === process.pid
      ? await (ownStart ??= ownStartKey())
      : await processStartKey(owner.pid);
  return now === null || sameStart(now, owner.start);
}

/** Takes `file` if nobody holds it: written aside and linked in, so a reader never sees it without its pid. */
function claim(file: string, start: string | null): boolean {
  const draft = `${file}-${randomUUID()}.tmp`;
  writeFileSync(draft, start === null ? String(process.pid) : `${process.pid} ${start}`);
  try {
    linkSync(draft, file);
    return true;
  } catch (error) {
    if (!isErrno(error) || error.code !== "EEXIST") throw error;
    return false;
  } finally {
    rmSync(draft, { force: true });
  }
}

/** Removes `file` only while it names this process, so a release never takes a later owner's lock. */
function releaseOwn(file: string): void {
  if (ownerOf(file)?.pid === process.pid) rmSync(file, { force: true });
}

/** Removes a dead owner's lock under an evict lock, re-reading the owner, so a live owner's lock survives. */
async function evictDeadOwner(file: string, start: string | null): Promise<boolean> {
  const evictor = `${file}.evict`;
  const removeIfDead = async (lock: string, owner: Owner | null): Promise<void> => {
    if (owner === null || (await holds(owner))) return;
    const again = ownerOf(lock);
    if (again && Object.is(again.pid, owner.pid) && again.start === owner.start)
      rmSync(lock, { force: true });
  };
  if (!claim(evictor, start)) {
    await removeIfDead(evictor, ownerOf(evictor));
    return false;
  }
  try {
    await removeIfDead(file, ownerOf(file));
    return true;
  } finally {
    releaseOwn(evictor);
  }
}

/**
 * Takes the lock `file`, waiting up to `waitMs` for a live owner to let go and taking over a dead owner's lock. Resolves
 * with the release function; rejects with {@link LockBusyError} when a live process still holds it after the wait.
 */
export async function takeLock(file: string, waitMs: number, pollMs = 50): Promise<() => void> {
  const deadline = Date.now() + waitMs;
  mkdirSync(dirname(file), { recursive: true });
  ownStart ??= ownStartKey();
  const start = await ownStart;
  for (;;) {
    if (claim(file, start)) {
      let held = true;
      return () => {
        if (held) releaseOwn(file);
        held = false;
      };
    }
    const owner = ownerOf(file);
    if (owner === null) continue;
    if (!(await holds(owner)) && (await evictDeadOwner(file, start))) continue;
    if (Date.now() >= deadline) throw new LockBusyError(owner.pid);
    await sleep(pollMs);
  }
}

/** Runs `work` while holding `file` (a short read-modify-write; other processes wait up to `waitMs`). */
export async function withLock<T>(
  file: string,
  waitMs: number,
  work: () => Promise<T>,
): Promise<T> {
  const release = await takeLock(file, waitMs, 20);
  try {
    return await work();
  } finally {
    release();
  }
}
