import { readdirSync, rmSync } from "node:fs";
import { join } from "node:path";

/** `work-<job id>-<random>`: the render's frame/audio scratch dir; `.<stem>.hf-transaction-<random>`: its staged output. */
const RESIDUE = [/^work-.+-[A-Za-z0-9]{6}$/, /^\..+\.hf-transaction-[A-Za-z0-9]{6}$/];

/**
 * Removes what a render killed mid-way (SIGKILL, crash, power loss) left in the renders folder: hundreds of MB of
 * captured frames and a half-staged artifact. Run before this server starts any render, so nothing it finds is live.
 * Finished renders (and their `.meta.json`) are never touched. Returns the names removed.
 */
export function sweepRenderResidue(rendersDir: string): string[] {
  let entries;
  try {
    entries = readdirSync(rendersDir, { withFileTypes: true });
  } catch {
    return [];
  }
  const removed: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !RESIDUE.some((pattern) => pattern.test(entry.name))) continue;
    try {
      rmSync(join(rendersDir, entry.name), { recursive: true, force: true });
      removed.push(entry.name);
    } catch {
      // Left for the next start.
    }
  }
  return removed;
}
