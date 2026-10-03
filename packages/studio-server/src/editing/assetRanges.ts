import { mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import {
  ASSET_RANGES_PATH,
  ASSET_RANGES_SCHEMA,
  ASSET_RANGE_MIN_SECONDS,
  isAssetRange,
  isRecord,
  type AssetRange,
} from "@hyperframes/agent-protocol";
import { replaceFileAtomically } from "../helpers/atomicFile.js";
import { pinWithinProject } from "../helpers/safePath.js";

/**
 * The fragments the user picked of the project's video/audio assets (`.hyperframes/media/ranges.json`), keyed by
 * project-relative asset path. A missing, unreadable or hand-broken file means "no ranges"; a broken entry is
 * skipped, never fatal.
 */
export function readAssetRanges(projectDir: string): Map<string, AssetRange> {
  const ranges = new Map<string, AssetRange>();
  const file = pinWithinProject(projectDir, ASSET_RANGES_PATH);
  if (!file) return ranges;
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, "utf-8"));
  } catch {
    return ranges;
  }
  if (!isRecord(raw) || !isRecord(raw.ranges)) return ranges;
  for (const [path, range] of Object.entries(raw.ranges)) {
    if (isAssetRange(range)) ranges.set(path, { start: range.start, end: range.end });
  }
  return ranges;
}

/** Writes the whole map (sorted by path, so the file diffs cleanly in history). */
export function writeAssetRanges(
  projectDir: string,
  ranges: ReadonlyMap<string, AssetRange>,
): void {
  const file = pinWithinProject(projectDir, ASSET_RANGES_PATH);
  if (!file) throw new Error(`${ASSET_RANGES_PATH} is not inside the project`);
  const sorted = Object.fromEntries([...ranges].sort(([a], [b]) => a.localeCompare(b)));
  mkdirSync(dirname(file), { recursive: true });
  replaceFileAtomically(
    file,
    `${JSON.stringify({ version: ASSET_RANGES_SCHEMA, ranges: sorted }, null, 2)}\n`,
    0o644,
  );
}

/**
 * The stored range of an asset as it applies to the file as it is now: clamped to the file's length (the file may
 * have been replaced by a shorter one), dropped when nothing usable is left. `duration` null: not probed, kept as is.
 */
export function effectiveRange(
  range: AssetRange | undefined,
  duration: number | null,
): AssetRange | null {
  if (!range) return null;
  const end = duration === null ? range.end : Math.min(range.end, duration);
  if (end - range.start < ASSET_RANGE_MIN_SECONDS - 1e-6) return null;
  return { start: range.start, end };
}

/**
 * The source window an editing-service placement of an asset must stay inside: the user's range, or the whole file
 * (`end` null when its length is unknown).
 */
export interface MediaBounds {
  start: number;
  end: number | null;
  /** The bounds come from a range the user picked (error messages say so). */
  picked: boolean;
}

export function mediaBounds(range: AssetRange | undefined, duration: number | null): MediaBounds {
  const effective = effectiveRange(range, duration);
  return effective
    ? { start: effective.start, end: effective.end, picked: true }
    : { start: 0, end: duration, picked: false };
}
