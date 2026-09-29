import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// Persistent latch for the DE parallel-router circuit breaker: once a render
// on this machine falls back, the router stays off for future renders.
// Single small JSON file under ~/.hyperframes; local-only, no network.

const BREAKER_DIR = join(homedir(), ".hyperframes");
const BREAKER_FILE = join(BREAKER_DIR, "parallel-router-breaker.json");

/** Has the breaker tripped on this machine? Missing/unreadable file means no. */
export function isParallelRouterBreakerTripped(): boolean {
  try {
    if (!existsSync(BREAKER_FILE)) return false;
    const parsed: unknown = JSON.parse(readFileSync(BREAKER_FILE, "utf-8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return false;
    const tripped = "tripped" in parsed ? parsed.tripped : undefined;
    return tripped === true;
  } catch {
    return false;
  }
}

/** Latch the breaker. Best-effort: returns whether the verdict stuck on disk. */
export function tripParallelRouterBreaker(): boolean {
  try {
    mkdirSync(BREAKER_DIR, { recursive: true, mode: 0o700 });
    const tmp = `${BREAKER_FILE}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify({ tripped: true }, null, 2) + "\n", { mode: 0o600 });
    renameSync(tmp, BREAKER_FILE);
    return true;
  } catch {
    return false;
  }
}
