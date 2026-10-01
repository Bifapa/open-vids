import type { TimelineElement } from "../store/playerStore";
import { isAudioTimelineElement } from "../../utils/timelineInspector";

/** What a clip IS, for its colour on the timeline (`k-*` tokens) and its head glyph. */
export type TimelineClipKind = "video" | "audio" | "image" | "motion" | "caption";

type TrackKind = "video" | "audio" | "motion" | "caption";

const CAPTION_PATTERN = /caption|subtitle/i;

export function timelineClipKind(element: TimelineElement): TimelineClipKind {
  if (isAudioTimelineElement(element)) return "audio";
  const tag = element.tag.toLowerCase();
  if (tag === "video") return "video";
  if (tag === "img") return "image";
  if (
    element.timelineRole === "caption" ||
    CAPTION_PATTERN.test(`${element.compositionSrc ?? ""} ${element.domId ?? element.id}`)
  ) {
    return "caption";
  }
  return "motion";
}

function trackKind(elements: readonly TimelineElement[]): TrackKind {
  const kinds = elements.map(timelineClipKind);
  if (kinds.includes("audio")) return "audio";
  if (kinds.includes("video") || kinds.includes("image")) return "video";
  if (kinds.length > 0 && kinds.every((kind) => kind === "caption")) return "caption";
  return "motion";
}

const WORD_CODES: Record<"motion" | "caption", string> = { caption: "CAP", motion: "MOT" };

/**
 * The kind code every track head shows, the way an editor reads tracks: video
 * counts up from the bottom (V1 is the main track), audio counts down from the
 * top, and captions and motion carry a word code, numbered only when there is
 * more than one.
 */
export function buildTimelineTrackCodes(
  tracks: ReadonlyArray<readonly [number, readonly TimelineElement[]]>,
  displayOrder: readonly number[],
): Map<number, string> {
  const byTrack = new Map(tracks);
  const ordered = displayOrder.map((track) => ({
    track,
    kind: trackKind(byTrack.get(track) ?? []),
  }));
  const totals = new Map<TrackKind, number>();
  for (const row of ordered) totals.set(row.kind, (totals.get(row.kind) ?? 0) + 1);
  const seen = new Map<TrackKind, number>();
  const codes = new Map<number, string>();
  for (const row of ordered) {
    const index = (seen.get(row.kind) ?? 0) + 1;
    seen.set(row.kind, index);
    const total = totals.get(row.kind) ?? 1;
    if (row.kind === "video") codes.set(row.track, `V${total - index + 1}`);
    else if (row.kind === "audio") codes.set(row.track, `A${index}`);
    else codes.set(row.track, total > 1 ? `${WORD_CODES[row.kind]}${index}` : WORD_CODES[row.kind]);
  }
  return codes;
}
