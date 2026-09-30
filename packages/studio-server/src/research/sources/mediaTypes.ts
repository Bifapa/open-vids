import type { ResearchMediaKind } from "@hyperframes/agent-protocol";

const VIDEO_EXT = new Set(["mp4", "m4v", "mov", "webm", "mkv", "ogv", "avi", "mpg", "mpeg"]);
const IMAGE_EXT = new Set([
  "jpg",
  "jpeg",
  "png",
  "webp",
  "gif",
  "avif",
  "svg",
  "tif",
  "tiff",
  "bmp",
]);
const AUDIO_EXT = new Set([
  "mp3",
  "m4a",
  "aac",
  "wav",
  "ogg",
  "oga",
  "opus",
  "flac",
  "aif",
  "aiff",
]);

/** Adaptive-streaming manifests: pieces of a stream, not a file (and often protected). Never downloaded. */
const STREAM_EXT = /\.(m3u8|mpd|ism)$/i;
const STREAM_TYPES = /mpegurl|dash\+xml|vnd\.ms-sstr/i;

function extensionOf(url: string): string {
  try {
    const name = new URL(url).pathname.split("/").pop() ?? "";
    const dot = name.lastIndexOf(".");
    return dot < 0 ? "" : name.slice(dot + 1).toLowerCase();
  } catch {
    return "";
  }
}

/** The media kind a URL's file extension names, or null. */
export function mediaKindFromUrl(url: string): ResearchMediaKind | null {
  const ext = extensionOf(url);
  if (VIDEO_EXT.has(ext)) return "video";
  if (IMAGE_EXT.has(ext)) return "picture";
  if (AUDIO_EXT.has(ext)) return "audio";
  return null;
}

/** The media kind a Content-Type names, or null (HTML, JSON, octet-stream…). */
export function mediaKindFromContentType(contentType: string | null): ResearchMediaKind | null {
  const type = contentType?.split(";")[0]?.trim().toLowerCase() ?? "";
  if (type.startsWith("video/")) return "video";
  if (type.startsWith("image/")) return "picture";
  if (type.startsWith("audio/")) return "audio";
  if (type === "application/ogg") return "audio";
  return null;
}

/** Whether a URL or Content-Type is an HLS/DASH/Smooth-Streaming manifest. */
export function isStreamManifest(url: string, contentType: string | null): boolean {
  let path = url;
  try {
    path = new URL(url).pathname;
  } catch {
    // Not a URL: test the raw text.
  }
  return STREAM_EXT.test(path) || (contentType !== null && STREAM_TYPES.test(contentType));
}

/** Whether a Content-Type is an HTML page. */
export function isHtmlType(contentType: string | null): boolean {
  return /^(text\/html|application\/xhtml\+xml)\b/i.test(contentType?.trim() ?? "");
}

const EXT_BY_TYPE: Record<string, string> = {
  "video/mp4": "mp4",
  "video/quicktime": "mov",
  "video/webm": "webm",
  "video/ogg": "ogv",
  "video/x-matroska": "mkv",
  "video/mpeg": "mpg",
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/gif": "gif",
  "image/avif": "avif",
  "image/svg+xml": "svg",
  "image/tiff": "tif",
  "image/bmp": "bmp",
  "audio/mpeg": "mp3",
  "audio/mp3": "mp3",
  "audio/mp4": "m4a",
  "audio/x-m4a": "m4a",
  "audio/aac": "aac",
  "audio/wav": "wav",
  "audio/x-wav": "wav",
  "audio/wave": "wav",
  "audio/ogg": "ogg",
  "audio/opus": "opus",
  "audio/flac": "flac",
};

/** A file extension (no dot) for downloaded bytes: from the URL when it names media, else from the Content-Type. */
export function extensionFor(url: string, contentType: string | null): string | null {
  const fromUrl = extensionOf(url);
  if (VIDEO_EXT.has(fromUrl) || IMAGE_EXT.has(fromUrl) || AUDIO_EXT.has(fromUrl)) return fromUrl;
  const type = contentType?.split(";")[0]?.trim().toLowerCase() ?? "";
  return EXT_BY_TYPE[type] ?? null;
}

/** Content-Type for a media file extension (no dot), when the server's own is missing or generic. */
export function contentTypeFor(extension: string): string | null {
  const ext = extension.toLowerCase();
  for (const [type, known] of Object.entries(EXT_BY_TYPE)) if (known === ext) return type;
  return null;
}
