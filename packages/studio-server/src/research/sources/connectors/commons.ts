import {
  isRecord,
  normalizeLicense,
  type LicenseInfo,
  type ResearchMediaKind,
} from "@hyperframes/agent-protocol";
import { ResearchFailure } from "../../errors.js";
import {
  contentTypeFor,
  extensionFor,
  isStreamManifest,
  mediaKindFromContentType,
  mediaKindFromUrl,
} from "../mediaTypes.js";
import type { AssetConnector, ConnectorContext, DescribedPage, RawCandidate } from "../types.js";

const API_URL = "https://commons.wikimedia.org/w/api.php";
const COMMONS_HOSTS = new Set(["commons.wikimedia.org", "commons.m.wikimedia.org"]);
const FILETYPE_BY_KIND: Record<ResearchMediaKind, string> = {
  video: "video",
  audio: "audio",
  picture: "bitmap",
};
/** Formats the editor reads directly; anything else (TIFF, SVG, XCF…) is offered as its 1920 px rendering. */
const NATIVE_PICTURE_TYPES = new Set(["image/jpeg", "image/png", "image/webp", "image/gif"]);
const MAX_PICTURE_PIXELS = 60_000_000;
const MAX_VIDEO_HEIGHT = 1080;
const PICTURE_THUMB_WIDTH = 1920;
const VIDEO_THUMB_WIDTH = 640;
const MAX_SEARCH_LIMIT = 50;
const MAX_DESCRIPTION_CHARS = 500;
const LICENSE_BASIS = "Wikimedia Commons API (extmetadata)";

type Rec = Record<string, unknown>;

function str(rec: Rec | null, key: string): string | null {
  const value = rec?.[key];
  return typeof value === "string" && value.trim() ? value : null;
}

function num(rec: Rec | null, key: string): number | null {
  const value = rec?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function positive(value: number | null): number | null {
  return value !== null && value > 0 ? value : null;
}

function firstRecord(value: unknown): Rec | null {
  if (!Array.isArray(value)) return null;
  const first: unknown = value[0];
  return isRecord(first) ? first : null;
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
};

function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, body: string) => {
    if (body.startsWith("#")) {
      const code =
        body[1]?.toLowerCase() === "x" ? parseInt(body.slice(2), 16) : Number(body.slice(1));
      return Number.isInteger(code) && code > 0 && code <= 0x10ffff
        ? String.fromCodePoint(code)
        : whole;
    }
    return NAMED_ENTITIES[body.toLowerCase()] ?? whole;
  });
}

/** Extmetadata values are HTML fragments: drop tags and comments, decode entities, collapse whitespace. */
function htmlToText(html: string): string {
  const withoutTags = html
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, "")
    .replace(/<\/?(br|p|div|li|tr)\b[^>]*>/gi, " ")
    .replace(/<[^>]*>/g, "");
  return decodeEntities(withoutTags).replace(/\s+/g, " ").trim();
}

function metaText(meta: Rec, key: string): string | null {
  const entry = meta[key];
  const raw = isRecord(entry) ? entry.value : undefined;
  const text =
    typeof raw === "string" ? htmlToText(raw) : typeof raw === "number" ? String(raw) : "";
  return text || null;
}

function metaRaw(meta: Rec, key: string): string | null {
  const entry = meta[key];
  return isRecord(entry) && typeof entry.value === "string" ? entry.value : null;
}

/** The author's own page, when the Artist markup links one (red links to a missing user page do not count). */
function authorUrlOf(meta: Rec): string | null {
  const html = metaRaw(meta, "Artist");
  const href = html ? /<a\b[^>]*?\bhref\s*=\s*["']([^"']+)["']/i.exec(html)?.[1] : undefined;
  if (!href) return null;
  try {
    const url = new URL(decodeEntities(href), "https://commons.wikimedia.org/");
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    if (url.searchParams.has("redlink")) return null;
    return url.href;
  } catch {
    return null;
  }
}

