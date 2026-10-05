import { readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { hasLiveRenderOwner } from "@hyperframes/producer";

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";

/**
 * `work-<render job uuid>-<mkdtemp suffix>`: the render's frame/audio scratch dir; `.<stem>.hf-transaction-<mkdtemp
 * suffix>`: its staged output. The job id is always a uuid, so a folder of the user's own named `work-…-abc123`
 * does not match.
 */
const RESIDUE = [
  new RegExp(`^work-${UUID}-[A-Za-z0-9]{6}$`),
  /^\..+\.hf-transaction-[A-Za-z0-9]{6}$/,
];

/**
 * Removes what a render killed mid-way (SIGKILL, crash, power loss) left in the renders folder: hundreds of MB of
 * captured frames and a half-staged artifact. Directories of a render that is still running — in this process or any
 * other that renders into the same folder (`hyperframes render`, a second Studio) — are skipped (the owner marker and
 * heartbeat the render writes, producer `directoryOwner.ts`), as are folders that do not have the shape of a render's
 * scratch dirs. Finished renders (and their `.meta.json`) are never touched. Returns the names removed.
 */
export function sweepRenderResidue(rendersDir: string, now: number = Date.now()): string[] {
  let entries;
  try {
    entries = readdirSync(rendersDir, { withFileTypes: true });
  } catch {
    return [];
  }
  const removed: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !RESIDUE.some((pattern) => pattern.test(entry.name))) continue;
    const directory = join(rendersDir, entry.name);
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
