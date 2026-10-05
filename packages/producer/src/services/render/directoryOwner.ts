import { readFileSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";

/**
 * A render's scratch dir and staging dir sit beside its output, where another process (a Studio server starting
 * up, `hyperframes render` in the same project) may look for residue of a render that was killed. The marker
 * tells it who owns the directory: this process's pid and host, and a heartbeat — the marker's mtime — so a pid the
 * OS has since handed to an unrelated process does not keep a dead render's directory alive.
 *
 * Two readers exist: the CLI's start-up residue sweep of a project's renders folder (`renderResidue.ts`), and the
 * system-temp sweep below. Keep the file name, the JSON shape and the heartbeat period in step with both.
 */
export const RENDER_OWNER_MARKER = ".hf-owner.json";

/** The sweep treats a marker untouched for longer than this as dead; stay well under it. */
export const RENDER_OWNER_HEARTBEAT_MS = 20_000;

/**
 * Marks `directory` as owned by this process until the returned release runs. Best effort: a render must not fail
 * because its marker could not be written.
 */
export function claimRenderDirectory(directory: string): () => void {
  const marker = join(directory, RENDER_OWNER_MARKER);
  const write = (): void => {
    try {
      writeFileSync(
        marker,
        JSON.stringify({ pid: process.pid, host: hostname(), startedAt: Date.now() }),
      );
    } catch {
      // The directory is already gone or unwritable; the sweep falls back to its age rule.
    }
  };
  write();
  const heartbeat = setInterval(() => {
    try {
      const now = new Date();
      utimesSync(marker, now, now);
    } catch {
      write();
    }
  }, RENDER_OWNER_HEARTBEAT_MS);
  heartbeat.unref();
  return () => clearInterval(heartbeat);
}

/** The sweep treats a marker untouched for this long as dead (the owner beats every 20 s). */
const HEARTBEAT_STALE_MS = 5 * 60_000;

/** A directory with no marker (a crash before the first write) is left alone while it is this fresh. */
const UNMARKED_GRACE_MS = 60 * 60_000;

/** Prefix of a scratch dir created under the system temp dir (see `resolveRenderWorkDirPrefix`). */
export const SYSTEM_TEMP_RENDER_DIR_PREFIX = "hf-render-";
const SYSTEM_TEMP_RENDER_DIR = new RegExp(`^${SYSTEM_TEMP_RENDER_DIR_PREFIX}[A-Za-z0-9]{6}$`);

function pidIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error instanceof Error && "code" in error && error.code === "EPERM";
  }
}

/** Whether some process may still be rendering into `directory`. When in doubt, yes. Shared with the CLI's sweep. */
export function hasLiveRenderOwner(directory: string, now: number = Date.now()): boolean {
  const marker = join(directory, RENDER_OWNER_MARKER);
  let beat: number;
  try {
    beat = statSync(marker).mtimeMs;
  } catch {
    try {
      return now - statSync(directory).mtimeMs < UNMARKED_GRACE_MS;
    } catch {
      return false;
    }
  }
  if (now - beat > HEARTBEAT_STALE_MS) return false;
  try {
    const owner: unknown = JSON.parse(readFileSync(marker, "utf8"));
    if (typeof owner !== "object" || owner === null) return true;
    const pid = "pid" in owner ? owner.pid : undefined;
    const host = "host" in owner ? owner.host : undefined;
    // A dead pid on this machine settles it at once, without waiting out the heartbeat.
    if (typeof pid === "number" && host === hostname() && !pidIsAlive(pid)) return false;
  } catch {
    // A marker mid-write: the heartbeat is fresh, so its owner is alive.
  }
  return true;
}

/**
 * Removes render scratch dirs under the system temp dir whose owner is gone. On Windows a render's frames and audio
 * live in `%TEMP%\hf-render-*`, and every normal quit of the desktop app ends the render host with a hard kill, so the
 * render's own cleanup never runs and Windows never clears them. Dirs of a render still running — in this process or
 * any other — are skipped, as are entries that do not have the shape of one. Returns the names removed.
 */
export function sweepStaleRenderScratch(
  systemTempDir: string = tmpdir(),
  now: number = Date.now(),
): string[] {
  let entries;
  try {
    entries = readdirSync(systemTempDir, { withFileTypes: true });
  } catch {
    return [];
  }
  const removed: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !SYSTEM_TEMP_RENDER_DIR.test(entry.name)) continue;
    const directory = join(systemTempDir, entry.name);
    if (hasLiveRenderOwner(directory, now)) continue;
    try {
      rmSync(directory, { recursive: true, force: true });
      removed.push(entry.name);
    } catch {
      // Left for the next start.
    }
  }
  return removed;
}
