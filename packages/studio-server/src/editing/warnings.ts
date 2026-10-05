import { EPS, fmt } from "./batch.js";
import type { CompositionModel } from "./timeline.js";

/** Overlaps shorter than this are rounding, not a mistake. */
const MIN_OVERLAP = 0.05;
const MAX_LISTED = 5;

/** Clips that can double the speech or hide each other when they overlap on the A-roll track. */
const SOLID_KINDS = new Set(["video", "audio", "image", "composition"]);

function overlaps(model: CompositionModel): Map<string, string> {
  const found = new Map<string, string>();
  const clips = model.clips
    .filter(
      (clip) =>
        clip.track === 0 &&
        SOLID_KINDS.has(clip.kind) &&
        !clip.element.matches('[data-track-kind="captions"]'),
    )
    .sort((a, b) => a.start - b.start);
  for (const [index, clip] of clips.entries()) {
    for (const other of clips.slice(index + 1)) {
      if (other.start >= clip.end - MIN_OVERLAP) break;
      const from = Math.max(clip.start, other.start);
      const to = Math.min(clip.end, other.end);
      if (to - from < MIN_OVERLAP + EPS) continue;
      const key = [clip.id, other.id].sort().join("|");
      found.set(
        key,
        `Clips "${clip.id}" and "${other.id}" overlap on track 0 (${fmt(from)}–${fmt(to)} s): both play at once, so speech doubles and one picture hides the other. Move or trim one, or put it on another track on purpose.`,
      );
    }
  }
  return found;
}

/** Track-0 overlaps the batch created (overlaps that were already there are not repeated). */
export function overlapWarnings(before: CompositionModel, after: CompositionModel): string[] {
  const existing = overlaps(before);
  const fresh = [...overlaps(after)].filter(([key]) => !existing.has(key)).map(([, text]) => text);
  if (fresh.length <= MAX_LISTED) return fresh;
  return [
    ...fresh.slice(0, MAX_LISTED),
    `… and ${fresh.length - MAX_LISTED} more overlaps on track 0.`,
  ];
}
