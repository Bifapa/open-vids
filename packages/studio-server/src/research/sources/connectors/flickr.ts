import {
  isRecord,
  normalizeLicense,
  type LicenseInfo,
  type ResearchMediaKind,
} from "@hyperframes/agent-protocol";
import { ResearchFailure } from "../../errors.js";
import { clip, htmlToText } from "../htmlText.js";
import { contentTypeFor, extensionFor, mediaKindFromUrl } from "../mediaTypes.js";
import type { AssetConnector, ConnectorContext, RawCandidate } from "../types.js";

const API_URL = "https://api.flickr.com/services/rest/";
const MAX_PER_PAGE = 100;
const MAX_IN_FLIGHT = 4;
const MAX_DESCRIPTION_CHARS = 500;
const BASIS = "Flickr API (photo license)";
const EXTRAS = [
  "license",
  "owner_name",
  "description",
  "media",
  "url_m",
  "url_c",
  "url_l",
  "url_h",
  "url_k",
  "url_o",
].join(",");
/** Largest first. `h`/`k` (1600/2048 px) are absent when the owner restricts big sizes; `o` is the upload itself. */
const PHOTO_SIZES = ["k", "h", "l", "c", "o"] as const;
const PREVIEW_FIELDS = ["url_m", "url_c", "url_l"] as const;
/**
 * `flickr.photos.getSizes` labels of the MP4 renditions an anonymous caller gets, best first. The other labels are
 * a Flash player page and bare-bitrate renditions without dimensions.
 */
const VIDEO_LABELS = [
  "Video Original",
  "1080p",
  "HD MP4",
  "720p",
  "Site MP4",
  "360p",
  "Mobile MP4",
  "288p",
];

/**
 * The reusable Flickr licenses, by `flickr.photos.licenses.getInfo` id. Everything else (all rights reserved,
 * non-commercial, no-derivatives) is neither asked for nor accepted. Ids 7 and 8 are declarations of a status rather
 * than a license grant, hence medium confidence.
 */
const LICENSES: Record<string, LicenseInfo> = {
  "4": normalizeLicense({
    name: "CC BY 2.0",
    url: "https://creativecommons.org/licenses/by/2.0/",
    confidence: "high",
    basis: BASIS,
  }),
  "5": normalizeLicense({
    name: "CC BY-SA 2.0",
    url: "https://creativecommons.org/licenses/by-sa/2.0/",
    confidence: "high",
    basis: BASIS,
  }),
  // Flickr Commons' "no known copyright restrictions" is the "No Known Copyright" (NKC) rights statement.
  "7": normalizeLicense({
    name: "No known copyright restrictions",
    url: "http://rightsstatements.org/vocab/NKC/1.0/",
    confidence: "medium",
    basis: BASIS,
  }),
  "8": normalizeLicense({
    name: "Public domain (United States Government Work)",
    url: "https://www.usa.gov/government-copyright",
    confidence: "medium",
    basis: BASIS,
  }),
  "9": normalizeLicense({
    name: "CC0 1.0",
    url: "https://creativecommons.org/publicdomain/zero/1.0/",
    confidence: "high",
    basis: BASIS,
  }),
  "10": normalizeLicense({
    name: "Public Domain Mark 1.0",
    url: "https://creativecommons.org/publicdomain/mark/1.0/",
    confidence: "high",
    basis: BASIS,
  }),
  "11": normalizeLicense({
    name: "CC BY 4.0",
    url: "https://creativecommons.org/licenses/by/4.0/",
    confidence: "high",
    basis: BASIS,
  }),
  "12": normalizeLicense({
    name: "CC BY-SA 4.0",
    url: "https://creativecommons.org/licenses/by-sa/4.0/",
    confidence: "high",
    basis: BASIS,
  }),
};

type Rec = Record<string, unknown>;

