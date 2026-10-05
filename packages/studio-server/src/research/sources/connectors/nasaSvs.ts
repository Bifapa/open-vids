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

const API_BASE = "https://svs.gsfc.nasa.gov/api";
const SITE_HOST = "svs.gsfc.nasa.gov";
const MAX_SEARCH_LIMIT = 50;
const MAX_IN_FLIGHT = 4;
const MAX_DESCRIPTION_CHARS = 500;
/** SVS also archives 4K–8K masters and hyperwall renderings; a 1920 px edge keeps downloads and edits usable. */
const MAX_VIDEO_EDGE = 1920;
const MAX_PICTURE_EDGE = 4000;
const DEFAULT_CREDIT = "NASA Scientific Visualization Studio";
const MUSIC_NOTE =
  "Note: the credits mention music, which may be licensed separately from NASA's public-domain media.";

const LICENSE: LicenseInfo = normalizeLicense({
  name: "Public domain (NASA)",
  url: "https://www.nasa.gov/nasa-brand-center/images-and-media/",
  confidence: "high",
  basis: "NASA SVS (NASA media usage guidelines)",
});

/** Other stills a page lists next to the real picture: thumbnails, search icons and color bars. */
const NOT_A_PICTURE =
  /(?:_|-)(?:thm|thumb|thumbnail|searchweb)\b|cbar|colou?rbar|barwhite|barblack|legend/i;
const COLOR_BAR_GROUP = /\bcolou?r ?bar\b/i;
/** The service refuses videos beyond 600 MB; a listed size lets the pick avoid a download that is bound to fail. */
const MAX_VIDEO_BYTES = 500 * 1024 * 1024;
const UNIT_BYTES: Record<string, number> = { KB: 1024, MB: 1024 ** 2, GB: 1024 ** 3 };
/** Credit groups in the order they name the people who made the media. */
const CREDIT_ROLES = [/visuali[sz]|animat|illustrat/i, /produc/i, /photo|image|video|edit/i];

interface Instance {
  url: string;
  filename: string;
  mediaType: string;
  width: number | null;
  height: number | null;
  bytes: number | null;
}

interface Group {
  widget: string;
  description: string;
  instances: Instance[];
}

interface SvsPage {
  id: number;
  title: string;
  description: string;
  author: string;
  mainVideoUrl: string | null;
  mainImageUrl: string | null;
  groups: Group[];
}

interface SearchHit {
  id: number;
}

