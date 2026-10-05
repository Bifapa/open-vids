import { isRecord, normalizeLicense } from "@hyperframes/agent-protocol";
import { ResearchFailure } from "../../errors.js";
import type { AssetConnector, RawCandidate } from "../types.js";

const SEARCH_URL = "https://api.smk.dk/api/v1/art/search/";
const ARTWORK_PAGE = "https://open.smk.dk/artwork/image";
/** The API answers 400 beyond a few thousand rows; a search never needs more than the agent's cap. */
const MAX_ROWS = 50;
/** Longest side of the rendering offered: the full-size scans run to 10 000+ px and tens of megabytes. */
const MAX_SIDE = 2000;
const LICENSE_BASIS = "SMK API (rights)";
/** `production` carries the artists' multi-paragraph biographies; the search can leave it out. */
const FIELDS = [
  "object_number",
  "titles",
  "artist",
  "rights",
  "public_domain",
  "has_image",
  "image_iiif_id",
  "image_native",
  "image_thumbnail",
  "image_width",
  "image_height",
].join(",");

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

function httpsUrl(rec: Rec, key: string): string | null {
  const value = str(rec, key);
  return value && /^https:\/\//i.test(value) ? value : null;
}

/** Titles come in several languages; the English one when present, else the first. */
function titleOf(item: Rec): string {
  const titles = Array.isArray(item.titles) ? item.titles.filter(isRecord) : [];
  const english = titles.find((title) => title.language === "engelsk");
  return str(english ?? titles[0] ?? {}, "title") ?? "Untitled";
}

function authorOf(item: Rec): string | null {
  if (!Array.isArray(item.artist)) return null;
  const names = item.artist.filter((name): name is string => typeof name === "string");
  return names.join(", ").trim() || null;
}

interface PictureFile {
  mediaUrl: string;
  width: number | null;
  height: number | null;
}

/**
 * A JPEG of the work. Works scanned for IIIF are rendered at most {@link MAX_SIDE} px on the long side (IIPImage
 * upscales a larger request, so the side is capped at the original's); the rest only have a ready JPEG.
 */
function pictureFile(item: Rec): PictureFile | null {
  const width = num(item, "image_width");
  const height = num(item, "image_height");
  const iiif = httpsUrl(item, "image_iiif_id");
  if (iiif) {
    const longest = width && height ? Math.max(width, height) : null;
    const side = longest ? Math.min(MAX_SIDE, longest) : MAX_SIDE;
    const scale = longest ? side / longest : null;
    return {
      mediaUrl: `${iiif.replace(/\/$/, "")}/full/!${side},${side}/0/default.jpg`,
      width: scale && width ? Math.round(width * scale) : null,
      height: scale && height ? Math.round(height * scale) : null,
    };
  }
  // A work without IIIF has one stored JPEG (`image_native`); a TIFF download is not offered.
  const native = httpsUrl(item, "image_native");
  if (native && /\.jpe?g(?:[?#]|$)/i.test(native)) {
    return { mediaUrl: native, width, height };
  }
  return null;
}

function toCandidate(item: Rec): RawCandidate | null {
  const objectNumber = str(item, "object_number");
  const rights = httpsUrl(item, "rights");
  // The request already filters for public domain; a work whose own record says otherwise is not offered.
  if (!objectNumber || !rights || item.public_domain !== true || item.has_image !== true)
    return null;
  const file = pictureFile(item);
  if (!file) return null;
  const author = authorOf(item);
  return {
    mediaKind: "picture",
    title: titleOf(item),
    description: "",
    pageUrl: `${ARTWORK_PAGE}/${encodeURIComponent(objectNumber)}`,
    mediaUrl: file.mediaUrl,
    previewUrl: httpsUrl(item, "image_thumbnail"),
    author,
    authorUrl: null,
    license: normalizeLicense({ url: rights, confidence: "high", basis: LICENSE_BASIS }),
    width: file.width,
    height: file.height,
    duration: null,
    bytes: null,
    contentType: "image/jpeg",
  };
}

/** SMK, the National Gallery of Denmark: public-domain works with a ready JPEG; no API key. */
export const smkConnector: AssetConnector = {
  id: "smk",

  async search(query, kind, limit, ctx) {
    if (kind !== "picture") return [];
    const rows = Math.max(1, Math.min(Math.floor(limit), MAX_ROWS));
    const params = new URLSearchParams({
      keys: query,
      filters: "[has_image:true],[public_domain:true]",
      offset: "0",
      rows: String(rows),
      lang: "en",
      fields: FIELDS,
    });
    const json = await ctx.http.getJson(`${SEARCH_URL}?${params.toString()}`);
    if (!isRecord(json) || !Array.isArray(json.items)) {
      throw new ResearchFailure("provider_error", "SMK answered with an unexpected document.");
    }
    const out: RawCandidate[] = [];
    for (const item of json.items) {
      if (!isRecord(item)) continue;
      const candidate = toCandidate(item);
      if (candidate) out.push(candidate);
      if (out.length >= rows) break;
    }
    return out;
  },
};
