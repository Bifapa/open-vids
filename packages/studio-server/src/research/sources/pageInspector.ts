import {
  isRecord,
  normalizeLicense,
  type LicenseInfo,
  type ResearchMediaKind,
} from "@hyperframes/agent-protocol";
import { parseHTML } from "linkedom";
import { ResearchFailure } from "../errors.js";
import { clip } from "./htmlText.js";
import {
  contentTypeFor,
  extensionFor,
  isStreamManifest,
  mediaKindFromContentType,
  mediaKindFromUrl,
} from "./mediaTypes.js";
import type { RawCandidate, ResearchHttp } from "./types.js";

export interface InspectedHtml {
  title: string | null;
  author: string | null;
  license: LicenseInfo;
  candidates: RawCandidate[];
  notes: string[];
}

export interface InspectedPage extends InspectedHtml {
  finalUrl: string;
}

const MAX_TITLE_CHARS = 200;
const MAX_AUTHOR_CHARS = 200;
const MAX_DESCRIPTION_CHARS = 500;
const MIN_PICTURE_SIDE = 200;
const NOT_CONTENT_IMAGE = /sprite|icon|logo|avatar|favicon|pixel|tracking/i;
const STREAM_NOTE = "Streamed media (HLS/DASH) is not downloaded.";
const KIND_ORDER: Record<ResearchMediaKind, number> = { video: 0, audio: 1, picture: 2 };

interface Found {
  url: string;
  kind: ResearchMediaKind;
  contentType: string | null;
  width: number | null;
  height: number | null;
  previewUrl: string | null;
  duration: number | null;
}

interface AddOptions {
  /** The kind the place implies (`<video>`, `og:image`…), used when neither the URL nor `type` names one. */
  hint?: ResearchMediaKind;
  /** The declared MIME type, when the markup has one. */
  type?: string | null;
  width?: number | null;
  height?: number | null;
  preview?: string | null;
  duration?: number | null;
}

function dimension(value: string | null | undefined): number | null {
  if (!value) return null;
  const n = Number(value.trim());
  return Number.isFinite(n) && n > 0 ? Math.round(n) : null;
}

function seconds(value: string | null | undefined): number | null {
  if (!value) return null;
  const n = Number(value.trim());
  return Number.isFinite(n) && n > 0 ? n : null;
}

function fileTitle(url: string): string {
  try {
    const last = new URL(url).pathname.split("/").pop() ?? "";
    const name = decodeURIComponent(last).replace(/\.[a-z0-9]{2,5}$/i, "");
    return name.replace(/[_+]+/g, " ").replace(/\s+/g, " ").trim() || new URL(url).hostname;
  } catch {
    return url;
  }
}

/** The name of a JSON-LD `author`/`creator` value: a string, `{name}`, or a list of those. */
function personName(value: unknown): string | null {
  if (typeof value === "string") return value.trim() || null;
  if (Array.isArray(value)) {
    const names = value.map(personName).filter((name): name is string => name !== null);
    return names.length > 0 ? names.slice(0, 3).join(", ") : null;
  }
  if (isRecord(value)) return personName(value.name);
  return null;
}

function licenseUrlOf(value: unknown): string | null {
  if (typeof value === "string") return value.trim() || null;
  if (Array.isArray(value)) {
    for (const entry of value) {
      const url = licenseUrlOf(entry);
      if (url) return url;
    }
    return null;
  }
  if (isRecord(value)) return licenseUrlOf(value.url ?? value["@id"]);
  return null;
}

interface StructuredData {
  license: string | null;
  author: string | null;
}

