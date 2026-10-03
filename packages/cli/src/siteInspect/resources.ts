/**
 * The files a page loaded or points at, turned into {@link WebsiteResource} entries: what each one is (kind from the
 * response's mime type, the element that used it, or its extension), which of them is the same file (dedupe by URL
 * without its fragment), and in what order the list is shown (visible media first, then styles and scripts).
 *
 * Everything here is Node-side and pure; the page's own DOM half (`pageScript.ts` `RESOURCE_SCRIPT`) only reports
 * raw references, which `rawPage.ts` checks before they reach this module.
 */

import {
  isRecord,
  type WebsiteResource,
  type WebsiteResourceKind,
} from "@hyperframes/agent-protocol";
import type { RawResourceRef } from "./pageScript.js";

export interface CollectedResource {
  url: string;
  kind: WebsiteResourceKind;
  mimeType: string | null;
  /** Response size, when a response answered for it. */
  bytes: number | null;
  width: number | null;
  height: number | null;
  duration: number | null;
  usage: string;
}

/** Most visible first: what a page shows, then what it reads. */
export const RESOURCE_KIND_ORDER: readonly WebsiteResourceKind[] = [
  "video",
  "animation",
  "image",
  "svg",
  "audio",
  "font",
  "stylesheet",
  "script",
  "document",
  "data",
  "other",
];

/** The URL of a file, without the fragment that only names a place inside it. */
export function resourceKey(url: string): string {
  try {
    const parsed = new URL(url);
    parsed.hash = "";
    return parsed.href;
  } catch {
    return url.split("#")[0] ?? url;
  }
}

const EXTENSION_KINDS: Record<string, WebsiteResourceKind> = {
  svg: "svg",
  png: "image",
  jpg: "image",
  jpeg: "image",
  webp: "image",
  gif: "image",
  avif: "image",
  ico: "image",
  bmp: "image",
  mp4: "video",
  webm: "video",
  mov: "video",
  m4v: "video",
  ogv: "video",
  mp3: "audio",
  wav: "audio",
  ogg: "audio",
  oga: "audio",
  m4a: "audio",
  aac: "audio",
  flac: "audio",
  woff2: "font",
  woff: "font",
  ttf: "font",
  otf: "font",
  css: "stylesheet",
  js: "script",
  mjs: "script",
  json: "data",
  lottie: "animation",
  riv: "animation",
  html: "document",
  htm: "document",
};

