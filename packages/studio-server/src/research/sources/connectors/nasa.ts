import {
  isRecord,
  normalizeLicense,
  type LicenseInfo,
  type ResearchMediaKind,
} from "@hyperframes/agent-protocol";
import { ResearchFailure } from "../../errors.js";
import { clip, htmlToText } from "../htmlText.js";
import { contentTypeFor } from "../mediaTypes.js";
import type { AssetConnector, ConnectorContext, DescribedPage, RawCandidate } from "../types.js";

const SEARCH_URL = "https://images-api.nasa.gov/search";
const DETAILS_HOSTS = new Set(["images.nasa.gov", "www.images.nasa.gov"]);
/** Hosts that serve https although the API lists them as http. */
const HTTPS_HOSTS = new Set(["images-assets.nasa.gov", "images-api.nasa.gov", "images.nasa.gov"]);
const MEDIA_TYPE_BY_KIND: Record<ResearchMediaKind, string> = {
  video: "video",
  audio: "audio",
  picture: "image",
};
const KIND_BY_MEDIA_TYPE: Record<string, ResearchMediaKind> = {
  video: "video",
  audio: "audio",
  image: "picture",
};
const MAX_DESCRIPTION_CHARS = 500;
const MAX_SEARCH_LIMIT = 50;

/**
 * Asset files in order of preference, matched against the lower-case file name. `~orig` of a picture can be
 * hundreds of megabytes, so the 1920 px `~large` rendering wins; mobile/small video renderings are a last resort.
 */
const FILE_PREFERENCE: Record<ResearchMediaKind, RegExp[]> = {
  picture: [/~large\.jpe?g$/, /~medium\.jpe?g$/, /~orig\.(jpe?g|png)$/, /~small\.jpe?g$/],
  video: [/~medium\.mp4$/, /~orig\.mp4$/, /~large\.mp4$/, /~small\.mp4$/, /~mobile\.mp4$/],
  audio: [
    /~128k\.mp3$/,
    /~orig\.mp3$/,
    /~orig\.wav$/,
    /\.mp3$/,
    /~128k\.m4a$/,
    /~orig\.m4a$/,
    /\.m4a$/,
  ],
};

const LICENSE: LicenseInfo = normalizeLicense({
  name: "Public domain (NASA)",
  url: "https://www.nasa.gov/nasa-brand-center/images-and-media/",
  confidence: "medium",
  basis: "NASA Image and Video Library media usage guidelines",
});

type Rec = Record<string, unknown>;