function str(rec: Record<string, unknown>, key: string): string | null {
  const value = rec[key];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function positive(rec: Record<string, unknown>, key: string): number | null {
  const value = rec[key];
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
}

function httpsUrl(raw: string | null): string | null {
  if (!raw) return null;
  try {
    const url = new URL(raw);
    if (url.hostname.toLowerCase() !== SITE_HOST) return null;
    url.protocol = "https:";
    return url.href;
  } catch {
    return null;
  }
}

function extensionOf(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot < 0 ? "" : name.slice(dot + 1).toLowerCase();
}

function readInstance(value: unknown): Instance | null {
  if (!isRecord(value)) return null;
  const url = httpsUrl(str(value, "url"));
  const filename = str(value, "filename");
  const mediaType = str(value, "media_type");
  if (!url || !filename || !mediaType) return null;
  return {
    url,
    filename,
    mediaType: mediaType.toLowerCase(),
    width: positive(value, "width"),
    height: positive(value, "height"),
    bytes: null,
  };
}

function readGroups(value: unknown): Group[] {
  if (!Array.isArray(value)) return [];
  const groups: Group[] = [];
  for (const raw of value) {
    if (!isRecord(raw) || !Array.isArray(raw.items)) continue;
    const instances: Instance[] = [];
    for (const item of raw.items) {
      const instance = isRecord(item) ? readInstance(item.instance) : null;
      if (instance) instances.push(instance);
    }
    if (instances.length === 0) continue;
    groups.push({
      widget: str(raw, "widget") ?? "",
      description: htmlToText(str(raw, "description") ?? ""),
      instances,
    });
  }
  return groups;
}

/** "name.mp4 (1920x1080) [185.1 MB]" entries of the description's file listing, by file name. */
function listedSizes(description: string): Map<string, number> {
  const sizes = new Map<string, number>();
  for (const match of description.matchAll(
    /\|\|\s*([^|]+?)\s+\(\d+x\d+\)\s+\[([\d.,]+)\s*(KB|MB|GB)\]/gi,
  )) {
    const [, name, amount, unit] = match;
    const factor = unit ? UNIT_BYTES[unit.toUpperCase()] : undefined;
    const value = Number(amount?.replace(",", ""));
    if (name && factor && Number.isFinite(value)) sizes.set(name, Math.round(value * factor));
  }
  return sizes;
}

/** "Visualizations by" first, then producers; the names of the first matching role (at most three). */
function authorOf(credits: unknown): string {
  if (!isRecord(credits)) return DEFAULT_CREDIT;
  const roles = Object.entries(credits);
  const ordered = [
    ...CREDIT_ROLES.flatMap((pattern) => roles.filter(([role]) => pattern.test(role))),
    ...roles,
  ];
  for (const [, people] of ordered) {
    if (!Array.isArray(people)) continue;
    const names: string[] = [];
    for (const person of people) {
      const name = isRecord(person) ? str(person, "name") : null;
      if (name && !names.includes(name)) names.push(name);
    }
    if (names.length > 0) return names.slice(0, 3).join(", ");
  }
  return DEFAULT_CREDIT;
}

function readPage(json: unknown): SvsPage {
  if (!isRecord(json)) {
    throw new ResearchFailure("provider_error", "NASA SVS answered in an unexpected format");
  }
  const id = positive(json, "id");
  const title = str(json, "title");
  if (id === null || !title) {
    throw new ResearchFailure("provider_error", "NASA SVS answered in an unexpected format");
  }
  const mainVideo = isRecord(json.main_video) ? json.main_video : null;
  const mainImage = isRecord(json.main_image) ? json.main_image : null;
  const rawDescription = str(json, "description") ?? "";
  const sizes = listedSizes(rawDescription);
  const groups = readGroups(json.media_groups).map((group) => ({
    ...group,
    instances: group.instances.map((instance) => ({
      ...instance,
      bytes: sizes.get(instance.filename) ?? null,
    })),
  }));
  return {
    id,
    title: htmlToText(title) || String(id),
    // The description ends with a "|| file (size) ||" listing of the page's files.
    description: htmlToText(rawDescription.split("||")[0] ?? ""),
    author: authorOf(json.main_credits),
    mainVideoUrl: httpsUrl(mainVideo ? str(mainVideo, "url") : null),
    mainImageUrl: httpsUrl(mainImage ? str(mainImage, "url") : null),
    groups,
  };
}

function longEdge(instance: Instance): number {
  return Math.max(instance.width ?? 0, instance.height ?? 0);
}

function pixels(instance: Instance): number {
  return (instance.width ?? 0) * (instance.height ?? 0);
}

interface Pick {
  instance: Instance;
  group: Group;
}

/** The MP4 to offer: the page's main video when it is small enough, else the first small MP4 (never a frame sequence). */
function pickVideo(page: SvsPage): Pick | null {
  const picks: Pick[] = [];
  for (const group of page.groups) {
    for (const instance of group.instances) {
      const edge = longEdge(instance);
      if (
        instance.mediaType === "movie" &&
        extensionOf(instance.filename) === "mp4" &&
        (instance.bytes ?? 0) <= MAX_VIDEO_BYTES &&
        edge > 0 &&
        edge <= MAX_VIDEO_EDGE
      ) {
        picks.push({ instance, group });
      }
    }
  }
  return picks.find((pick) => pick.instance.url === page.mainVideoUrl) ?? picks[0] ?? null;
}

/** The largest still up to 4000 px from a gallery or single-image group (a video's poster frames are not pictures). */
function pickPicture(page: SvsPage): Pick | null {
  const picks: Pick[] = [];
  for (const group of page.groups) {
    if (/video/i.test(group.widget) || COLOR_BAR_GROUP.test(group.description)) continue;
    for (const instance of group.instances) {
      const ext = extensionOf(instance.filename);
      if (
        instance.mediaType === "image" &&
        (ext === "jpg" || ext === "jpeg" || ext === "png") &&
        !NOT_A_PICTURE.test(instance.filename) &&
        longEdge(instance) > 0
      ) {
        picks.push({ instance, group });
      }
    }
  }
  const usable = picks.filter((pick) => longEdge(pick.instance) <= MAX_PICTURE_EDGE);
  const pool = usable.length > 0 ? usable : picks;
  const sorted = [...pool].sort((a, b) =>
    usable.length > 0
      ? pixels(b.instance) - pixels(a.instance)
      : pixels(a.instance) - pixels(b.instance),
  );
  return sorted[0] ?? null;
}

/** A small still of the same group to show before the download. */
function previewOf(page: SvsPage, group: Group): string | null {
  const stills = group.instances.filter(
    (instance) => instance.mediaType === "image" && /\.(jpe?g|png)$/i.test(instance.filename),
  );
  const poster =
    stills.find((still) => /_print\./i.test(still.filename)) ??
    stills.find((still) => /_searchweb\./i.test(still.filename)) ??
    stills[0];
  return poster?.url ?? page.mainImageUrl;
}

function toCandidate(page: SvsPage, kind: ResearchMediaKind): RawCandidate | null {
  const pick = kind === "video" ? pickVideo(page) : kind === "picture" ? pickPicture(page) : null;
  if (!pick) return null;
  const music =
    kind === "video" &&
    (/\bmusic\b/i.test(page.description) || /\bmusic\b/i.test(pick.group.description));
  const description = [clip(page.description, MAX_DESCRIPTION_CHARS), music ? MUSIC_NOTE : ""]
    .filter(Boolean)
    .join(" ");
  return {
    mediaKind: kind,
    title: page.title,
    description,
    pageUrl: `https://${SITE_HOST}/${page.id}/`,
    mediaUrl: pick.instance.url,
    previewUrl: previewOf(page, pick.group),
    author: page.author,
    authorUrl: null,
    license: LICENSE,
    width: pick.instance.width,
    height: pick.instance.height,
    duration: null,
    bytes: pick.instance.bytes,
    contentType: contentTypeFor(extensionOf(pick.instance.filename)),
  };
}

function readHits(json: unknown): SearchHit[] {
  if (!isRecord(json) || !Array.isArray(json.results)) {
    throw new ResearchFailure("provider_error", "NASA SVS answered in an unexpected format");
  }
  const hits: SearchHit[] = [];
  for (const raw of json.results) {
    const id = isRecord(raw) ? positive(raw, "id") : null;
    if (id !== null) hits.push({ id });
  }
  return hits;
}

/** A page whose detail request fails is skipped (the search still has other answers); an abort is not swallowed. */
async function candidateOf(
  hit: SearchHit,
  kind: ResearchMediaKind,
  ctx: ConnectorContext,
): Promise<RawCandidate | null> {
  try {
    return toCandidate(readPage(await ctx.http.getJson(`${API_BASE}/${hit.id}/`)), kind);
  } catch (error) {
    if (ctx.signal?.aborted) throw error;
    return null;
  }
}

async function candidatesOf(
  hits: SearchHit[],
  kind: ResearchMediaKind,
  limit: number,
  ctx: ConnectorContext,
): Promise<RawCandidate[]> {
  const slots: Array<RawCandidate | null> = hits.map(() => null);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < hits.length) {
      const index = next;
      next += 1;
      const hit = hits[index];
      if (hit) slots[index] = await candidateOf(hit, kind, ctx);
    }
  };
  await Promise.all(Array.from({ length: Math.min(MAX_IN_FLIGHT, hits.length) }, worker));
  return slots.filter((slot): slot is RawCandidate => slot !== null).slice(0, limit);
}

