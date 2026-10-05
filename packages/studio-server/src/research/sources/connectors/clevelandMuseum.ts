import { isRecord, normalizeLicense, type LicenseInfo } from "@hyperframes/agent-protocol";
import { ResearchFailure } from "../../errors.js";
import { clip, htmlToText } from "../htmlText.js";
import { contentTypeFor, extensionFor } from "../mediaTypes.js";
import type { AssetConnector, RawCandidate } from "../types.js";

const SEARCH_URL = "https://openaccess-api.clevelandart.org/api/artworks/";
const MAX_PAGE_SIZE = 100;
const MAX_DESCRIPTION_CHARS = 500;

const LICENSE: LicenseInfo = normalizeLicense({
  name: "CC0",
  url: "https://creativecommons.org/publicdomain/zero/1.0/",
  confidence: "high",
  basis: "Cleveland Museum of Art Open Access API (share_license_status)",
});

type Rec = Record<string, unknown>;

function str(rec: Rec, key: string): string | null {
  const value = rec[key];
  if (typeof value !== "string") return null;
  const text = value.replace(/\s+/g, " ").trim();
  return text || null;
}

/** The API writes sizes as strings ("767"). */
function size(rec: Rec, key: string): number | null {
  const value = Number(rec[key]);
  return Number.isFinite(value) && value > 0 ? value : null;
}

interface Rendition {
  url: string;
  width: number | null;
  height: number | null;
  bytes: number | null;
}

function rendition(images: Rec, name: string): Rendition | null {
  const entry = images[name];
  if (!isRecord(entry)) return null;
  const url = str(entry, "url");
  if (!url || !/^https?:\/\//i.test(url)) return null;
  return {
    url,
    width: size(entry, "width"),
    height: size(entry, "height"),
    bytes: size(entry, "filesize"),
  };
}

/** The first creator without its life dates: "John D. Wareham (American, 1871–1954)" → "John D. Wareham". */
function authorOf(item: Rec): string | null {
  const creators = Array.isArray(item.creators) ? item.creators.filter(isRecord) : [];
  const first = creators[0] ? str(creators[0], "description") : null;
  return first ? first.replace(/\s*\([^()]*\)\s*$/, "") || first : null;
}

function toCandidate(item: unknown): RawCandidate | null {
  if (!isRecord(item) || item.share_license_status !== "CC0" || !isRecord(item.images)) return null;
  // `print` is a JPEG of about 3400 px; `full` is a multi-hundred-megabyte TIFF and is never offered.
  const web = rendition(item.images, "web");
  const main = rendition(item.images, "print") ?? web;
  if (!main) return null;
  const extension = extensionFor(main.url, null);
  return {
    mediaKind: "picture",
    title: str(item, "title") ?? "Untitled",
    description: clip(htmlToText(str(item, "description") ?? ""), MAX_DESCRIPTION_CHARS),
    pageUrl: str(item, "url"),
    mediaUrl: main.url,
    previewUrl: web?.url ?? null,
    author: authorOf(item),
    authorUrl: null,
    license: LICENSE,
    width: main.width,
    height: main.height,
    duration: null,
    bytes: main.bytes,
    contentType: extension ? contentTypeFor(extension) : null,
  };
}

/** The Cleveland Museum of Art's Open Access collection (pictures); every offered item is flagged CC0. */
export const clevelandMuseumConnector: AssetConnector = {
  id: "cleveland_museum",

  async search(query, kind, limit, ctx) {
    if (kind !== "picture") return [];
    const pageSize = Math.max(1, Math.min(Math.floor(limit), MAX_PAGE_SIZE));
    const params = new URLSearchParams({
      q: query,
      has_image: "1",
      cc0: "1",
      limit: String(pageSize),
    });
    const json = await ctx.http.getJson(`${SEARCH_URL}?${params.toString()}`);
    if (!isRecord(json) || !Array.isArray(json.data)) {
      throw new ResearchFailure(
        "provider_error",
        "The Cleveland Museum of Art API answered with an unexpected document.",
      );
    }
    const out: RawCandidate[] = [];
    for (const item of json.data) {
      const candidate = toCandidate(item);
      if (candidate) out.push(candidate);
      if (out.length >= pageSize) break;
    }
    return out;
  },
};
