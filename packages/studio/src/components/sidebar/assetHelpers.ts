import { AUDIO_EXT, IMAGE_EXT, VIDEO_EXT, FONT_EXT } from "@hyperframes/core/media-types";

export type MediaCategory = "audio" | "images" | "video" | "fonts";

export function getCategory(path: string): MediaCategory | null {
  if (AUDIO_EXT.test(path)) return "audio";
  if (IMAGE_EXT.test(path)) return "images";
  if (VIDEO_EXT.test(path)) return "video";
  if (FONT_EXT.test(path)) return "fonts";
  return null;
}

export function getAudioSubtype(path: string): string {
  const lower = path.toLowerCase();
  if (lower.includes("/bgm/") || lower.includes("/music/")) return "BGM";
  if (lower.includes("/sfx/") || lower.includes("/sound")) return "SFX";
  if (lower.includes("/voice/") || lower.includes("/narrat")) return "Voice";
  return "Audio";
}

export function basename(path: string): string {
  const name = path.split("/").pop() ?? path;
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(0, dot) : name;
}

/** Last path segment WITH its extension (basename() strips it). */
export function filename(path: string): string {
  return path.split("/").pop() ?? path;
}

/** Feedback shown on an asset row/card after a copy-path attempt. */
export type CopyFeedback = { path: string; ok: boolean } | null;

export function ext(path: string): string {
  const name = path.split("/").pop() ?? path;
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1).toUpperCase() : "";
}

/**
 * Format a duration in seconds as MM:SS. Returns an empty string for
 * non-positive, NaN, or Infinity values. Pure — unit-tested.
 */
export function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return "";
  const total = Math.round(seconds);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

/** Section headings, in the order the panel lists them. */
export const CATEGORY_LABELS: Record<MediaCategory, string> = {
  video: "Video",
  images: "Images",
  audio: "Audio",
  fonts: "Fonts",
};

/** Type filter segment labels (the prototype's All · Video · Image · Audio · Fonts). */
export const FILTER_LABELS: Record<MediaCategory, string> = {
  video: "Video",
  images: "Image",
  audio: "Audio",
  fonts: "Fonts",
};

export const FILTER_ORDER: MediaCategory[] = ["video", "images", "audio", "fonts"];

/**
 * The prototype's `.sel-item`: a tile or row that lifts on hover and rings on
 * keyboard focus. Shared by every asset tile, row and font row.
 */
export const ASSET_ITEM_CLASS = [
  "group rounded-md border border-transparent outline-hidden select-none",
  "hover:border-border-subtle hover:bg-surface-1",
  "focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent",
].join(" ");

/** The prototype's `.thumb`: a 16:9 well with an inner hairline over the media. */
export const ASSET_THUMB_CLASS = [
  "relative aspect-video overflow-hidden rounded-xs bg-surface-1",
  "after:pointer-events-none after:absolute after:inset-0 after:rounded-[inherit] after:content-['']",
  "after:shadow-[inset_0_0_0_1px_var(--color-edge-hi)]",
].join(" ");

/** Name text of a row or tile: secondary at rest, primary on hover. */
export const ASSET_NAME_CLASS = "min-w-0 truncate text-fg-2 group-hover:text-fg";
