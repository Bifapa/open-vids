import { isRecord, normalizeLicense } from "@hyperframes/agent-protocol";
import { ResearchFailure } from "../../errors.js";
import type { AssetConnector, RawCandidate } from "../types.js";

const IMAGES_URL = "https://api.wellcomecollection.org/catalogue/v2/images";
const WORK_PAGE = "https://wellcomecollection.org/works";
/** The ids of the reusable licenses in the catalogue's `locations.license` filter (checked against its facets). */
const REUSABLE_LICENSES = "cc-0,pdm,cc-by,cc-by-sa";
const MAX_PAGE_SIZE = 50;
/** The IIIF server upscales: the original of a typical scan is 1–4 k px, a 2000 px bounding box is a safe download. */
const IIIF_SIZE = "!2000,2000";
const LICENSE_BASIS = "Wellcome Collection API (locations.license)";

type Rec = Record<string, unknown>;

function str(rec: Rec, key: string): string | null {
  const value = rec[key];
  if (typeof value !== "string") return null;
  const text = value.replace(/\s+/g, " ").trim();
  return text || null;
}

function httpsUrl(rec: Rec, key: string): string | null {
  const value = str(rec, key);
  return value && /^https:\/\//i.test(value) ? value : null;
}

/** `https://iiif.wellcomecollection.org/image/L0011861/info.json` → the same image's base URL. */
function iiifBase(infoUrl: string): string | null {
  const match = /^(https:\/\/iiif\.wellcomecollection\.org\/image\/[^/?#]+)\/info\.json$/.exec(
    infoUrl,
  );
  return match?.[1] ?? null;
}

/** The person or body named as the work's main contributor ("Goussier, Louis-Jacques, 1722-1799."), if any. */
function authorOf(source: Rec): string | null {
  if (!Array.isArray(source.contributors)) return null;
  for (const contributor of source.contributors) {
    if (!isRecord(contributor) || contributor.primary !== true) continue;
    const agent = isRecord(contributor.agent) ? str(contributor.agent, "label") : null;
    if (agent) return agent;
  }
  return null;
}

function toCandidate(image: Rec): RawCandidate | null {
  const source = isRecord(image.source) ? image.source : null;
  const workId = source ? str(source, "id") : null;
  const locations = Array.isArray(image.locations) ? image.locations.filter(isRecord) : [];
  // An image has one IIIF location; the license is stated per location.
  const location = locations.find((entry) => {
    const type = isRecord(entry.locationType) ? entry.locationType.id : null;
    return type === "iiif-image";
  });
  const infoUrl = location ? httpsUrl(location, "url") : null;
  const base = infoUrl ? iiifBase(infoUrl) : null;
  const license = location && isRecord(location.license) ? location.license : null;
  if (!source || !workId || !base || !license) return null;

  const info = normalizeLicense({
    name: str(license, "label"),
    url: str(license, "url"),
    confidence: "high",
    basis: LICENSE_BASIS,
  });
  // The request filters for these already; an answer outside the filter (a changed id scheme) is not offered.
  if (info.status !== "clear" && info.status !== "attribution") return null;

  const credit = str(location ?? {}, "credit");
  return {
    mediaKind: "picture",
    title: str(source, "title") ?? "Untitled",
    description: "",
    pageUrl: `${WORK_PAGE}/${encodeURIComponent(workId)}`,
    mediaUrl: `${base}/full/${IIIF_SIZE}/0/default.jpg`,
    previewUrl: `${base}/full/!400,400/0/default.jpg`,
    author: authorOf(source) ?? credit,
    authorUrl: null,
    license: info,
    // Only the aspect ratio is known without a second request, so the size of the rendering is left open.
    width: null,
    height: null,
    duration: null,
    bytes: null,
    contentType: "image/jpeg",
  };
}

/** Wellcome Collection (medical and scientific images): reusable licenses only, rendered through its IIIF server. */
export const wellcomeCollectionConnector: AssetConnector = {
  id: "wellcome_collection",

  async search(query, kind, limit, ctx) {
    if (kind !== "picture") return [];
    const pageSize = Math.max(1, Math.min(Math.floor(limit), MAX_PAGE_SIZE));
    const params = new URLSearchParams({
      query,
      pageSize: String(pageSize),
      "locations.license": REUSABLE_LICENSES,
      include: "source.contributors",
    });
    const json = await ctx.http.getJson(`${IMAGES_URL}?${params.toString()}`);
    if (!isRecord(json) || !Array.isArray(json.results)) {
      throw new ResearchFailure(
        "provider_error",
        "Wellcome Collection answered with an unexpected document.",
      );
    }
    const out: RawCandidate[] = [];
    for (const image of json.results) {
      if (!isRecord(image)) continue;
      const candidate = toCandidate(image);
      if (candidate) out.push(candidate);
      if (out.length >= pageSize) break;
    }
    return out;
  },
};
