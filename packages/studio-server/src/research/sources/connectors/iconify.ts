import { isRecord, normalizeLicense } from "@hyperframes/agent-protocol";
import { ResearchFailure } from "../../errors.js";
import type { AssetConnector, RawCandidate } from "../types.js";

const API_URL = "https://api.iconify.design";
const SETS_URL = "https://icon-sets.iconify.design";
/** The search API refuses fewer than 32 results per request. */
const MIN_SEARCH_LIMIT = 32;
const MAX_SEARCH_LIMIT = 100;
/** Sets under a copyleft or non-commercial license are dropped after the search, so ask for more than needed. */
const OVERFETCH = 2;
/**
 * Icons are drawn on a 1em box; without an explicit size a rasterizer reads them at 16 px. `height` makes the API write
 * `width`/`height` attributes (the width follows the icon's own proportions) and still answers an SVG.
 */
const SVG_HEIGHT = 512;
const LICENSE_BASIS = "Iconify API (icon set license)";
const ICON_ID = /^([a-z0-9]+(?:-[a-z0-9]+)*):([a-z0-9]+(?:-[a-z0-9]+)*)$/;

type Rec = Record<string, unknown>;

function str(rec: Rec, key: string): string | null {
  const value = rec[key];
  if (typeof value !== "string") return null;
  const text = value.trim();
  return text || null;
}

function httpUrl(rec: Rec, key: string): string | null {
  const value = str(rec, key);
  return value && /^https?:\/\//i.test(value) ? value : null;
}

function toCandidate(icon: unknown, collections: Rec): RawCandidate | null {
  const id = typeof icon === "string" ? ICON_ID.exec(icon) : null;
  const prefix = id?.[1];
  const name = id?.[2];
  if (!prefix || !name) return null;
  const set = collections[prefix];
  if (!isRecord(set)) return null;

  const info = isRecord(set.license) ? set.license : {};
  const license = normalizeLicense({
    name: str(info, "spdx") ?? str(info, "title"),
    url: httpUrl(info, "url"),
    confidence: "high",
    basis: LICENSE_BASIS,
  });
  // GPL, MPL, non-commercial and unnamed sets are not reusable in a video as they are.
  if (license.status !== "clear" && license.status !== "attribution") return null;

  const author = isRecord(set.author) ? str(set.author, "name") : null;
  const authorUrl = isRecord(set.author) ? httpUrl(set.author, "url") : null;
  const setName = str(set, "name") ?? prefix;
  return {
    mediaKind: "picture",
    title: `${name.replaceAll("-", " ")} (${setName})`,
    description: `Icon “${name}” from the ${setName} icon set.`,
    pageUrl: `${SETS_URL}/${prefix}/${name}/`,
    mediaUrl: `${API_URL}/${prefix}/${name}.svg?height=${SVG_HEIGHT}`,
    previewUrl: null,
    author,
    authorUrl: author ? authorUrl : null,
    license,
    width: null,
    height: null,
    duration: null,
    bytes: null,
    contentType: "image/svg+xml",
  };
}

/** Iconify (pictures only): open-source icon sets as SVG; each set states its own license. */
export const iconifyConnector: AssetConnector = {
  id: "iconify",

  async search(query, kind, limit, ctx) {
    if (kind !== "picture") return [];
    const wanted = Math.max(1, Math.floor(limit));
    const params = new URLSearchParams({
      query,
      limit: String(Math.min(Math.max(wanted * OVERFETCH, MIN_SEARCH_LIMIT), MAX_SEARCH_LIMIT)),
    });
    const json = await ctx.http.getJson(`${API_URL}/search?${params.toString()}`);
    if (!isRecord(json) || !Array.isArray(json.icons) || !isRecord(json.collections)) {
      throw new ResearchFailure("provider_error", "Iconify answered with an unexpected document.");
    }
    const out: RawCandidate[] = [];
    for (const icon of json.icons) {
      const candidate = toCandidate(icon, json.collections);
      if (candidate) out.push(candidate);
      if (out.length >= wanted) break;
    }
    return out;
  },
};
