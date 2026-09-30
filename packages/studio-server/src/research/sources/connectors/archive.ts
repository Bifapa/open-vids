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

const SEARCH_URL = "https://archive.org/advancedsearch.php";
const METADATA_URL = "https://archive.org/metadata/";
const ARCHIVE_HOSTS = new Set(["archive.org", "www.archive.org"]);
const MEDIATYPE_BY_KIND: Record<ResearchMediaKind, string> = {
  video: "movies",
  audio: "audio",
  picture: "image",
};
const KIND_BY_MEDIATYPE: Record<string, ResearchMediaKind> = {
  movies: "video",
  audio: "audio",
  etree: "audio",
  image: "picture",
};
const MAX_FILE_BYTES = 400 * 1024 * 1024;
const MAX_DESCRIPTION_CHARS = 500;
const MAX_SEARCH_LIMIT = 50;

type Rec = Record<string, unknown>;

/** The text of a metadata field that is a string or a list of strings (joined), HTML removed. */
function text(value: unknown): string | null {
  const parts = (Array.isArray(value) ? value : [value]).filter(
    (part): part is string => typeof part === "string",
  );
  const joined = htmlToText(parts.join(", "));
  return joined || null;
}

function first(value: unknown): string | null {
  const one: unknown = Array.isArray(value) ? value[0] : value;
  return typeof one === "string" && one.trim() ? one.trim() : null;
}

