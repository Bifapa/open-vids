import { isRecord, normalizeLicense, type ResearchMediaKind } from "@hyperframes/agent-protocol";
import { ResearchFailure } from "../../errors.js";
import { contentTypeFor, extensionFor, isStreamManifest, mediaKindFromUrl } from "../mediaTypes.js";
import type { AssetConnector, RawCandidate } from "../types.js";

const API_URL = "https://api.pexels.com/v1";
/** Pexels answers at most 80 results per page. */
const MAX_PAGE_SIZE = 80;
/** Photos up to this many pixels (4000 x 4000) are taken as `original`; bigger ones as the 2x `large2x` rendering. */
const MAX_ORIGINAL_PIXELS = 16_000_000;
/** Longer side of the video file we aim for: Full HD is plenty for a timeline and keeps downloads small. */
const MAX_VIDEO_SIDE = 1920;
const LICENSE = normalizeLicense({
  name: "Pexels License",
  url: "https://www.pexels.com/license/",
  confidence: "high",
  // Pexels states that everything on it is under its own license, so the API carries no per-item field.
  basis: "Pexels API (every Pexels file is under the Pexels License)",
});

type Rec = Record<string, unknown>;

function str(rec: Rec, key: string): string | null {
  const value = rec[key];
  if (typeof value !== "string") return null;
  const text = value.replace(/\s+/g, " ").trim();
  return text || null;
}

function num(rec: Rec, key: string): number | null {
  const value = rec[key];
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
}

function httpUrl(rec: Rec, key: string): string | null {
  const value = str(rec, key);
  return value && /^https?:\/\//i.test(value) ? value : null;
}

function contentTypeOf(mediaUrl: string): string | null {
  const extension = extensionFor(mediaUrl, null);
  return extension ? contentTypeFor(extension) : null;
}

/** `https://www.pexels.com/video/green-leaves-2499611/` → "Green leaves"; the newer id-only form has no words. */
function titleFromPageUrl(pageUrl: string | null): string | null {
  if (!pageUrl) return null;
  try {
    const slug = new URL(pageUrl).pathname.split("/").filter(Boolean).pop() ?? "";
    const words = slug
      .replace(/-?\d+$/, "")
      .replace(/-/g, " ")
      .trim();
    return words ? words.charAt(0).toUpperCase() + words.slice(1) : null;
  } catch {
    return null;
  }
}

function photoCandidate(item: Rec): RawCandidate | null {
  const src = isRecord(item.src) ? item.src : null;
  if (!src) return null;
  const width = num(item, "width");
  const height = num(item, "height");
  const original = httpUrl(src, "original");
  const useOriginal =
    original !== null && width !== null && height !== null && width * height <= MAX_ORIGINAL_PIXELS;
  // `large2x` is fitted into a box, so its exact size is not in the answer.
  const mediaUrl = useOriginal ? original : (httpUrl(src, "large2x") ?? original);
  if (!mediaUrl || mediaKindFromUrl(mediaUrl) !== "picture") return null;
  const alt = str(item, "alt");
  const photographer = str(item, "photographer");
  return {
    mediaKind: "picture",
    title: alt ?? "Untitled",
    description: "",
    pageUrl: httpUrl(item, "url"),
    mediaUrl,
    previewUrl: httpUrl(src, "medium"),
    author: photographer,
    authorUrl: photographer ? httpUrl(item, "photographer_url") : null,
    license: LICENSE,
    width: mediaUrl === original ? width : null,
    height: mediaUrl === original ? height : null,
    duration: null,
    bytes: null,
    contentType: contentTypeOf(mediaUrl),
  };
}

interface VideoFile {
  link: string;
  width: number;
  height: number;
  hd: boolean;
}