function str(rec: Rec, key: string): string | null {
  const value = rec[key];
  if (typeof value !== "string") return null;
  const text = value.replace(/\s+/g, " ").trim();
  return text || null;
}

/** Flickr writes numbers as numbers or as strings, depending on the method; blank means unknown. */
function num(rec: Rec, key: string): number | null {
  const value = rec[key];
  const number = typeof value === "string" && value.trim() ? Number(value) : value;
  return typeof number === "number" && Number.isFinite(number) && number > 0 ? number : null;
}

/** Flickr says `https` or `http` for the same CDN hosts; files and play pages are only ever fetched over https. */
function httpsUrl(rec: Rec, key: string): string | null {
  const value = str(rec, key);
  return value && /^https?:\/\//i.test(value) ? value.replace(/^http:/i, "https:") : null;
}

/** Runs `work` over `items` with a bounded number in flight; the results keep the items' order. */
async function mapBounded<T, R>(
  items: readonly T[],
  width: number,
  work: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const index = next;
      next += 1;
      const item = items[index];
      if (item !== undefined) results[index] = await work(item);
    }
  };
  await Promise.all(Array.from({ length: Math.min(width, items.length) }, worker));
  return results;
}

/** The API answer's `stat: "ok"` body, or the failure Flickr reports (a bad key, an outage). */
function unwrap(json: unknown): Rec {
  if (!isRecord(json)) {
    throw new ResearchFailure("provider_error", "Flickr answered with an unexpected document.");
  }
  if (json.stat === "ok") return json;
  const message = str(json, "message") ?? "unknown error";
  // 100: the key is not valid (or was revoked); the same would be true for every call.
  if (num(json, "code") === 100) {
    throw new ResearchFailure("invalid_request", "Flickr rejected the API key");
  }
  throw new ResearchFailure("provider_error", `Flickr could not search: ${message}`);
}

function apiUrl(params: Record<string, string>, apiKey: string): string {
  // The key is part of the API request only; candidates are built from the answer, never from this URL.
  return `${API_URL}?${new URLSearchParams({ ...params, api_key: apiKey, format: "json", nojsoncallback: "1" }).toString()}`;
}

/** The largest still-photo rendering the search listed: its URL and size. */
function pickPhoto(item: Rec): { url: string; width: number | null; height: number | null } | null {
  for (const size of PHOTO_SIZES) {
    const url = httpsUrl(item, `url_${size}`);
    if (!url || mediaKindFromUrl(url) === "video") continue;
    return { url, width: num(item, `width_${size}`), height: num(item, `height_${size}`) };
  }
  return null;
}

/** The best MP4 rendition of a video through `flickr.photos.getSizes`, or null. */
async function pickVideo(
  id: string,
  apiKey: string,
  ctx: ConnectorContext,
): Promise<{ url: string; width: number | null; height: number | null } | null> {
  let body: Rec;
  try {
    body = unwrap(
      await ctx.http.getJson(apiUrl({ method: "flickr.photos.getSizes", photo_id: id }, apiKey)),
    );
  } catch (error) {
    // One video that cannot be sized does not sink the search; a cancelled search does.
    if (ctx.signal?.aborted) throw error;
    return null;
  }
  const sizes = isRecord(body.sizes) && Array.isArray(body.sizes.size) ? body.sizes.size : [];
  const videos = sizes.filter(isRecord).flatMap((size) => {
    const label = str(size, "label");
    const url = httpsUrl(size, "source");
    const rank = label === null ? -1 : VIDEO_LABELS.indexOf(label);
    // `/play/<rendition>/<secret>/` answers with the MP4 file; the Flash player page is not a file.
    return size.media === "video" && rank >= 0 && url && /\/play\//.test(url)
      ? [{ rank, url, width: num(size, "width"), height: num(size, "height") }]
      : [];
  });
  const best = videos.sort((a, b) => a.rank - b.rank)[0];
  return best ? { url: best.url, width: best.width, height: best.height } : null;
}

