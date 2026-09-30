import { isRecord, normalizeLicense, type ResearchMediaKind } from "@hyperframes/agent-protocol";
import { ResearchFailure } from "../../errors.js";
import { contentTypeFor, extensionFor, isStreamManifest, mediaKindFromUrl } from "../mediaTypes.js";
import type { AssetConnector, RawCandidate } from "../types.js";

const API_URL = "https://api.openverse.org/v1";
/** Anonymous Openverse clients may ask for at most 20 results per page. */
const MAX_PAGE_SIZE = 20;
const LICENSE_BASIS = "Openverse API (license field)";
const ENDPOINT_BY_KIND: Partial<Record<ResearchMediaKind, string>> = {
  picture: "images",
  audio: "audio",
};
/** Provider-specific `filetype` spellings that are plain aliases of a known extension (Jamendo's MP3 streams). */
const FILETYPE_ALIASES: Record<string, string> = {
  mp31: "mp3",
  mp32: "mp3",
  jpeg: "jpg",
  tiff: "tif",
};

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

/** `by-sa` + `4.0` → "CC BY-SA 4.0"; `cc0` → "CC0"; `pdm` → "Public Domain Mark"; anything else as Openverse wrote it. */
function licenseName(license: string, version: string | null): string {
  const id = license.toLowerCase();
  if (id === "cc0") return "CC0";
  if (id === "pdm") return "Public Domain Mark";
  if (/^by(-nc)?(-nd|-sa)?$/.test(id))
    return `CC ${id.toUpperCase()}${version ? ` ${version}` : ""}`;
  return version ? `${license} ${version}` : license;
}

function contentTypeOf(filetype: string | null, mediaUrl: string): string | null {
  const key = filetype?.toLowerCase().replace(/^\./, "");
  const extension = key ? (FILETYPE_ALIASES[key] ?? key) : extensionFor(mediaUrl, null);
  return extension ? contentTypeFor(extension) : null;
}

function toCandidate(item: Rec, kind: ResearchMediaKind): RawCandidate | null {
  if (item.mature === true) return null;
  const mediaUrl = httpUrl(item, "url");
  if (!mediaUrl || isStreamManifest(mediaUrl, null)) return null;
  // A file whose extension names another kind of media (a video behind an "image") is not what was asked for.
  const named = mediaKindFromUrl(mediaUrl);
  if (named && named !== kind) return null;

  const license = str(item, "license");
  const licenseUrl = httpUrl(item, "license_url");
  const name = license ? licenseName(license, str(item, "license_version")) : null;
  const duration = kind === "audio" ? num(item, "duration") : null;
  const creator = str(item, "creator");
  return {
    mediaKind: kind,
    title: str(item, "title") ?? "Untitled",
    description: str(item, "description") ?? str(item, "detail") ?? "",
    pageUrl: httpUrl(item, "foreign_landing_url"),
    mediaUrl,
    previewUrl: httpUrl(item, "thumbnail"),
    author: creator,
    authorUrl: creator ? httpUrl(item, "creator_url") : null,
    license:
      name || licenseUrl
        ? normalizeLicense({
            name,
            url: licenseUrl,
            // Openverse states the license as a field; without its URL there is nothing to verify it against.
            confidence: licenseUrl ? "high" : "medium",
            basis: LICENSE_BASIS,
          })
        : normalizeLicense({ confidence: "none", basis: LICENSE_BASIS }),
    width: kind === "picture" ? num(item, "width") : null,
    height: kind === "picture" ? num(item, "height") : null,
    // Openverse reports audio length in milliseconds.
    duration: duration === null ? null : Math.round(duration) / 1000,
    bytes: num(item, "filesize"),
    contentType: contentTypeOf(str(item, "filetype"), mediaUrl),
  };
}

/** Openverse (images and audio; it has no video) through its public API; every result states its license. */
export const openverseConnector: AssetConnector = {
  id: "openverse",

  async search(query, kind, limit, ctx) {
    const endpoint = ENDPOINT_BY_KIND[kind];
    if (!endpoint) return [];
    const pageSize = Math.max(1, Math.min(Math.floor(limit), MAX_PAGE_SIZE));
    const params = new URLSearchParams({ q: query, page_size: String(pageSize), mature: "false" });
    const json = await ctx.http.getJson(`${API_URL}/${endpoint}/?${params.toString()}`);
    if (!isRecord(json) || !Array.isArray(json.results)) {
      throw new ResearchFailure(
        "provider_error",
        "Openverse answered with an unexpected document.",
      );
    }
    const out: RawCandidate[] = [];
    for (const item of json.results) {
      if (!isRecord(item)) continue;
      const candidate = toCandidate(item, kind);
      if (candidate) out.push(candidate);
      if (out.length >= pageSize) break;
    }
    return out;
  },
};
