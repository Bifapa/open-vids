import { isRecord, normalizeLicense, type LicenseInfo } from "@hyperframes/agent-protocol";
import { ResearchFailure } from "../../errors.js";
import type { AssetConnector, RawCandidate } from "../types.js";

const SEARCH_URL = "https://api.artic.edu/api/v1/artworks/search";
const FIELDS =
  "id,title,image_id,artist_display,date_display,medium_display,is_public_domain,thumbnail";
/** The API caps a page at 100 results. */
const MAX_PAGE_SIZE = 100;
/**
 * IIIF "best fit" box: the longest side stays within it. A plain `/1686,/` width answers 403 for images narrower than
 * 1686 px (the server does not upscale), and 843 px is the only size the API documents as always available.
 */
const IMAGE_BOX = 1686;
const PREVIEW_BOX = 200;
/**
 * Public-domain filter and text query are combined as "should", so every public-domain work comes back and the query
 * only boosts the score. Measured live (2026-10): a query with no match scores every work 4.7–5.5, while real matches
 * (ship, cat, portrait, harbor, wave, bridge…) score 10 or more, mostly 30+. Below the floor a hit is filler.
 */
const MIN_RELEVANCE_SCORE = 10;

const LICENSE: LicenseInfo = normalizeLicense({
  name: "CC0",
  url: "https://creativecommons.org/publicdomain/zero/1.0/",
  confidence: "high",
  basis: "Art Institute of Chicago API (is_public_domain)",
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

function iiif(base: string, imageId: string, box: number): string {
  return `${base}/${encodeURIComponent(imageId)}/full/!${box},${box}/0/default.jpg`;
}

/** `artist_display` is "Name\nNationality, 1834-1903" or "Name (English, 1817–1904)": the name alone. */
function authorOf(item: Rec): string | null {
  const raw = item.artist_display;
  if (typeof raw !== "string") return null;
  const first = raw.split("\n")[0]?.replace(/\s+/g, " ").trim();
  if (!first) return null;
  return first.replace(/\s*\([^()]*\)$/, "") || first;
}

/** Size of the file the best-fit request returns: the thumbnail record holds the full image's size. */
function fittedSize(item: Rec): { width: number | null; height: number | null } {
  const thumbnail = isRecord(item.thumbnail) ? item.thumbnail : null;
  const width = thumbnail ? num(thumbnail, "width") : null;
  const height = thumbnail ? num(thumbnail, "height") : null;
  if (width === null || height === null) return { width: null, height: null };
  const scale = Math.min(1, IMAGE_BOX / Math.max(width, height));
  return { width: Math.round(width * scale), height: Math.round(height * scale) };
}

function toCandidate(item: unknown, iiifUrl: string): RawCandidate | null {
  if (!isRecord(item) || item.is_public_domain !== true) return null;
  // A missing score means the API changed shape; keep the hit rather than drop everything.
  if (typeof item._score === "number" && item._score < MIN_RELEVANCE_SCORE) return null;
  const imageId = str(item, "image_id");
  const id = num(item, "id");
  if (!imageId || id === null) return null;
  const author = authorOf(item);
  const description = [str(item, "date_display"), str(item, "medium_display")]
    .filter((part): part is string => part !== null)
    .join(", ");
  return {
    mediaKind: "picture",
    title: str(item, "title") ?? "Untitled",
    description,
    pageUrl: `https://www.artic.edu/artworks/${id}`,
    mediaUrl: iiif(iiifUrl, imageId, IMAGE_BOX),
    previewUrl: iiif(iiifUrl, imageId, PREVIEW_BOX),
    author,
    authorUrl: null,
    license: LICENSE,
    ...fittedSize(item),
    duration: null,
    bytes: null,
    contentType: "image/jpeg",
  };
}

/** The Art Institute of Chicago's collection (pictures); images of public-domain works are CC0 per the museum. */
export const artInstituteChicagoConnector: AssetConnector = {
  id: "art_institute_chicago",

  async search(query, kind, limit, ctx) {
    if (kind !== "picture") return [];
    const pageSize = Math.max(1, Math.min(Math.floor(limit), MAX_PAGE_SIZE));
    // The term filter is a plain query parameter; the API ranks by the text query and keeps only public-domain works.
    const params = new URLSearchParams({
      q: query,
      "query[term][is_public_domain]": "true",
      fields: FIELDS,
      limit: String(pageSize),
    });
    const json = await ctx.http.getJson(`${SEARCH_URL}?${params.toString()}`);
    const config = isRecord(json) && isRecord(json.config) ? json.config : null;
    const iiifUrl = config ? str(config, "iiif_url") : null;
    if (!isRecord(json) || !Array.isArray(json.data) || !iiifUrl || !/^https:\/\//.test(iiifUrl)) {
      throw new ResearchFailure(
        "provider_error",
        "The Art Institute of Chicago API answered with an unexpected document.",
      );
    }
    const out: RawCandidate[] = [];
    for (const item of json.data) {
      const candidate = toCandidate(item, iiifUrl.replace(/\/+$/, ""));
      if (candidate) out.push(candidate);
      if (out.length >= pageSize) break;
    }
    return out;
  },
};