function descriptionOf(item: Rec): string {
  const description = isRecord(item.description) ? str(item.description, "_content") : null;
  return description ? clip(htmlToText(description), MAX_DESCRIPTION_CHARS) : "";
}

interface Found {
  item: Rec;
  id: string;
  license: LicenseInfo;
  ownerPath: string;
}

/** The items worth turning into candidates: public, of the asked media type and under a reusable license. */
function readItems(body: Rec, kind: ResearchMediaKind): Found[] {
  const photos = isRecord(body.photos) ? body.photos : null;
  if (!photos || !Array.isArray(photos.photo)) {
    throw new ResearchFailure("provider_error", "Flickr answered with an unexpected document.");
  }
  return photos.photo.filter(isRecord).flatMap((item) => {
    const id = str(item, "id");
    const owner = str(item, "owner");
    const licenseId =
      typeof item.license === "number" ? String(item.license) : str(item, "license");
    const license = licenseId === null ? undefined : LICENSES[licenseId];
    // `media` is only "video" for videos; a missing field means the request's own filter applied.
    const isVideo = str(item, "media") === "video";
    if (!id || !owner || !license || isVideo !== (kind === "video")) return [];
    return [{ item, id, license, ownerPath: encodeURIComponent(owner).replaceAll("%40", "@") }];
  });
}

function candidateOf(
  { item, id, license, ownerPath }: Found,
  kind: ResearchMediaKind,
  file: { url: string; width: number | null; height: number | null },
): RawCandidate {
  const previewUrl =
    PREVIEW_FIELDS.map((field) => httpsUrl(item, field)).find((url) => url !== null) ?? null;
  const extension = extensionFor(file.url, null);
  return {
    mediaKind: kind,
    title: str(item, "title") ?? "Untitled",
    description: descriptionOf(item),
    pageUrl: `https://www.flickr.com/photos/${ownerPath}/${encodeURIComponent(id)}`,
    mediaUrl: file.url,
    previewUrl,
    author: str(item, "ownername"),
    authorUrl: `https://www.flickr.com/people/${ownerPath}/`,
    license,
    width: file.width,
    height: file.height,
    duration: null,
    bytes: null,
    // A video play URL carries no extension: the file it answers with is MP4.
    contentType: kind === "video" ? "video/mp4" : extension ? contentTypeFor(extension) : null,
  };
}

/** Flickr photos and videos through the Flickr API, restricted to reusable licenses. Needs the user's API key. */
export const flickrConnector: AssetConnector = {
  id: "flickr",

  async search(query, kind, limit, ctx) {
    if (kind === "audio") return [];
    if (!ctx.apiKey) throw new ResearchFailure("invalid_request", "Flickr needs an API key");
    const perPage = Math.max(1, Math.min(Math.floor(limit), MAX_PER_PAGE));
    const params: Record<string, string> = {
      method: "flickr.photos.search",
      text: query,
      license: Object.keys(LICENSES).join(","),
      media: kind === "video" ? "videos" : "photos",
      extras: EXTRAS,
      per_page: String(perPage),
      sort: "relevance",
      safe_search: "1",
    };
    // Screenshots and artwork renders are photo content types; videos have their own filter and need none here.
    if (kind === "picture") params.content_types = "0";
    const items = readItems(unwrap(await ctx.http.getJson(apiUrl(params, ctx.apiKey))), kind).slice(
      0,
      perPage,
    );

    if (kind === "picture") {
      return items.flatMap((found) => {
        const file = pickPhoto(found.item);
        return file ? [candidateOf(found, kind, file)] : [];
      });
    }
    const apiKey = ctx.apiKey;
    const files = await mapBounded(items, MAX_IN_FLIGHT, (found) =>
      pickVideo(found.id, apiKey, ctx),
    );
    return items.flatMap((found, index) => {
      const file = files[index];
      return file ? [candidateOf(found, kind, file)] : [];
    });
  },
};