function str(rec: Rec, key: string): string | null {
  const value = rec[key];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function num(rec: Rec, key: string): number | null {
  const value = rec[key];
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
}

/** An absolute https URL (spaces the API leaves raw are encoded once; NASA hosts are upgraded from http). */
function normalizeUrl(raw: string): string | null {
  try {
    const url = new URL(raw);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    if (url.protocol === "http:" && HTTPS_HOSTS.has(url.hostname.toLowerCase())) {
      url.protocol = "https:";
    }
    return url.href;
  } catch {
    return null;
  }
}

function fileNameOf(url: string): string {
  try {
    const last = new URL(url).pathname.split("/").pop() ?? "";
    return decodeURIComponent(last).toLowerCase();
  } catch {
    return "";
  }
}

/** The best asset file of a `collection.json` listing for `kind`, or null. */
function pickFile(kind: ResearchMediaKind, listing: unknown): string | null {
  if (!Array.isArray(listing)) return null;
  const urls: Array<{ url: string; name: string }> = [];
  for (const entry of listing) {
    if (typeof entry !== "string") continue;
    const url = normalizeUrl(entry);
    if (url) urls.push({ url, name: fileNameOf(url) });
  }
  for (const pattern of FILE_PREFERENCE[kind]) {
    const hit = urls.find((candidate) => pattern.test(candidate.name));
    if (hit) return hit.url;
  }
  return null;
}

interface NasaItem {
  nasaId: string;
  title: string;
  description: string;
  author: string | null;
  kind: ResearchMediaKind;
  listingUrl: string;
  previewUrl: string | null;
  links: Rec[];
}

function readItem(value: unknown): NasaItem | null {
  if (!isRecord(value)) return null;
  const data: unknown = Array.isArray(value.data) ? value.data[0] : null;
  if (!isRecord(data)) return null;
  const nasaId = str(data, "nasa_id");
  const mediaType = str(data, "media_type");
  const kind = mediaType ? KIND_BY_MEDIA_TYPE[mediaType] : undefined;
  const href = str(value, "href");
  const listingUrl = href ? normalizeUrl(href) : null;
  if (!nasaId || !kind || !listingUrl) return null;
  const links = Array.isArray(value.links) ? value.links.filter(isRecord) : [];
  const preview = links.find((link) => link.rel === "preview");
  const previewHref = preview ? str(preview, "href") : null;
  const descriptionRaw = str(data, "description") ?? str(data, "description_508") ?? "";
  return {
    nasaId,
    title: htmlToText(str(data, "title") ?? nasaId) || nasaId,
    description: clip(htmlToText(descriptionRaw), MAX_DESCRIPTION_CHARS),
    author: htmlToText(str(data, "photographer") ?? str(data, "secondary_creator") ?? "") || null,
    kind,
    listingUrl,
    previewUrl: previewHref ? normalizeUrl(previewHref) : null,
    links,
  };
}

function readItems(json: unknown): NasaItem[] {
  const collection = isRecord(json) ? json.collection : null;
  if (!isRecord(collection) || !Array.isArray(collection.items)) {
    throw new ResearchFailure(
      "provider_error",
      "NASA Image Library answered in an unexpected format",
    );
  }
  const items: NasaItem[] = [];
  for (const raw of collection.items) {
    const item = readItem(raw);
    if (item) items.push(item);
  }
  return items;
}

/** Size hints of the item's `links` entry for the chosen file (only pictures list dimensions for each file). */
function linkFor(item: NasaItem, mediaUrl: string): Rec | null {
  for (const link of item.links) {
    const href = str(link, "href");
    if (href && normalizeUrl(href) === mediaUrl) return link;
  }
  return null;
}

function extensionOf(url: string): string {
  const name = fileNameOf(url);
  const dot = name.lastIndexOf(".");
  return dot < 0 ? "" : name.slice(dot + 1);
}

async function toCandidate(item: NasaItem, ctx: ConnectorContext): Promise<RawCandidate | null> {
  let listing: unknown;
  try {
    listing = await ctx.http.getJson(item.listingUrl);
  } catch (error) {
    if (ctx.signal?.aborted) throw error;
    return null;
  }
  const mediaUrl = pickFile(item.kind, listing);
  if (!mediaUrl) return null;
  const link = linkFor(item, mediaUrl);
  return {
    mediaKind: item.kind,
    title: item.title,
    description: item.description,
    pageUrl: `https://images.nasa.gov/details/${encodeURIComponent(item.nasaId)}`,
    mediaUrl,
    previewUrl: item.previewUrl,
    author: item.author,
    authorUrl: null,
    license: LICENSE,
    width: link ? num(link, "width") : null,
    height: link ? num(link, "height") : null,
    duration: null,
    bytes: link ? num(link, "size") : null,
    contentType: contentTypeFor(extensionOf(mediaUrl)),
  };
}

async function candidatesOf(
  items: NasaItem[],
  limit: number,
  ctx: ConnectorContext,
): Promise<RawCandidate[]> {
  const found = await Promise.all(items.slice(0, limit).map((item) => toCandidate(item, ctx)));
  return found.filter((candidate): candidate is RawCandidate => candidate !== null);
}

/** `images.nasa.gov/details/<nasa_id>` (and the old `/details-<nasa_id>`): the id, or null. */
function nasaIdOf(url: URL): string | null {
  if (!DETAILS_HOSTS.has(url.hostname.toLowerCase())) return null;
  const match = /^\/details(?:\/|-)([^/]+)\/?$/.exec(url.pathname);
  if (!match?.[1]) return null;
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return null;
  }
}

export const nasaConnector: AssetConnector = {
  id: "nasa_images",

  async search(query, kind, limit, ctx) {
    const pageSize = Math.max(1, Math.min(limit, MAX_SEARCH_LIMIT));
    const url = `${SEARCH_URL}?${new URLSearchParams({
      q: query,
      media_type: MEDIA_TYPE_BY_KIND[kind],
      page_size: String(pageSize),
    }).toString()}`;
    const items = readItems(await ctx.http.getJson(url)).filter((item) => item.kind === kind);
    return candidatesOf(items, limit, ctx);
  },

  async describeUrl(url, kind, ctx): Promise<DescribedPage | null> {
    const nasaId = nasaIdOf(url);
    if (!nasaId) return null;
    const apiUrl = `${SEARCH_URL}?${new URLSearchParams({ nasa_id: nasaId }).toString()}`;
    const item = readItems(await ctx.http.getJson(apiUrl)).find(
      (candidate) => candidate.nasaId === nasaId,
    );
    if (!item) {
      throw new ResearchFailure("unavailable", `NASA Image Library has no item "${nasaId}"`);
    }
    const notes: string[] = [];
    let candidates: RawCandidate[] = [];
    if (kind && item.kind !== kind) {
      notes.push(`This NASA item is a ${item.kind}, not a ${kind}.`);
    } else {
      candidates = await candidatesOf([item], 1, ctx);
      if (candidates.length === 0) notes.push("NASA lists no usable media file for this item.");
    }
    return {
      title: item.title,
      author: item.author,
      license: LICENSE,
      candidates,
      notes,
    };
  },
};
