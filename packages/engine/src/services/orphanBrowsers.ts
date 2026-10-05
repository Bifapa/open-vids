/**
 * Chrome the engine launched that outlived a killed owner.
 *
 * A browser is a separate process: when its owner dies without running any handler (SIGKILL, crash, power-cycled
 * parent), Chrome keeps running under init with its DevTools port open and holds hundreds of MB until reboot. Each
 * launch leaves a small record (browser pid -> owner pid) in the temp dir; `sweepOrphanBrowsers` kills the browsers
 * whose owner is gone. A live owner's browsers are never touched, and a record whose pid now belongs to an
 * unrelated program is dropped, not killed.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, normalize } from "node:path";

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

/** The command line of `pid` on Windows, or null when it is gone or cannot be read. */
function windowsCommandOf(pid: number): string | null {
  try {
    // `tasklist` only reports the image name, while Chrome is identified by its
    // command line (headless-shell, `puppeteer_dev_chrome_profile`), so read it
    // through CIM the way the CLI's process-identity lookups do.
    const output = execFileSync(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        `$p = Get-CimInstance Win32_Process -Filter 'ProcessId = ${pid}' -ErrorAction SilentlyContinue; if ($p) { $p.CommandLine }`,
      ],
      {
        encoding: "utf-8",
        // A cold PowerShell + CIM start takes over 5 s on a busy machine; a timeout leaves the orphan running.
        timeout: 15_000,
        stdio: ["ignore", "pipe", "ignore"],
        windowsHide: true,
      },
    ).trim();
    return output || null;
  } catch {
    return null;
  }
}

/** The command line of `pid`, or null when it is gone or cannot be read. */
function commandOf(pid: number): string | null {
  if (process.platform === "win32") return windowsCommandOf(pid);
  try {
    return execFileSync("ps", ["-o", "command=", "-p", String(pid)], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return null;
  }
}

/**
 * Ends the browser and, on Windows, the helpers Chrome spawned beneath it.
 * Throws when the process is already gone, so the caller drops the record
 * without counting a kill — the same contract `process.kill` has on POSIX.
 */
function killBrowser(pid: number): void {
  if (process.platform === "win32") {
    try {
      const result = spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], {
        stdio: "ignore",
        windowsHide: true,
        timeout: 10_000,
      });
      if (result.status === 0) return;
    } catch {
      // Fall through to the direct kill below.
    }
  }
  process.kill(pid, "SIGKILL");
}

/** Puppeteer names the throwaway profile it hands to every browser it launches, and the engine never overrides it. */
const ENGINE_PROFILE = /^puppeteer_dev_chrome_profile[-_][^\\/]+$/;

/** True when the last path segment names a Puppeteer throwaway profile directory (either separator). */
function isEngineProfilePath(value: string): boolean {
  const segments = value.split(/[\\/]+/).filter((segment) => segment.length > 0);
  const profile = segments[segments.length - 1];
  return profile !== undefined && ENGINE_PROFILE.test(profile);
}

/**
 * The profile directory of `command` when it is a browser this engine launched: its `--user-data-dir=` argument
 * (the last one wins, as in Chrome) names a `puppeteer_dev_chrome_profile-…` directory; null otherwise. A Chrome or headless-shell image name alone is
 * not enough — that also matches the user's own browser. Handles the quoting a Windows command line carries
 * (`"--user-data-dir=C:\Users\A B\…"`, `--user-data-dir="C:\…"`), spaces in an unquoted POSIX `ps` line, and
 * both separators.
 */