function numeric(value: unknown): number | null {
  const n = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** Archive `length`: seconds ("370.2") or a clock ("00:06:10", "6:10.5"). */
function secondsOf(value: unknown): number | null {
  if (typeof value === "number") return numeric(value);
  if (typeof value !== "string") return null;
  if (!value.includes(":")) return numeric(value);
  let total = 0;
  for (const part of value.split(":")) {
    const n = Number(part);
    if (!Number.isFinite(n) || n < 0) return null;
    total = total * 60 + n;
  }
  return total > 0 ? total : null;
}

interface ArchiveFile {
  name: string;
  format: string;
  original: boolean;
  bytes: number | null;
  duration: number | null;
  width: number | null;
  height: number | null;
  ext: string;
}

function readFiles(value: unknown): ArchiveFile[] {
  if (!Array.isArray(value)) return [];
  const files: ArchiveFile[] = [];
  for (const raw of value) {
    if (!isRecord(raw) || typeof raw.name !== "string" || !raw.name) continue;
    const dot = raw.name.lastIndexOf(".");
    files.push({
      name: raw.name,
      format: typeof raw.format === "string" ? raw.format : "",
      original: raw.source === "original",
      bytes: numeric(raw.size),
      duration: secondsOf(raw.length),
      width: numeric(raw.width),
      height: numeric(raw.height),
      ext: dot < 0 ? "" : raw.name.slice(dot + 1).toLowerCase(),
    });
  }
  return files;
}

const THUMB_FORMAT = /thumb|tile|item image|spectrogram|metadata|torrent/i;
const THUMB_NAME = /__ia_thumb|_thumb\b|_thumb[._]|\.thumbs\//i;

/** The best-ranked file of `files` (lowest rank wins; null rank = unusable); first one on ties. */
function best(
  files: ArchiveFile[],
  rank: (file: ArchiveFile) => number | null,
): ArchiveFile | null {
  let winner: ArchiveFile | null = null;
  let winnerRank = Infinity;
  for (const file of files) {
    if (file.bytes !== null && file.bytes > MAX_FILE_BYTES) continue;
    const r = rank(file);
    if (r !== null && r < winnerRank) {
      winner = file;
      winnerRank = r;
    }
  }
  return winner;
}

function rankVideo(file: ArchiveFile): number | null {
  if (file.ext === "mp4" || file.ext === "m4v") {
    const format = file.format.toLowerCase();
    if (format === "h.264") return 0;
    if (format === "h.264 hd") return 1;
    if (format === "mpeg4") return 2;
    if (/512kb|h\.264 ia/i.test(format)) return 4; // low-quality access copies
    return 3;
  }
  // Fallbacks when the item has no mp4 at all.
  if (file.ext === "webm") return 10;
  if (file.ext === "ogv") return 11;
  if (file.ext === "mov") return 12;
  return null;
}

function rankAudio(file: ArchiveFile): number | null {
  if (THUMB_FORMAT.test(file.format)) return null;
  if (file.ext === "mp3") {
    const format = file.format.toLowerCase();
    if (format === "vbr mp3") return 0;
    if (format === "mp3") return 1;
    return 2;
  }
  if (file.ext === "ogg") return 10;
  if (file.ext === "m4a") return 11;
  if (file.ext === "flac") return 12;
  if (file.ext === "wav") return 13;
  return null;
}

function rankPicture(file: ArchiveFile): number | null {
  if (THUMB_FORMAT.test(file.format) || THUMB_NAME.test(file.name)) return null;
  if (file.ext !== "jpg" && file.ext !== "jpeg" && file.ext !== "png") return null;
  const format = file.format.toLowerCase();
  if (file.original && (format === "jpeg" || format === "png")) return 0;
  if (format === "jpeg" || format === "png") return 1;
  return file.original ? 2 : 3;
}

const RANKERS: Record<ResearchMediaKind, (file: ArchiveFile) => number | null> = {
  video: rankVideo,
  audio: rankAudio,
  picture: rankPicture,
};

function downloadUrl(identifier: string, name: string): string {
  return `https://archive.org/download/${encodeURIComponent(identifier)}/${name
    .split("/")
    .map(encodeURIComponent)
    .join("/")}`;
}

/**
 * The item's `licenseurl`. Old public-domain dedications (`creativecommons.org/licenses/publicdomain/`, the U.S.
 * government `…/publicdomain/label/…`) are not CC licenses `normalizeLicense` knows by URL, so they carry the name.
 */
function licenseOf(licenseUrl: string | null): LicenseInfo {
  return licenseUrl
    ? normalizeLicense({
        name: /\/publicdomain\b/i.test(licenseUrl) ? "Public domain" : null,
        url: licenseUrl,
        confidence: "high",
        basis: "Internet Archive metadata (licenseurl)",
      })
    : normalizeLicense({
        confidence: "none",
        basis: "Internet Archive item has no license field",
      });
}

/** A candidate from an item's `/metadata/` answer; null when the item has no usable file of `kind`. */
function candidateOf(
  identifier: string,
  metadata: unknown,
  kind: ResearchMediaKind,
  fallback: Rec | null,
): RawCandidate | null {
  if (!isRecord(metadata) || !isRecord(metadata.metadata)) return null;
  const meta = metadata.metadata;
  const file = best(readFiles(metadata.files), RANKERS[kind]);
  if (!file) return null;
  const title = text(meta.title) ?? text(fallback?.title) ?? identifier;
  const author = text(meta.creator) ?? text(fallback?.creator);
  const licenseUrl = first(meta.licenseurl) ?? first(fallback?.licenseurl);
  const description = text(meta.description) ?? text(fallback?.description) ?? "";
  const candidate: RawCandidate = {
    mediaKind: kind,
    title,
    description: clip(description, MAX_DESCRIPTION_CHARS),
    pageUrl: `https://archive.org/details/${encodeURIComponent(identifier)}`,
    mediaUrl: downloadUrl(identifier, file.name),
    previewUrl: `https://archive.org/services/img/${encodeURIComponent(identifier)}`,
    author,
    authorUrl: null,
    license: licenseOf(licenseUrl),
    width: file.width,
    height: file.height,
    duration: kind === "picture" ? null : file.duration,
    bytes: file.bytes,
    contentType: contentTypeFor(file.ext),
  };
  return candidate;
}

/** Lucene syntax characters out of the user's words: the query is always a plain word search. */
function plainQuery(query: string): string {
  return query
    .replace(/[()[\]{}"^~*?:\\/!+\-&|<>]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function searchUrl(query: string, kind: ResearchMediaKind, rows: number): string {
  const params = new URLSearchParams();
  params.set("q", `(${query}) AND mediatype:(${MEDIATYPE_BY_KIND[kind]})`);
  for (const field of ["identifier", "title", "creator", "licenseurl", "description"]) {
    params.append("fl[]", field);
  }
  params.set("rows", String(rows));
  params.set("output", "json");
  return `${SEARCH_URL}?${params.toString()}`;
}

function readDocs(json: unknown): Rec[] {
  const response = isRecord(json) ? json.response : null;
  if (!isRecord(response) || !Array.isArray(response.docs)) {
    throw new ResearchFailure(
      "provider_error",
      "Internet Archive answered in an unexpected format",
    );
  }
  return response.docs.filter(isRecord);
}

/** `archive.org/details/<identifier>[/…]`: the identifier, or null (`/download/…` files are fetched directly). */
function identifierOf(url: URL): string | null {
  if (!ARCHIVE_HOSTS.has(url.hostname.toLowerCase())) return null;
  const match = /^\/details\/([^/]+)/.exec(url.pathname);
  if (!match?.[1]) return null;
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return null;
  }
}

async function searchItem(
  doc: Rec,
  kind: ResearchMediaKind,
  ctx: ConnectorContext,
): Promise<RawCandidate | null> {
  const identifier = first(doc.identifier);
  if (!identifier) return null;
  try {
    const metadata = await ctx.http.getJson(`${METADATA_URL}${encodeURIComponent(identifier)}`);
    return candidateOf(identifier, metadata, kind, doc);
  } catch (error) {
    if (ctx.signal?.aborted) throw error;
    return null;
  }
}

export const archiveConnector: AssetConnector = {
  id: "internet_archive",

  async search(query, kind, limit, ctx) {
    const words = plainQuery(query);
    if (!words) return [];
    const rows = Math.max(1, Math.min(limit, MAX_SEARCH_LIMIT));
    const docs = readDocs(await ctx.http.getJson(searchUrl(words, kind, rows))).slice(0, limit);
    const found = await Promise.all(docs.map((doc) => searchItem(doc, kind, ctx)));
    return found.filter((candidate): candidate is RawCandidate => candidate !== null);
  },

  async describeUrl(url, kind, ctx): Promise<DescribedPage | null> {
    const identifier = identifierOf(url);
    if (!identifier) return null;
    const metadata = await ctx.http.getJson(`${METADATA_URL}${encodeURIComponent(identifier)}`);
    if (!isRecord(metadata) || !isRecord(metadata.metadata)) {
      throw new ResearchFailure("unavailable", `Internet Archive has no item "${identifier}"`);
    }
    const mediatype = first(metadata.metadata.mediatype);
    const itemKind = mediatype ? KIND_BY_MEDIATYPE[mediatype] : undefined;
    const notes: string[] = [];
    let found: RawCandidate | null = null;
    if (!itemKind) {
      notes.push(
        `This Internet Archive item is ${mediatype ?? "of an unknown type"}, not video, audio or a picture.`,
      );
    } else if (kind && kind !== itemKind) {
      notes.push(`This Internet Archive item is a ${itemKind}, not a ${kind}.`);
    } else {
      found = candidateOf(identifier, metadata, itemKind, null);
      if (!found) notes.push("The item has no downloadable file this editor can use.");
    }
    const meta = metadata.metadata;
    return {
      title: text(meta.title) ?? identifier,
      author: text(meta.creator),
      license: licenseOf(first(meta.licenseurl)),
      candidates: found ? [found] : [],
      notes,
    };
  },
};
