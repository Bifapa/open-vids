import { isRecord, normalizeLicense, type ResearchMediaKind } from "@hyperframes/agent-protocol";
import { ResearchFailure } from "../../errors.js";
import { contentTypeFor, extensionFor, mediaKindFromUrl } from "../mediaTypes.js";
import type { AssetConnector, RawCandidate } from "../types.js";

const API_URL = "https://pixabay.com/api";
/** Pixabay takes 3-200 results per page. */
const MIN_PAGE_SIZE = 3;
const MAX_PAGE_SIZE = 200;
/** `q` may not exceed 100 characters. */
const MAX_QUERY_CHARS = 100;
/** `largeImageURL` is scaled to at most 1280 px on its longer side. */
const LARGE_IMAGE_SIDE = 1280;
/** Longer side of the video rendition we aim for: Full HD is plenty for a timeline and keeps downloads small. */
const MAX_VIDEO_SIDE = 1920;
/** Renditions from the largest to the smallest. */
const VIDEO_SIZES = ["large", "medium", "small", "tiny"];
const LICENSE = normalizeLicense({
  name: "Pixabay Content License",
  url: "https://pixabay.com/service/license-summary/",
  confidence: "high",
  // Pixabay states that everything on it is under its own license, so the API carries no per-item field.
  basis: "Pixabay API (every Pixabay file is under the Pixabay Content License)",
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

/** The contributor's profile; the id is part of the address. */
function authorUrlOf(hit: Rec, author: string | null): string | null {
  const id = num(hit, "user_id");
  return author && id !== null
    ? `https://pixabay.com/users/${encodeURIComponent(author)}-${id}/`
    : null;
}

/** Pixabay has no titles: the tags are what describes a hit. */
function titleOf(hit: Rec): string {
  return str(hit, "tags") ?? "Untitled";
}

function imageCandidate(hit: Rec): RawCandidate | null {
  const mediaUrl = httpUrl(hit, "largeImageURL");
  if (!mediaUrl || mediaKindFromUrl(mediaUrl) !== "picture") return null;
  const author = str(hit, "user");
  // Only the original's size is in the answer; the large rendering is that, scaled down to 1280 px at most.
  const fullWidth = num(hit, "imageWidth");
  const fullHeight = num(hit, "imageHeight");
  const scale =
    fullWidth !== null && fullHeight !== null
      ? Math.min(1, LARGE_IMAGE_SIDE / Math.max(fullWidth, fullHeight))
      : null;
  return {
    mediaKind: "picture",
    title: titleOf(hit),
    description: "",
    pageUrl: httpUrl(hit, "pageURL"),
    mediaUrl,
    previewUrl: httpUrl(hit, "webformatURL") ?? httpUrl(hit, "previewURL"),
    author,
    authorUrl: authorUrlOf(hit, author),
    license: LICENSE,
    width: fullWidth !== null && scale !== null ? Math.round(fullWidth * scale) : null,
    height: fullHeight !== null && scale !== null ? Math.round(fullHeight * scale) : null,
    duration: null,
    bytes: null,
    contentType: contentTypeOf(mediaUrl),
  };
}

interface Rendition {
  url: string;
  width: number | null;
  height: number | null;
  size: number | null;
  thumbnail: string | null;
}

function readRendition(videos: Rec, name: string): Rendition | null {
  const value = videos[name];
  if (!isRecord(value)) return null;
  // A rendition that does not exist comes with an empty url.
  const url = httpUrl(value, "url");
  if (!url || mediaKindFromUrl(url) !== "video") return null;
  return {
    url,
    width: num(value, "width"),
    height: num(value, "height"),
    size: num(value, "size"),
    thumbnail: httpUrl(value, "thumbnail"),
  };
}

function videoCandidate(hit: Rec): RawCandidate | null {
  const videos = isRecord(hit.videos) ? hit.videos : null;
  if (!videos) return null;
  const renditions = VIDEO_SIZES.flatMap((name) => readRendition(videos, name) ?? []);
  // The largest one within Full HD; the sizes vary with the age of the clip, so the dimensions decide, not the name.
  const file =
    renditions.find(
      (entry) =>
        entry.width !== null &&
        entry.height !== null &&
        Math.max(entry.width, entry.height) <= MAX_VIDEO_SIDE,
    ) ?? renditions[renditions.length - 1];
  if (!file) return null;
  const author = str(hit, "user");
  return {
    mediaKind: "video",
    title: titleOf(hit),
    description: "",
    pageUrl: httpUrl(hit, "pageURL"),
    mediaUrl: file.url,
    previewUrl: file.thumbnail,
    author,
    authorUrl: authorUrlOf(hit, author),
    license: LICENSE,
    width: file.width,
    height: file.height,
    duration: num(hit, "duration"),
    bytes: file.size,
    contentType: contentTypeOf(file.url),
  };
}

const ENDPOINT_BY_KIND: Partial<
  Record<ResearchMediaKind, { path: string; parse: (hit: Rec) => RawCandidate | null }>
> = {
  picture: { path: "/", parse: imageCandidate },
  video: { path: "/videos/", parse: videoCandidate },
};

/**
 * Pixabay photos, illustrations and videos through its API. The API takes the key only as a query parameter, so
 * the request URL is the one place it lives: nothing built from it goes into a candidate or an error message.
 * Every file is under the Pixabay Content License.
 */
export const pixabayConnector: AssetConnector = {
  id: "pixabay",

  async search(query, kind, limit, ctx) {
    const endpoint = ENDPOINT_BY_KIND[kind];
    if (!endpoint) return [];
    if (!ctx.apiKey) throw new ResearchFailure("invalid_request", "Pixabay needs an API key");
    const wanted = Math.max(1, Math.floor(limit));
    const params = new URLSearchParams({
      key: ctx.apiKey,
      q: query.slice(0, MAX_QUERY_CHARS),
      per_page: String(Math.max(MIN_PAGE_SIZE, Math.min(wanted, MAX_PAGE_SIZE))),
      safesearch: "true",
    });
    const json = await ctx.http.getJson(`${API_URL}${endpoint.path}?${params.toString()}`);
    const hits = isRecord(json) ? json.hits : null;
    if (!Array.isArray(hits)) {
      throw new ResearchFailure("provider_error", "Pixabay answered with an unexpected document.");
    }
    const out: RawCandidate[] = [];
    for (const hit of hits) {
      if (!isRecord(hit)) continue;
      const candidate = endpoint.parse(hit);
      if (candidate) out.push(candidate);
      if (out.length >= wanted) break;
    }
    return out;
  },
};
