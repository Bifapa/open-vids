import { isRecord, normalizeLicense, type LicenseInfo } from "@hyperframes/agent-protocol";
import { ResearchFailure } from "../../errors.js";
import { clip } from "../htmlText.js";
import { mediaKindFromUrl } from "../mediaTypes.js";
import type { AssetConnector, RawCandidate } from "../types.js";

const SEARCH_URL = "https://api.si.edu/openaccess/api/v1.0/search";
const DELIVERY_HOST = "ids.si.edu";
const DELIVERY_PATH = "/ids/deliveryService";
/** The delivery service hands out the full scan (often 4000+ px); a longest edge of 2000 px is plenty for a video. */
const MAX_EDGE = 2000;
const PREVIEW_EDGE = 400;
const MAX_ROWS = 100;
const MAX_DESCRIPTION_CHARS = 500;
/** Credit labels in `freetext.name`, best first; the record's first name is the fallback. */
const AUTHOR_LABEL = /^(artist|photographer|creator|author|maker|designer|painter|sculptor)/i;
const DESCRIPTION_LABEL = /^(description|summary|brief description|physical description)$/i;

const LICENSE: LicenseInfo = normalizeLicense({
  name: "CC0",
  url: "https://creativecommons.org/publicdomain/zero/1.0/",
  confidence: "high",
  basis: "Smithsonian Open Access API (media usage CC0)",
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

function records(value: unknown): Rec[] {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

/**
 * The query's words as plain terms: the API takes Lucene syntax (`AND`, quotes, `field:value`), so a user's
 * punctuation and operator words must not change what is asked. Words are ANDed.
 */
function termsOf(query: string): string {
  return query
    .replace(/[+\-&|!(){}[\]^"~*?:\\/<>=]/g, " ")
    .split(/\s+/)
    .filter((word) => word && !/^(and|or|not)$/i.test(word))
    .join(" AND ");
}

/** The delivery-service URL of one scan at a size; another host's picture URL is kept as the record lists it. */
function deliveryUrl(content: string, edge: number): string | null {
  let url: URL;
  try {
    url = new URL(content);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  if (url.hostname === DELIVERY_HOST && url.pathname === DELIVERY_PATH) {
    url.protocol = "https:";
    url.searchParams.set("max", String(edge));
    return url.toString();
  }
  return mediaKindFromUrl(content) === "picture" ? url.toString() : null;
}

/** Dimensions of the scaled rendering, from the record's high-resolution JPEG entry. */
function scaledSize(media: Rec): { width: number; height: number } | null {
  for (const resource of records(media.resources)) {
    const width = num(resource, "width");
    const height = num(resource, "height");
    if (width === null || height === null) continue;
    const scale = Math.min(1, MAX_EDGE / Math.max(width, height));
    return { width: Math.round(width * scale), height: Math.round(height * scale) };
  }
  return null;
}

function labelled(value: unknown): Array<{ label: string; content: string }> {
  return records(value).flatMap((entry) => {
    const label = str(entry, "label");
    const content = str(entry, "content");
    return content ? [{ label: label ?? "", content }] : [];
  });
}

function authorOf(freetext: Rec): string | null {
  const names = labelled(freetext.name);
  return (names.find((name) => AUTHOR_LABEL.test(name.label)) ?? names[0])?.content ?? null;
}

function descriptionOf(freetext: Rec, media: Rec): string {
  const notes = labelled(freetext.notes);
  const note = notes.find((entry) => DESCRIPTION_LABEL.test(entry.label))?.content;
  return clip(note ?? str(media, "extDescrAccessibility") ?? "", MAX_DESCRIPTION_CHARS);
}

/** The first CC0 picture of a record; a record's other media (3D models, non-CC0 scans) are not offered. */
function pickMedia(descriptive: Rec): Rec | null {
  const online = isRecord(descriptive.online_media) ? descriptive.online_media : null;
  return (
    records(online?.media).find((media) => {
      const usage = isRecord(media.usage) ? media.usage : null;
      return (
        str(media, "type") === "Images" &&
        usage !== null &&
        str(usage, "access") === "CC0" &&
        str(media, "content") !== null
      );
    }) ?? null
  );
}

function toCandidate(row: Rec): RawCandidate | null {
  const content = isRecord(row.content) ? row.content : null;
  const descriptive =
    content && isRecord(content.descriptiveNonRepeating) ? content.descriptiveNonRepeating : null;
  if (!content || !descriptive) return null;
  const media = pickMedia(descriptive);
  const source = media ? str(media, "content") : null;
  if (!media || !source) return null;
  const mediaUrl = deliveryUrl(source, MAX_EDGE);
  if (!mediaUrl) return null;
  const freetext = isRecord(content.freetext) ? content.freetext : {};
  const heading = isRecord(descriptive.title) ? str(descriptive.title, "content") : null;
  const size = scaledSize(media);
  const thumbnail = str(media, "thumbnail");
  const recordLink = str(descriptive, "record_link");
  return {
    mediaKind: "picture",
    title: str(row, "title") ?? heading ?? "Untitled",
    description: descriptionOf(freetext, media),
    pageUrl: /^https?:\/\//i.test(recordLink ?? "") ? recordLink : null,
    mediaUrl,
    previewUrl: deliveryUrl(thumbnail ?? source, PREVIEW_EDGE),
    author: authorOf(freetext),
    authorUrl: null,
    license: LICENSE,
    width: size?.width ?? null,
    height: size?.height ?? null,
    duration: null,
    bytes: null,
    contentType: "image/jpeg",
  };
}

/** Smithsonian Open Access (pictures) through the Smithsonian Open Access API; only CC0 scans are offered. */
export const smithsonianConnector: AssetConnector = {
  id: "smithsonian",

  async search(query, kind, limit, ctx) {
    if (kind !== "picture") return [];
    if (!ctx.apiKey) throw new ResearchFailure("invalid_request", "Smithsonian needs an API key");
    const terms = termsOf(query);
    if (!terms) return [];
    const rows = Math.max(1, Math.min(Math.floor(limit), MAX_ROWS));
    const params = new URLSearchParams({
      q: `(${terms}) AND online_media_type:Images AND media_usage:CC0`,
      rows: String(rows),
    });
    const json = await ctx.http.getJson(`${SEARCH_URL}?${params.toString()}`, {
      headers: { "X-Api-Key": ctx.apiKey },
    });
    const response = isRecord(json) && isRecord(json.response) ? json.response : null;
    if (!response || !Array.isArray(response.rows)) {
      throw new ResearchFailure(
        "provider_error",
        "Smithsonian Open Access answered with an unexpected document.",
      );
    }
    const out: RawCandidate[] = [];
    for (const row of records(response.rows)) {
      const candidate = toCandidate(row);
      if (candidate) out.push(candidate);
      if (out.length >= rows) break;
    }
    return out;
  },
};