function engineProfileOf(command: string): string | null {
  let value: string | null = null;
  for (const match of command.matchAll(/(?:^|[\s"'])--user-data-dir=/g)) {
    let rest = command.slice(match.index + match[0].length);
    const quote = rest.startsWith('"') ? '"' : rest.startsWith("'") ? "'" : null;
    if (quote !== null) rest = rest.slice(1);
    const end = quote !== null ? rest.indexOf(quote) : rest.search(/["']|\s--/);
    value = (end === -1 ? rest : rest.slice(0, end)).trim();
  }
  return value !== null && isEngineProfilePath(value) ? value : null;
}

/** The `--user-data-dir=` value of a Puppeteer launch when it names an engine profile directory; null otherwise. */
function engineProfileFromArgs(spawnArgs: readonly string[]): string | null {
  const prefix = "--user-data-dir=";
  let value: string | null = null;
  for (const arg of spawnArgs) if (arg.startsWith(prefix)) value = arg.slice(prefix.length);
  return value !== null && isEngineProfilePath(value) ? value : null;
}

/**
 * Notes that this process owns the browser `browserPid`, and the Puppeteer profile it runs (taken from its launch
 * arguments), so the sweep can still remove that profile when the browser died together with its owner (a Windows
 * Job Object kills both). Best effort: the registry is a safety net, not a contract.
 */
export function recordBrowserOwner(
  browserPid: number,
  root: string = tmpdir(),
  spawnArgs: readonly string[] = [],
): void {
  try {
    mkdirSync(recordDir(root), { recursive: true });
    const profile = engineProfileFromArgs(spawnArgs);
    writeFileSync(
      join(recordDir(root), `${browserPid}.json`),
      JSON.stringify(
        profile === null ? { ownerPid: process.pid } : { ownerPid: process.pid, profile },
      ),
    );
  } catch {
    // An unwritable temp dir only costs the crash cleanup.
  }
}

/** Drops the record of a browser that closed normally. */
export function forgetBrowserOwner(browserPid: number, root: string = tmpdir()): void {
  rmSync(join(recordDir(root), `${browserPid}.json`), { force: true });
}

interface BrowserRecord {
  ownerPid: number;
  /** The engine profile the browser ran; null for records written before it was kept. */
  profile: string | null;
}

function readRecord(file: string): BrowserRecord | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, "utf-8"));
    if (typeof parsed !== "object" || parsed === null || !("ownerPid" in parsed)) return null;
    const { ownerPid } = parsed;
    if (typeof ownerPid !== "number" || !Number.isInteger(ownerPid) || ownerPid <= 0) return null;
    const profile = "profile" in parsed ? parsed.profile : undefined;
    // The record sits in a shared temp dir: only a vetted engine profile path may ever be removed.
    return {
      ownerPid,
      profile: typeof profile === "string" && isEngineProfilePath(profile) ? profile : null,
    };
  } catch {
    return null;
  }
}

function samePath(a: string, b: string): boolean {
  const [left, right] = [normalize(a), normalize(b)];
  return process.platform === "win32" ? left.toLowerCase() === right.toLowerCase() : left === right;
}

/**
 * Puppeteer deletes its throwaway profile only when the launching process closes the browser, which a killed owner
 * never does. Only an absolute path that passed `isEngineProfilePath` is removed. Windows releases a killed Chrome's
 * file handles a moment late, hence the retries.
 */
function removeProfile(profile: string): void {
  if (!isAbsolute(profile)) return;
  try {
    rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  } catch {
    // A profile that cannot be removed now costs disk, not correctness.
  }
}

/**
 * Kills browsers whose owner died, removes their Puppeteer profiles (also when the browser died with its owner and
 * only the record remembers the profile) and clears their records. Returns the pids killed.
 */
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
    const record = readRecord(file);
    if (!Number.isInteger(browserPid) || browserPid <= 0 || record === null) {
      rmSync(file, { force: true });
      continue;
    }
    const { ownerPid } = record;
    if (ownerPid === process.pid || isAlive(ownerPid)) continue;
    const command = commandOf(browserPid);
    const running = command === null ? null : engineProfileOf(command);
    // The pid is this record's browser only while it runs the recorded profile; an old record names none, so any
    // engine browser on the pid counts, as before. A reused pid running another profile is left alone.
    const isOurs =
      running !== null && (record.profile === null || samePath(running, record.profile));
    if (isOurs) {
      try {
        killBrowser(browserPid);
        killed.push(browserPid);
      } catch {
        // Already gone.
      }
    }
    const profile = isOurs ? running : record.profile;
    if (profile !== null) removeProfile(profile);
    rmSync(file, { force: true });
  }
  return killed;
}
