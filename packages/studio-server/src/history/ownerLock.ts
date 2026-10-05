import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { linkSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

export class HistoryBusyError extends Error {
  constructor(readonly pid: number) {
    super(`This project's history is open in another process (pid ${pid}).`);
    this.name = "HistoryBusyError";
  }
}

/**
 * A process's identity beyond its pid: when it started (and, on Linux, in which boot). The start of the process
 * `pid`; null when it does not exist, may not be queried, or the platform gives no way to tell. Asked of a child
 * process without blocking the event loop (PowerShell takes a while to start).
 */
export async function processStartKey(pid: number): Promise<string | null> {
  try {
    if (process.platform === "linux") {
      const stat = readFileSync(`/proc/${pid}/stat`, "utf-8");
      // The command name sits in parentheses and may hold spaces; field 22 (starttime) is the 20th after it.
      const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
      const boot = readFileSync("/proc/sys/kernel/random/boot_id", "utf-8").trim();
      return fields[19] ? `${boot}:${fields[19]}` : null;
    }
    // TZ is pinned so a changed time zone never changes what the same process reports.
    const { stdout } =
      process.platform === "win32"
        ? await run(
            "powershell.exe",
            [
              "-NoProfile",
              "-NonInteractive",
              "-Command",
              `(Get-Process -Id ${pid} -ErrorAction Stop).StartTime.ToUniversalTime().Ticks`,
            ],
            { encoding: "utf-8", timeout: 10_000, windowsHide: true },
          )
        : await run("ps", ["-o", "lstart=", "-p", String(pid)], {
            encoding: "utf-8",
            timeout: 5_000,
            env: { ...process.env, TZ: "UTC", LC_ALL: "C" },
          });
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

/** This process's own start, read once: its owner lock names it, so a later process can tell a reused pid. */
let ownStart: Promise<string | null> | undefined;

/** The starts looked up during one wait, by pid: a process's start never changes, and a lookup can be slow. */
type StartKeys = Map<number, Promise<string | null>>;

function startOf(starts: StartKeys, pid: number): Promise<string | null> {
  let start = starts.get(pid);
  if (start === undefined) {
    start = processStartKey(pid);
    starts.set(pid, start);
  }
  return start;
}

function alive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Who a lock file names: a pid, and the start of the process that wrote it when it could tell (older locks: none). */
interface Owner {
  pid: number;
  start: string | null;
}

/** The owner in `file`; null when there is no file, a NaN pid when it holds none (so it reads as dead). */
function ownerOf(file: string): Owner | null {
  try {
    const text = readFileSync(file, "utf-8");
    const match = /^(\d+)(?: (.+))?$/s.exec(text);
    return match
      ? { pid: Number(match[1]), start: match[2] ?? null }
      : { pid: Number.NaN, start: null };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

/**
 * Whether the process that wrote the lock still runs. A pid alone is not enough: the lock survives a hard kill or a
 * reboot, and the pid may since belong to any other process, which would hold the history shut for as long as it
 * lives. So the pid must also have started when the lock's writer did. A live process whose start cannot be told
 * (not queryable by this user) counts as the owner: better a busy history than two writers on one log.
 */
async function holds(owner: Owner, starts: StartKeys): Promise<boolean> {
  if (!alive(owner.pid)) return false;
  if (owner.start === null) return true;
  const now = await startOf(starts, owner.pid);
  return now === null || now === owner.start;
}

/** Takes `file` if nobody holds it: written aside and linked in, so a reader never sees it without its pid. */
function claim(file: string, start: string | null): boolean {
  const draft = `${file}-${randomUUID()}.tmp`;
  writeFileSync(draft, start === null ? String(process.pid) : `${process.pid} ${start}`);
  try {
    linkSync(draft, file);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    return false;
  } finally {
    rmSync(draft, { force: true });
  }
}

/** Removes `file` only while it names this process, so a release never takes a later owner's lock. */
function releaseOwn(file: string): void {
  if (ownerOf(file)?.pid === process.pid) rmSync(file, { force: true });
}

/**
 * Removes a dead owner's lock under an evict lock, re-reading the owner, so a live owner's lock survives. False when
 * another evictor holds it. ponytail: a crashed evictor's lock is cleared unguarded; racing that can give two owners.
 */
async function evictDeadOwner(
  file: string,
  starts: StartKeys,
  start: string | null,
): Promise<boolean> {
  const evictor = `${file}.evict`;
  // The lookup awaits, so the lock is read again before it is removed: one that changed hands meanwhile stays.
  const removeIfDead = async (lock: string, owner: Owner | null): Promise<void> => {
    if (owner === null || (await holds(owner, starts))) return;
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
 * One process at a time keeps a project's history open (a second opener would fork the log). Waits up to `waitMs`
 * for the owner to close, takes over a dead owner's lock.
 */
export async function takeHistoryOwnership(home: string, waitMs: number): Promise<() => void> {
  const file = join(home, "owner.pid");
  const deadline = Date.now() + waitMs;
  const starts: StartKeys = new Map();
  mkdirSync(home, { recursive: true });
  ownStart ??= processStartKey(process.pid);
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
    if (!(await holds(owner, starts)) && (await evictDeadOwner(file, starts, start))) continue;
    if (Date.now() >= deadline) throw new HistoryBusyError(owner.pid);
    await new Promise((settle) => setTimeout(settle, 50));
  }
}