function kindFromMime(mimeType: string | null): WebsiteResourceKind | null {
  if (!mimeType) return null;
  const mime = mimeType.toLowerCase();
  if (/^image\/svg\+xml/.test(mime)) return "svg";
  if (/^image\//.test(mime)) return "image";
  if (/^video\//.test(mime)) return "video";
  if (/^audio\//.test(mime)) return "audio";
  if (/^(font\/|application\/(x-)?font|application\/vnd\.ms-opentype|application\/sfnt)/.test(mime))
    return "font";
  if (/^text\/css/.test(mime)) return "stylesheet";
  if (/^(text|application)\/(x-)?(java|ecma)script/.test(mime)) return "script";
  if (/^(text\/html|application\/xhtml\+xml)/.test(mime)) return "document";
  if (/^(application\/(json|ld\+json|xml)|text\/(json|xml|plain))/.test(mime)) return "data";
  if (/^application\/(zip|x-zip|octet-stream|vnd\.rar)/.test(mime)) return "other";
  return null;
}

function kindFromExtension(url: string): WebsiteResourceKind | null {
  let path = url;
  try {
    path = new URL(url).pathname;
  } catch {
    // not a URL: fall back to the raw string
  }
  const extension = /\.([a-z0-9]+)$/i.exec(path)?.[1]?.toLowerCase();
  return extension ? (EXTENSION_KINDS[extension] ?? null) : null;
}

function kindFromNetworkType(resourceType: string | undefined): WebsiteResourceKind | null {
  switch (resourceType) {
    case "image":
      return "image";
    case "media":
      return "video";
    case "font":
      return "font";
    case "stylesheet":
      return "stylesheet";
    case "script":
      return "script";
    case "document":
      return "document";
    default:
      return null;
  }
}

/** What a file is: the response's mime type first, then what the element that used it implies, then its extension. */
export function classifyResource(input: {
  url: string;
  mimeType: string | null;
  /** What the DOM element implies (a `<video>` is a video whatever it is served as). */
  hint?: WebsiteResourceKind;
  /** CDP resource type of the response that answered for it. */
  networkType?: string;
}): WebsiteResourceKind {
  const fromMime = kindFromMime(input.mimeType);
  // A Lottie/Rive player's file is often served as JSON or octet-stream: the element knows better.
  if (
    input.hint === "animation" &&
    (fromMime === null || fromMime === "data" || fromMime === "other")
  ) {
    return "animation";
  }
  if (fromMime !== null && fromMime !== "data" && fromMime !== "other") return fromMime;
  if (input.hint && input.hint !== "data" && input.hint !== "other") return input.hint;
  const fromNetwork = kindFromNetworkType(input.networkType);
  if (fromNetwork) return fromNetwork;
  if (fromMime !== null) return fromMime;
  return kindFromExtension(input.url) ?? "other";
}

/** A Lottie animation is JSON with a version, a frame rate and layers — that is the whole check. */
export function looksLikeLottie(text: string): boolean {
  try {
    const parsed: unknown = JSON.parse(text);
    if (!isRecord(parsed)) return false;
    const version = parsed.v;
    const rate = parsed.fr;
    return (
      (typeof version === "string" || typeof version === "number") &&
      typeof rate === "number" &&
      Number.isFinite(rate) &&
      Array.isArray(parsed.layers)
    );
  } catch {
    return false;
  }
}

/** A specific kind replaces a generic one; a generic one never replaces a specific one. */
function preferSpecific(
  current: WebsiteResourceKind,
  candidate: WebsiteResourceKind,
): WebsiteResourceKind {
  return (current === "data" || current === "other") && candidate !== "other" ? candidate : current;
}

/**
 * The DOM's references and the responses the page received, as one list: a file both halves know keeps the DOM's
 * usage and size and gains the response's mime type and byte count; a file only a response knows is added without a
 * usage. The order is {@link RESOURCE_KIND_ORDER}, stable inside a kind.
 */
export function mergeResources(
  dom: readonly RawResourceRef[],
  network: readonly CollectedResource[],
  limit: number,
): WebsiteResource[] {
  const byKey = new Map<string, CollectedResource>();
  for (const entry of dom) {
    const key = resourceKey(entry.url);
    if (byKey.has(key)) continue;
    byKey.set(key, {
      url: entry.url,
      kind: entry.kind,
      mimeType: null,
      bytes: null,
      width: entry.width,
      height: entry.height,
      duration: entry.duration,
      usage: entry.usage,
    });
  }
  for (const entry of network) {
    const key = resourceKey(entry.url);
    const known = byKey.get(key);
    if (!known) {
      byKey.set(key, { ...entry });
      continue;
    }
    known.mimeType ??= entry.mimeType;
    known.bytes ??= entry.bytes;
    // The response says what the file is (an `<img>` pointing at `image/svg+xml` is an SVG); the element said what
    // it looked like when the response did not.
    if (entry.mimeType !== null) {
      known.kind = classifyResource({
        url: known.url,
        mimeType: entry.mimeType,
        hint: known.kind,
      });
    }
    // A response the reader opened and recognized (a Lottie JSON) is more specific than "data".
    known.kind = preferSpecific(known.kind, entry.kind);
  }
  const rank = (kind: WebsiteResourceKind) => {
    const index = RESOURCE_KIND_ORDER.indexOf(kind);
    return index === -1 ? RESOURCE_KIND_ORDER.length : index;
  };
  return [...byKey.values()]
    .map((entry, index) => ({ entry, index }))
    .sort((a, b) => rank(a.entry.kind) - rank(b.entry.kind) || a.index - b.index)
    .slice(0, limit)
    .map(({ entry }) => ({ ...entry }));
}