/** An MP4 with known dimensions; HLS renditions (`quality: "hls"`, `.m3u8`) are streams, not files. */
function readVideoFile(value: unknown): VideoFile | null {
  if (!isRecord(value)) return null;
  const link = httpUrl(value, "link");
  const width = num(value, "width");
  const height = num(value, "height");
  if (!link || width === null || height === null || isStreamManifest(link, null)) return null;
  if (str(value, "file_type")?.toLowerCase() !== "video/mp4") return null;
  if (str(value, "quality")?.toLowerCase() === "hls") return null;
  return { link, width, height, hd: str(value, "quality")?.toLowerCase() === "hd" };
}

const pixelsOf = (file: VideoFile): number => file.width * file.height;
const fitsFullHd = (file: VideoFile): boolean =>
  Math.max(file.width, file.height) <= MAX_VIDEO_SIDE;

/**
 * The largest "hd" file within Full HD (the longer side counts, so portrait clips qualify); when nothing fits, the
 * smallest file there is. Pexels labels several sizes "hd", so the dimensions decide, not the label.
 */
function pickVideoFile(files: VideoFile[]): VideoFile | null {
  const ranked = [...files].sort((a, b) => {
    if (fitsFullHd(a) !== fitsFullHd(b)) return fitsFullHd(a) ? -1 : 1;
    if (!fitsFullHd(a)) return pixelsOf(a) - pixelsOf(b);
    if (a.hd !== b.hd) return a.hd ? -1 : 1;
    return pixelsOf(b) - pixelsOf(a);
  });
  return ranked[0] ?? null;
}

function videoCandidate(item: Rec): RawCandidate | null {
  const files = Array.isArray(item.video_files) ? item.video_files : [];
  const file = pickVideoFile(files.flatMap((entry) => readVideoFile(entry) ?? []));
  if (!file) return null;
  const pageUrl = httpUrl(item, "url");
  const user = isRecord(item.user) ? item.user : null;
  const author = user ? str(user, "name") : null;
  return {
    mediaKind: "video",
    title: titleFromPageUrl(pageUrl) ?? "Untitled",
    description: "",
    pageUrl,
    mediaUrl: file.link,
    previewUrl: httpUrl(item, "image"),
    author,
    authorUrl: user && author ? httpUrl(user, "url") : null,
    license: LICENSE,
    width: file.width,
    height: file.height,
    duration: num(item, "duration"),
    bytes: null,
    contentType: "video/mp4",
  };
}

const ENDPOINT_BY_KIND: Partial<
  Record<
    ResearchMediaKind,
    { path: string; field: string; parse: (item: Rec) => RawCandidate | null }
  >
> = {
  picture: { path: "search", field: "photos", parse: photoCandidate },
  video: { path: "videos/search", field: "videos", parse: videoCandidate },
};

/**
 * Pexels photos and videos through its API (the key goes in the `Authorization` header). Every file is under the
 * Pexels License; Pexels asks for a link back and the photographer's name, which `pageUrl` and `author` carry.
 */
export const pexelsConnector: AssetConnector = {
  id: "pexels",

  async search(query, kind, limit, ctx) {
    const endpoint = ENDPOINT_BY_KIND[kind];
    if (!endpoint) return [];
    if (!ctx.apiKey) throw new ResearchFailure("invalid_request", "Pexels needs an API key");
    const pageSize = Math.max(1, Math.min(Math.floor(limit), MAX_PAGE_SIZE));
    const params = new URLSearchParams({ query, per_page: String(pageSize) });
    const json = await ctx.http.getJson(`${API_URL}/${endpoint.path}?${params.toString()}`, {
      headers: { Authorization: ctx.apiKey },
    });
    const items = isRecord(json) ? json[endpoint.field] : null;
    if (!Array.isArray(items)) {
      throw new ResearchFailure("provider_error", "Pexels answered with an unexpected document.");
    }
    const out: RawCandidate[] = [];
    for (const item of items) {
      if (!isRecord(item)) continue;
      const candidate = endpoint.parse(item);
      if (candidate) out.push(candidate);
      if (out.length >= pageSize) break;
    }
    return out;
  },
};