/** `license` and `author`/`creator` from the page's JSON-LD blocks (any depth, `@graph` included). */
function readJsonLd(blocks: string[]): StructuredData {
  const found: StructuredData = { license: null, author: null };
  let budget = 2_000;
  const walk = (node: unknown, depth: number): void => {
    if (budget-- <= 0 || depth > 8) return;
    if (Array.isArray(node)) {
      for (const entry of node) walk(entry, depth + 1);
      return;
    }
    if (!isRecord(node)) return;
    found.license ??= licenseUrlOf(node.license);
    found.author ??= personName(node.author) ?? personName(node.creator);
    for (const value of Object.values(node)) {
      if (typeof value === "object" && value !== null) walk(value, depth + 1);
    }
  };
  for (const block of blocks) {
    try {
      walk(JSON.parse(block), 0);
    } catch {
      // A broken block is just not a source of information.
    }
  }
  return found;
}

/**
 * Reads what an HTML page offers: its media (`og:*`, `<video>`, `<audio>`, `<source>`, media links, and pictures),
 * its title, its author and whatever license it declares. Pure; the HTML is already size-bounded by the caller.
 */
export function inspectHtml(
  html: string,
  pageUrl: string,
  kind?: ResearchMediaKind,
): InspectedHtml {
  const { document } = parseHTML(html);

  let base = pageUrl;
  const baseHref = document.querySelector("base[href]")?.getAttribute("href");
  if (baseHref) {
    try {
      base = new URL(baseHref, pageUrl).href;
    } catch {
      // Keep the page URL as the base.
    }
  }

  const meta = new Map<string, string[]>();
  for (const element of document.querySelectorAll("meta")) {
    const key = (element.getAttribute("property") ?? element.getAttribute("name") ?? "")
      .trim()
      .toLowerCase();
    const content = element.getAttribute("content")?.trim();
    if (!key || !content) continue;
    const values = meta.get(key);
    if (values) values.push(content);
    else meta.set(key, [content]);
  }
  const metaFirst = (...keys: string[]): string | null => {
    for (const key of keys) {
      const value = meta.get(key)?.[0];
      if (value) return value;
    }
    return null;
  };

  let streamSeen = false;
  const resolve = (raw: string | null | undefined): string | null => {
    const value = raw?.trim();
    if (!value) return null;
    try {
      const url = new URL(value, base);
      if (url.protocol !== "http:" && url.protocol !== "https:") return null;
      url.hash = "";
      if (isStreamManifest(url.href, null)) {
        streamSeen = true;
        return null;
      }
      return url.href;
    } catch {
      return null;
    }
  };

  const seen = new Set<string>();
  const found: Found[] = [];
  /** Adds a media URL. A URL that names no media is accepted only where `hint` says what the place holds. */
  const add = (raw: string | null | undefined, options: AddOptions): boolean => {
    const url = resolve(raw);
    if (!url || seen.has(url)) return false;
    const type = options.type?.split(";")[0]?.trim().toLowerCase() || null;
    if (type && isStreamManifest(url, type)) {
      streamSeen = true;
      return false;
    }
    const mediaKind =
      mediaKindFromUrl(url) ?? mediaKindFromContentType(type) ?? options.hint ?? null;
    if (!mediaKind) return false;
    seen.add(url);
    found.push({
      url,
      kind: mediaKind,
      contentType:
        type && mediaKindFromContentType(type)
          ? type
          : contentTypeFor(extensionFor(url, null) ?? ""),
      width: options.width ?? null,
      height: options.height ?? null,
      previewUrl: options.preview ? resolve(options.preview) : null,
      duration: options.duration ?? null,
    });
    return true;
  };

  const ogImage = metaFirst("og:image", "og:image:url", "og:image:secure_url");

  // Declared media first: Open Graph / Twitter player metadata. `og:video` is often an embed page, so a URL counts
  // only when it names a media file or the page declares a media MIME type for it.
  const videoType = metaFirst("og:video:type");
  if (!videoType || mediaKindFromContentType(videoType)) {
    for (const key of ["og:video", "og:video:url", "og:video:secure_url"]) {
      for (const value of meta.get(key) ?? []) {
        add(value, {
          type: videoType,
          width: dimension(metaFirst("og:video:width")),
          height: dimension(metaFirst("og:video:height")),
          preview: ogImage,
          duration: seconds(metaFirst("video:duration", "og:video:duration")),
        });
      }
    }
  }
  for (const [key, typeKey] of [
    ["og:audio", "og:audio:type"],
    ["og:audio:url", "og:audio:type"],
    ["og:audio:secure_url", "og:audio:type"],
    ["twitter:player:stream", "twitter:player:stream:content_type"],
  ] as const) {
    const type = metaFirst(typeKey);
    if (type && !mediaKindFromContentType(type)) continue;
    for (const value of meta.get(key) ?? []) add(value, { type, preview: ogImage });
  }

  // Media elements.
  for (const element of document.querySelectorAll("video, audio")) {
    const hint: ResearchMediaKind = element.localName.toLowerCase() === "audio" ? "audio" : "video";
    const shared: AddOptions = {
      hint,
      width: dimension(element.getAttribute("width")),
      height: dimension(element.getAttribute("height")),
      preview: element.getAttribute("poster") ?? ogImage,
    };
    add(element.getAttribute("src"), shared);
    for (const source of element.querySelectorAll("source")) {
      add(source.getAttribute("src"), { ...shared, type: source.getAttribute("type") });
    }
  }
  for (const source of document.querySelectorAll("source")) {
    const parent = source.parentElement?.localName.toLowerCase();
    if (parent === "video" || parent === "audio" || parent === "picture") continue; // handled above / srcset
    add(source.getAttribute("src"), { type: source.getAttribute("type") });
  }

  // Pictures: og:image first, then links that point straight at media files.
  if (ogImage) {
    add(ogImage, {
      hint: "picture",
      width: dimension(metaFirst("og:image:width")),
      height: dimension(metaFirst("og:image:height")),
    });
  }
  for (const anchor of document.querySelectorAll("a[href]")) {
    const href = resolve(anchor.getAttribute("href"));
    if (href && mediaKindFromUrl(href)) add(href, {});
  }
  if (kind === "picture" || (kind === undefined && found.length === 0)) {
    for (const img of document.querySelectorAll("img")) {
      const src =
        img.getAttribute("src") ??
        img.getAttribute("data-src") ??
        img.getAttribute("data-lazy-src");
      const width = dimension(img.getAttribute("width"));
      const height = dimension(img.getAttribute("height"));
      if (
        (width !== null && width < MIN_PICTURE_SIDE) ||
        (height !== null && height < MIN_PICTURE_SIDE)
      )
        continue;
      const url = resolve(src);
      if (!url || /\.svg$/i.test(new URL(url).pathname) || NOT_CONTENT_IMAGE.test(url)) continue;
      add(url, { hint: "picture", width, height });
    }
  }

  // License: the page's own machine-readable declaration beats a link, which beats a mention.
  const jsonLd = readJsonLd(
    [...document.querySelectorAll('script[type="application/ld+json"]')].map(
      (script) => script.textContent ?? "",
    ),
  );
  let license: LicenseInfo | null = null;
  for (const link of document.querySelectorAll(
    "link[rel~='license'][href], a[rel~='license'][href]",
  )) {
    const url = resolve(link.getAttribute("href"));
    if (url) {
      license = normalizeLicense({
        url,
        confidence: "medium",
        basis: "rel=license link on the page",
      });
      break;
    }
  }
  if (!license && jsonLd.license) {
    const url = resolve(jsonLd.license);
    if (url) license = normalizeLicense({ url, confidence: "medium", basis: "JSON-LD license" });
  }
  if (!license) {
    for (const anchor of document.querySelectorAll("a[href*='creativecommons.org']")) {
      const url = resolve(anchor.getAttribute("href"));
      if (url && /creativecommons\.org\/(licenses|publicdomain)\/[a-z]/i.test(url)) {
        license = normalizeLicense({
          url,
          confidence: "low",
          basis: "creativecommons.org link on the page",
        });
        break;
      }
    }
  }

  // Author and title come before the text scan: it removes scripts and styles from the document.
  const byline =
    jsonLd.author ??
    metaFirst("author") ??
    document.querySelector("a[rel~='author']")?.textContent ??
    document.querySelector(".byline, [itemprop='author']")?.textContent ??
    null;
  const author = byline?.replace(/^\s*by\s+/i, "") ?? null;
  const title = metaFirst("og:title") ?? document.querySelector("title")?.textContent ?? null;

  if (!license) {
    for (const node of document.querySelectorAll("script, style, noscript")) node.remove();
    const mention = /\b(public domain|cc0)\b/i.exec(
      document.body?.textContent ?? document.documentElement?.textContent ?? "",
    );
    license = mention?.[1]
      ? normalizeLicense({ name: mention[1], confidence: "low", basis: "text mention" })
      : normalizeLicense({ confidence: "none", basis: "No license information found on the page" });
  }

  const pageTitle = title ? clip(title, MAX_TITLE_CHARS) || null : null;
  const pageAuthor = author ? clip(author, MAX_AUTHOR_CHARS) || null : null;
  const description = clip(metaFirst("og:description", "description") ?? "", MAX_DESCRIPTION_CHARS);

  const notes: string[] = [];
  if (streamSeen) notes.push(STREAM_NOTE);
  const wanted = found
    .filter((entry) => kind === undefined || entry.kind === kind)
    .sort((a, b) => KIND_ORDER[a.kind] - KIND_ORDER[b.kind]);
  if (wanted.length === 0) notes.push(`No ${kind ?? "media"} file found on the page.`);

  const candidates: RawCandidate[] = wanted.map((entry) => ({
    mediaKind: entry.kind,
    title: pageTitle ?? fileTitle(entry.url),
    description,
    pageUrl,
    mediaUrl: entry.url,
    previewUrl: entry.kind === "picture" ? null : entry.previewUrl,
    author: pageAuthor,
    authorUrl: null,
    license,
    width: entry.width,
    height: entry.height,
    duration: entry.duration,
    bytes: null,
    contentType: entry.contentType,
  }));

  return { title: pageTitle, author: pageAuthor, license, candidates, notes };
}