/** `svs.gsfc.nasa.gov/<id>/`: the page id, or null. */
function pageIdOf(url: URL): number | null {
  if (url.hostname.toLowerCase() !== SITE_HOST) return null;
  const match = /^\/(\d+)\/?$/.exec(url.pathname);
  return match?.[1] ? Number(match[1]) : null;
}

export const nasaSvsConnector: AssetConnector = {
  id: "nasa_svs",

  async search(query, kind, limit, ctx) {
    if (kind === "audio") return [];
    const size = Math.max(1, Math.min(limit, MAX_SEARCH_LIMIT));
    const url = `${API_BASE}/search/?${new URLSearchParams({ search: query, limit: String(size) }).toString()}`;
    const hits = readHits(await ctx.http.getJson(url)).slice(0, size);
    return candidatesOf(hits, kind, limit, ctx);
  },

  async describeUrl(url, kind, ctx): Promise<DescribedPage | null> {
    const id = pageIdOf(url);
    if (id === null) return null;
    const page = readPage(await ctx.http.getJson(`${API_BASE}/${id}/`));
    const kinds: ResearchMediaKind[] = kind ? [kind] : ["video", "picture"];
    const candidates = kinds
      .map((wanted) => toCandidate(page, wanted))
      .filter((candidate): candidate is RawCandidate => candidate !== null);
    const notes =
      candidates.length === 0
        ? [`NASA SVS lists no usable ${kind ?? "video or picture"} file for this page.`]
        : [];
    return { title: page.title, author: page.author, license: LICENSE, candidates, notes };
  },
};