function licenseOf(meta: Rec): LicenseInfo {
  const name = metaText(meta, "LicenseShortName") ?? metaText(meta, "License");
  const url = metaText(meta, "LicenseUrl");
  if (!name && !url) return normalizeLicense({ confidence: "none", basis: LICENSE_BASIS });
  // The API states the license field-by-field; without a license URL there is nothing to verify it against.
  return normalizeLicense({ name, url, confidence: url ? "high" : "medium", basis: LICENSE_BASIS });
}

function cleanTitle(fileTitle: string): string {
  return fileTitle
    .replace(/^file:/i, "")
    .replace(/\.[a-z0-9]{2,5}$/i, "")
    .replaceAll("_", " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Drops the `utm_*` tracking parameters the API appends to every file URL. */
function cleanUrl(value: string): string {
  try {
    const url = new URL(value);
    for (const key of [...url.searchParams.keys()])
      if (key.startsWith("utm_")) url.searchParams.delete(key);
    return url.href;
  } catch {
    return value;
  }
}

function isHttpUrl(value: string): boolean {
  return /^https?:\/\//i.test(value);
}

function samePath(a: string, b: string): boolean {
  try {
    return new URL(a).pathname === new URL(b).pathname;
  } catch {
    return false;
  }
}

function baseType(type: string | null): string | null {
  return type?.split(";")[0]?.trim().toLowerCase() || null;
}

interface PickedMedia {
  url: string;
  contentType: string | null;
  bytes: number | null;
  width: number | null;
  height: number | null;
}

function kindOfInfo(info: Rec): ResearchMediaKind | null {
  switch (str(info, "mediatype")?.toUpperCase()) {
    case "VIDEO":
      return "video";
    case "AUDIO":
      return "audio";
    case "BITMAP":
    case "DRAWING":
      return "picture";
    default:
      return mediaKindFromContentType(str(info, "mime"));
  }
}

function isPlaceholderThumb(url: string): boolean {
  return url.includes("/file-type-icons/");
}

function pickPicture(info: Rec): PickedMedia | null {
  const url = str(info, "url");
  const mime = baseType(str(info, "mime"));
  const width = positive(num(info, "width"));
  const height = positive(num(info, "height"));
  const pixels = (width ?? 0) * (height ?? 0);
  if (url && mime && NATIVE_PICTURE_TYPES.has(mime) && pixels <= MAX_PICTURE_PIXELS) {
    return {
      url: cleanUrl(url),
      contentType: mime,
      bytes: positive(num(info, "size")),
      width,
      height,
    };
  }
  const thumb = str(info, "thumburl");
  if (!thumb || isPlaceholderThumb(thumb)) return null;
  const extension = extensionFor(thumb, null);
  return {
    url: cleanUrl(thumb),
    contentType: extension ? contentTypeFor(extension) : null,
    bytes: null,
    width: positive(num(info, "thumbwidth")),
    height: positive(num(info, "thumbheight")),
  };
}

function derivativesOf(videoinfo: Rec | null): Rec[] {
  const list = videoinfo?.derivatives;
  return Array.isArray(list) ? list.filter(isRecord) : [];
}

function pickVideo(info: Rec, videoinfo: Rec | null): PickedMedia | null {
  const originalUrl = str(videoinfo, "url") ?? str(info, "url");
  const size = positive(num(videoinfo, "size") ?? num(info, "size"));
  const fromDerivative = (type: string): PickedMedia | null => {
    let best: Rec | null = null;
    let bestHeight = 0;
    for (const derivative of derivativesOf(videoinfo)) {
      const src = str(derivative, "src");
      const height = positive(num(derivative, "height"));
      if (!src || !isHttpUrl(src) || height === null || height > MAX_VIDEO_HEIGHT) continue;
      if (baseType(str(derivative, "type")) !== type || height <= bestHeight) continue;
      best = derivative;
      bestHeight = height;
    }
    const src = str(best, "src");
    if (!best || !src) return null;
    return {
      url: cleanUrl(src),
      contentType: type,
      bytes: originalUrl && samePath(src, originalUrl) ? size : null,
      width: positive(num(best, "width")),
      height: bestHeight,
    };
  };
  const transcoded = fromDerivative("video/mp4") ?? fromDerivative("video/webm");
  if (transcoded) return transcoded;
  const mime = baseType(str(videoinfo, "mime") ?? str(info, "mime"));
  if (originalUrl && (mime === "video/mp4" || mime === "video/webm")) {
    return {
      url: cleanUrl(originalUrl),
      contentType: mime,
      bytes: size,
      width: positive(num(videoinfo, "width") ?? num(info, "width")),
      height: positive(num(videoinfo, "height") ?? num(info, "height")),
    };
  }
  return null;
}

function pickAudio(info: Rec, videoinfo: Rec | null): PickedMedia | null {
  const originalUrl = str(videoinfo, "url") ?? str(info, "url");
  const mime = baseType(str(videoinfo, "mime") ?? str(info, "mime"));
  const size = positive(num(videoinfo, "size") ?? num(info, "size"));
  if (originalUrl && mediaKindFromUrl(originalUrl) === "audio") {
    return {
      url: cleanUrl(originalUrl),
      contentType: mime === "application/ogg" ? "audio/ogg" : mime,
      bytes: size,
      width: null,
      height: null,
    };
  }
  // MIDI and other formats the editor cannot read: fall back to the transcoded MP3/Ogg.
  for (const type of ["audio/mpeg", "audio/ogg"]) {
    const found = derivativesOf(videoinfo).find(
      (derivative) =>
        baseType(str(derivative, "type")) === type && isHttpUrl(str(derivative, "src") ?? ""),
    );
    const src = str(found ?? null, "src");
    if (src)
      return { url: cleanUrl(src), contentType: type, bytes: null, width: null, height: null };
  }
  return null;
}

interface CommonsPage {
  index: number;
  title: string;
  info: Rec;
  videoinfo: Rec | null;
}

function readPages(json: unknown): CommonsPage[] {
  if (!isRecord(json))
    throw new ResearchFailure(
      "provider_error",
      "Wikimedia Commons answered with an unexpected document.",
    );
  if (isRecord(json.error)) {
    const info = str(json.error, "info") ?? str(json.error, "code") ?? "unknown error";
    throw new ResearchFailure("provider_error", `Wikimedia Commons API error: ${info}`);
  }
  const pages = isRecord(json.query) ? json.query.pages : undefined;
  if (!Array.isArray(pages)) return [];
  const out: CommonsPage[] = [];
  for (const page of pages) {
    if (!isRecord(page)) continue;
    const title = str(page, "title");
    const info = firstRecord(page.imageinfo);
    if (!title || !info) continue;
    out.push({
      index: num(page, "index") ?? Number.MAX_SAFE_INTEGER,
      title,
      info,
      videoinfo: firstRecord(page.videoinfo),
    });
  }
  return out.sort((a, b) => a.index - b.index);
}

function toCandidate(page: CommonsPage, kind: ResearchMediaKind): RawCandidate | null {
  const { info, videoinfo } = page;
  const media =
    kind === "picture"
      ? pickPicture(info)
      : kind === "video"
        ? pickVideo(info, videoinfo)
        : pickAudio(info, videoinfo);
  if (!media || !isHttpUrl(media.url) || isStreamManifest(media.url, media.contentType))
    return null;
  const meta = isRecord(info.extmetadata) ? info.extmetadata : {};
  const credit = metaText(meta, "Credit");
  const author =
    metaText(meta, "Artist") ?? (credit && !/^own work$/i.test(credit) ? credit : null);
  const thumb = str(info, "thumburl");
  const duration =
    kind === "picture" ? null : positive(num(videoinfo, "duration") ?? num(info, "duration"));
  const pageUrl = str(info, "descriptionurl");
  return {
    mediaKind: kind,
    title: metaText(meta, "ObjectName") ?? cleanTitle(page.title),
    description: (metaText(meta, "ImageDescription") ?? "").slice(0, MAX_DESCRIPTION_CHARS),
    pageUrl: pageUrl ? cleanUrl(pageUrl) : null,
    mediaUrl: media.url,
    previewUrl: thumb && isHttpUrl(thumb) && !isPlaceholderThumb(thumb) ? cleanUrl(thumb) : null,
    author,
    authorUrl: author ? authorUrlOf(meta) : null,
    license: licenseOf(meta),
    width: media.width,
    height: media.height,
    duration: duration === null ? null : Math.round(duration * 1000) / 1000,
    bytes: media.bytes,
    contentType: media.contentType,
  };
}

function queryUrl(params: Record<string, string>): string {
  const search = new URLSearchParams({
    format: "json",
    formatversion: "2",
    action: "query",
    ...params,
  });
  return `${API_URL}?${search.toString()}`;
}

/** The `File:` title a Commons page URL names, or null for any other URL. */
function fileTitleOf(url: URL): string | null {
  if (!COMMONS_HOSTS.has(url.hostname.toLowerCase())) return null;
  let raw: string | null = null;
  if (url.pathname.startsWith("/wiki/")) {
    try {
      raw = decodeURIComponent(url.pathname.slice("/wiki/".length));
    } catch {
      return null;
    }
  } else if (url.pathname === "/w/index.php") {
    raw = url.searchParams.get("title");
  }
  const name = /^file:(.+)$/i.exec(raw?.replaceAll("_", " ").trim() ?? "")?.[1]?.trim();
  return name ? `File:${name}` : null;
}

/** Wikimedia Commons through the MediaWiki API: license, author and description come from `extmetadata`. */
export const commonsConnector: AssetConnector = {
  id: "wikimedia_commons",

  async search(query, kind, limit, ctx) {
    const wanted = Math.max(1, Math.min(Math.floor(limit), MAX_SEARCH_LIMIT));
    const params: Record<string, string> = {
      generator: "search",
      gsrnamespace: "6",
      gsrsearch: `${query} filetype:${FILETYPE_BY_KIND[kind]}`,
      gsrlimit: String(wanted),
      prop: kind === "picture" ? "imageinfo" : "imageinfo|videoinfo",
      iiprop: "url|size|mime|extmetadata|mediatype",
    };
    if (kind !== "audio") {
      params.iiurlwidth = String(kind === "picture" ? PICTURE_THUMB_WIDTH : VIDEO_THUMB_WIDTH);
    }
    if (kind !== "picture") params.viprop = "derivatives|url|size|mime|mediatype";
    const pages = readPages(await ctx.http.getJson(queryUrl(params)));
    const out: RawCandidate[] = [];
    for (const page of pages) {
      if (kindOfInfo(page.info) !== kind) continue;
      const candidate = toCandidate(page, kind);
      if (candidate) out.push(candidate);
      if (out.length >= wanted) break;
    }
    return out.slice(0, limit);
  },

  async describeUrl(url, kind, ctx: ConnectorContext): Promise<DescribedPage | null> {
    const title = fileTitleOf(url);
    if (!title) return null;
    const pages = readPages(
      await ctx.http.getJson(
        queryUrl({
          titles: title,
          redirects: "1",
          prop: "imageinfo|videoinfo",
          iiprop: "url|size|mime|extmetadata|mediatype",
          iiurlwidth: String(PICTURE_THUMB_WIDTH),
          viprop: "derivatives|url|size|mime|mediatype",
        }),
      ),
    );
    const page = pages[0];
    const none = normalizeLicense({ confidence: "none", basis: LICENSE_BASIS });
    if (!page) {
      return {
        title: null,
        author: null,
        license: none,
        candidates: [],
        notes: [`${title} was not found on Wikimedia Commons.`],
      };
    }
    const found = kindOfInfo(page.info);
    const candidate = found ? toCandidate(page, found) : null;
    const notes: string[] = [];
    if (!found) notes.push(`${title} is not an image, video or audio file.`);
    else if (!candidate) notes.push(`${title} has no file version that OpenVids can import.`);
    else if (kind && found !== kind)
      notes.push(
        `${title} is ${found === "audio" ? "an" : "a"} ${found} file, not ${kind === "audio" ? "an" : "a"} ${kind}.`,
      );
    const usable = candidate && (!kind || found === kind) ? candidate : null;
    return {
      title: candidate?.title ?? cleanTitle(page.title),
      author: candidate?.author ?? null,
      license: candidate?.license ?? none,
      candidates: usable ? [usable] : [],
      notes,
    };
  },
};