/**
 * Reads one URL through the policy-checked client: a direct media file is one candidate (no license known), an HTML
 * page is inspected, anything else is `not_media`.
 */
export async function inspectPage(
  url: string,
  kind: ResearchMediaKind | undefined,
  http: ResearchHttp,
): Promise<InspectedPage> {
  const page = await http.getPage(url);
  if (page.kind === "html") {
    return { finalUrl: page.finalUrl, ...inspectHtml(page.html, page.finalUrl, kind) };
  }
  if (page.kind === "other") {
    throw new ResearchFailure(
      "not_media",
      `${page.finalUrl} is neither a web page nor a media file (${page.contentType ?? "unknown type"})`,
    );
  }
  const title = fileTitle(page.finalUrl);
  const license = normalizeLicense({
    confidence: "none",
    basis: "Direct media URL: no license information",
  });
  const notes: string[] = [];
  let candidates: RawCandidate[] = [];
  if (isStreamManifest(page.finalUrl, page.contentType)) {
    notes.push(STREAM_NOTE);
  } else if (kind && page.mediaKind !== kind) {
    notes.push(`The URL is a ${page.mediaKind} file, not a ${kind}.`);
  } else {
    candidates = [
      {
        mediaKind: page.mediaKind,
        title,
        description: "",
        pageUrl: page.finalUrl,
        mediaUrl: page.finalUrl,
        previewUrl: null,
        author: null,
        authorUrl: null,
        license,
        width: null,
        height: null,
        duration: null,
        bytes: page.bytes,
        contentType: page.contentType.split(";")[0]?.trim().toLowerCase() || null,
      },
    ];
  }
  return { finalUrl: page.finalUrl, title, author: null, license, candidates, notes };
}
