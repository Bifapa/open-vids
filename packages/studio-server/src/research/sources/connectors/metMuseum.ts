import { isRecord, normalizeLicense, type LicenseInfo } from "@hyperframes/agent-protocol";
import { ResearchFailure } from "../../errors.js";
import { clip } from "../htmlText.js";
import { contentTypeFor, extensionFor } from "../mediaTypes.js";
import type { AssetConnector, ConnectorContext, RawCandidate } from "../types.js";

const API_URL = "https://collectionapi.metmuseum.org/public/collection";
/** v1.1 is the paginated search; v1/search was retired on 2026-10-01. */
const SEARCH_URL = `${API_URL}/v1.1/search`;
const OBJECT_URL = `${API_URL}/v1/objects`;
const MAX_SEARCH_LIMIT = 500;
const MAX_IN_FLIGHT = 4;
/**
 * The search cannot filter by public domain (`isPublicDomain` is not a search parameter), so many hits are in-copyright
 * works without an image; several ids per wanted result are checked. The API allows 80 requests per second.
 */
const SPARE_FACTOR = 5;
const MAX_DESCRIPTION_CHARS = 500;

const LICENSE: LicenseInfo = normalizeLicense({
  name: "CC0",
  url: "https://creativecommons.org/publicdomain/zero/1.0/",
  confidence: "high",
  basis: "The Met API (isPublicDomain)",
});

type Rec = Record<string, unknown>;

function str(rec: Rec, key: string): string | null {
  const value = rec[key];
  if (typeof value !== "string") return null;
  const text = value.replace(/\s+/g, " ").trim();
  return text || null;
}

function httpUrl(rec: Rec, key: string): string | null {
  const value = str(rec, key);
  return value && /^https?:\/\//i.test(value) ? value : null;
}

function readObjectIds(json: unknown): number[] {
  // An empty result is `{ total: 0, objectIDs: null }`.
  if (!isRecord(json) || !(json.objectIDs === null || Array.isArray(json.objectIDs))) {
    throw new ResearchFailure(
      "provider_error",
      "The Met API answered with an unexpected document.",
    );
  }
  const ids: number[] = [];
  for (const id of json.objectIDs ?? []) {
    if (typeof id === "number" && Number.isSafeInteger(id) && id > 0) ids.push(id);
  }
  return ids;
}

function toCandidate(object: unknown): RawCandidate | null {
  if (!isRecord(object) || object.isPublicDomain !== true) return null;
  const mediaUrl = httpUrl(object, "primaryImage");
  if (!mediaUrl) return null;
  const author = str(object, "artistDisplayName");
  const extension = extensionFor(mediaUrl, null);
  const description = [str(object, "objectDate"), str(object, "medium")]
    .filter((part): part is string => part !== null)
    .join(", ");
  return {
    mediaKind: "picture",
    title: str(object, "title") ?? str(object, "objectName") ?? "Untitled",
    description: clip(description, MAX_DESCRIPTION_CHARS),
    pageUrl: httpUrl(object, "objectURL"),
    mediaUrl,
    previewUrl: httpUrl(object, "primaryImageSmall"),
    author,
    authorUrl: author
      ? (httpUrl(object, "artistWikidata_URL") ?? httpUrl(object, "artistULAN_URL"))
      : null,
    license: LICENSE,
    width: null,
    height: null,
    duration: null,
    bytes: null,
    contentType: extension ? contentTypeFor(extension) : null,
  };
}

/**
 * The Met's search answers with object ids only; each object's record carries its image and its public-domain flag.
 * Records are read in ranking order, a few at a time, until `limit` public-domain images are found.
 */
async function collect(
  ids: number[],
  limit: number,
  ctx: ConnectorContext,
): Promise<RawCandidate[]> {
  const slots: Array<RawCandidate | null> = ids.map(() => null);
  let next = 0;
  let found = 0;
  const worker = async (): Promise<void> => {
    while (found < limit && next < ids.length) {
      const index = next++;
      let object: unknown;
      try {
        object = await ctx.http.getJson(`${OBJECT_URL}/${ids[index]}`);
      } catch (error) {
        if (ctx.signal?.aborted) throw error;
        continue;
      }
      const candidate = toCandidate(object);
      if (!candidate) continue;
      slots[index] = candidate;
      found++;
    }
  };
  await Promise.all(Array.from({ length: Math.min(MAX_IN_FLIGHT, ids.length) }, worker));
  return slots.filter((slot): slot is RawCandidate => slot !== null).slice(0, limit);
}

/** The Metropolitan Museum of Art's Open Access collection (pictures); only objects flagged public domain are offered. */
export const metMuseumConnector: AssetConnector = {
  id: "met_museum",

  async search(query, kind, limit, ctx) {
    if (kind !== "picture") return [];
    const wanted = Math.max(1, Math.floor(limit));
    const params = new URLSearchParams({
      q: query,
      hasImages: "true",
      limit: String(Math.min(wanted * SPARE_FACTOR, MAX_SEARCH_LIMIT)),
    });
    const ids = readObjectIds(await ctx.http.getJson(`${SEARCH_URL}?${params.toString()}`));
    return collect(ids, wanted, ctx);
  },
};
