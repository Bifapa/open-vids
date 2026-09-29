import { parseTimelineFromDOM } from "./timelineDOM";
import { readTimelineDurationFromDocument } from "./timelineElementHelpers";

/** How many timeline clips (and how many media clips) a painted preview document holds. */
export function readPreviewComplexity(doc: Document | null | undefined): {
  clip_count: number;
  media_clip_count: number;
} {
  if (!doc) return { clip_count: 0, media_clip_count: 0 };
  const elements = parseTimelineFromDOM(doc, readTimelineDurationFromDocument(doc));
  return {
    clip_count: elements.length,
    media_clip_count: elements.filter(({ tag }) => tag === "video" || tag === "audio").length,
  };
}
