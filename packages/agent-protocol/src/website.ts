/**
 * The website style reader: an agent reads a page the user linked in chat and gets the site's visual identity
 * (palette, fonts, logo, type scale, radii, buttons, motion character, screenshots) to build a motion composition in
 * that style, plus the list of files the page uses ({@link WebsiteResource}).
 *
 * - The page is rendered in headless Chrome inside a CLI child process of the Studio server (never in the server
 *   itself); the server checks the global `websites.readLinkedPages` setting and the address rules (public http(s)
 *   hosts only) and answers {@link ReadWebsiteResult}.
 * - Which sites an agent may ask for (only the ones the user linked in the chat) is enforced by the agent runtime,
 *   which knows the messages; the server never sees them.
 * - `save` writes the screenshots, the logo and the self-hosted font files actually used into `assets/web/<host>/`,
 *   each with a provenance record (origin "website reference", license unknown) in the project's research ledger.
 * - Full access (`websites.fullAccess`, off by default): {@link WebsiteFileRequest} downloads any file of a linked
 *   site (or one its pages load from elsewhere) into `assets/web/<host>/files/`, or returns the text of a page, style
 *   sheet or script; {@link RecordWebsiteRequest} records a page as an MP4 into `assets/web/<host>/recordings/`.
 *   Both are refused (`blocked_by_policy`) while full access is off. The runtime decides which URLs are "of a linked
 *   site": the user's sites, and every resource a read of such a site listed.
 *
 * Browser-safe: no Node imports.
 */

import type { AgentId } from "./types.js";
import { isRecord } from "./validate.js";

export const WEBSITE_ASSET_DIR = "assets/web";
/** `AssetSourceRef.id` of every saved website reference. */
export const WEBSITE_SOURCE_ID = "website";

export const WEBSITE_LIMITS = {
  textChars: 300,
  urlChars: 2_048,
  colors: 24,
  fonts: 12,
  weightsPerFont: 9,
  textStyles: 8,
  radii: 8,
  shadows: 6,
  buttons: 6,
  tokens: 48,
  tokenValueChars: 200,
  durations: 10,
  easings: 8,
  keyframes: 16,
  properties: 10,
  headings: 12,
  navLabels: 12,
  logos: 6,
  notes: 8,
  /** Self-hosted font files saved per read. */
  savedFonts: 6,
  fontFileBytes: 1_500_000,
  logoFileBytes: 400_000,
  screenshotBytes: 1_500_000,
  /** Files listed in {@link WebsiteStyle.resources}. */
  resources: 200,
  /** Largest file a full-access download saves. */
  fileBytes: 300_000_000,
  /** Largest text a full-access read returns (longer text is cut, `truncated: true`). */
  readTextChars: 200_000,
  /** Length of a page recording, seconds. */
  recordMinSeconds: 1,
  recordMaxSeconds: 30,
  /** Largest recording viewport side, pixels (even numbers). */
  recordMaxSide: 1920,
  selectorChars: 300,
} as const;

// ── The extracted style ──────────────────────────────────────────────────────

export const WEBSITE_COLOR_ROLES = [
  "background",
  "surface",
  "text",
  "muted",
  "accent",
  "border",
  "other",
] as const;
export type WebsiteColorRole = (typeof WEBSITE_COLOR_ROLES)[number];

export interface WebsiteColor {
  /** `#rrggbb` (lower case). */
  hex: string;
  role: WebsiteColorRole;
  /** How many sampled elements use it for that role. */
  count: number;
}

export const WEBSITE_FONT_SOURCES = ["google", "self_hosted", "system"] as const;
/** `google`: referenced by family name from Google Fonts; `self_hosted`: a font file the site serves; `system`: a local font. */
export type WebsiteFontSource = (typeof WEBSITE_FONT_SOURCES)[number];

export const WEBSITE_FONT_USES = ["heading", "body", "code", "other"] as const;
export type WebsiteFontUse = (typeof WEBSITE_FONT_USES)[number];

export interface WebsiteFont {
  family: string;
  weights: number[];
  source: WebsiteFontSource;
  /** Google Fonts stylesheet, or the font file of a self-hosted family; null for system fonts. */
  url: string | null;
  usedFor: WebsiteFontUse[];
}

export const WEBSITE_TEXT_ELEMENTS = ["h1", "h2", "h3", "body", "small"] as const;
export type WebsiteTextElement = (typeof WEBSITE_TEXT_ELEMENTS)[number];

export interface WebsiteTextStyle {
  element: WebsiteTextElement;
  /** A few words of the sampled text. */
  sample: string;
  fontFamily: string;
  fontSizePx: number;
  fontWeight: number;
  lineHeightPx: number | null;
  letterSpacingPx: number | null;
  color: string | null;
}

export interface WebsiteRadius {
  px: number;
  count: number;
}

export interface WebsiteButton {
  label: string;
  background: string | null;
  color: string | null;
  /** CSS border shorthand, e.g. `1px solid #2a2a2a`; null when there is none. */
  border: string | null;
  radiusPx: number;
  fontSizePx: number;
  fontWeight: number;
  padding: string;
  shadow: string | null;
}

export interface WebsiteToken {
  /** A CSS custom property that looks like a design token (`--color-primary`, `--font-sans`, `--radius-md`). */
  name: string;
  value: string;
}

export interface WebsiteMotion {
  durationsMs: number[];
  easings: string[];
  /** `@keyframes` names. */
  keyframes: string[];
  /** Properties the page transitions most (`opacity`, `transform`). */
  properties: string[];
}

export const WEBSITE_LOGO_SOURCES = ["inline_svg", "image", "og_image", "icon"] as const;
export type WebsiteLogoSource = (typeof WEBSITE_LOGO_SOURCES)[number];

export interface WebsiteLogo {
  source: WebsiteLogoSource;
  /** Absolute URL of the image; for an inline SVG, the page it sits on. */
  url: string;
  alt: string;
  width: number | null;
  height: number | null;
  /** Whether the logo's bytes were captured (they are what `save` writes). */
  captured: boolean;
}

export const WEBSITE_RESOURCE_KINDS = [
  "image",
  "svg",
  "video",
  "audio",
  /** Lottie JSON or `.lottie`, Rive `.riv`. */
  "animation",
  "font",
  "stylesheet",
  "script",
  "document",
  /** Other JSON/XML/text the page fetched. */
  "data",
  "other",
] as const;
export type WebsiteResourceKind = (typeof WEBSITE_RESOURCE_KINDS)[number];

/** A file the page loaded or references (network responses plus `src`/`href`/`poster`/CSS `url()` in the DOM). */
export interface WebsiteResource {
  /** Absolute http(s) URL. */
  url: string;
  kind: WebsiteResourceKind;
  mimeType: string | null;
  /** Response size, when it was loaded. */
  bytes: number | null;
  /** Natural size of a picture or video, when the page shows it. */
  width: number | null;
  height: number | null;
  /** Video/audio length in seconds, when the page shows it. */
  duration: number | null;
  /** Where the page uses it, short: `<video> autoplay loop in .hero`, `CSS background of .card`, `Lottie player`. */
  usage: string;
}

export interface WebsiteStyle {
  /** The URL that was asked for. */
  url: string;
  /** After redirects. */
  finalUrl: string;
  /** Lower-case host of the final URL without `www.`; the folder under `assets/web/`. */
  host: string;
  title: string;
  description: string;
  themeColor: string | null;
  language: string | null;
  colors: WebsiteColor[];
  fonts: WebsiteFont[];
  textStyles: WebsiteTextStyle[];
  radii: WebsiteRadius[];
  shadows: string[];
  buttons: WebsiteButton[];
  tokens: WebsiteToken[];
  motion: WebsiteMotion;
  /** Best first. */
  logos: WebsiteLogo[];
  favicon: string | null;
  ogImage: string | null;
  headings: string[];
  navLabels: string[];
  /** What the reader noticed: a cookie wall, a bot check, a page that rendered mostly empty. */
  notes: string[];
  /** Files the page uses, most visible first (media before styles and scripts); empty from older readers. */
  resources: WebsiteResource[];
  capturedAt: number;
}

// ── Request and result ───────────────────────────────────────────────────────

/** `POST /api/projects/:id/research/website`. */
export interface ReadWebsiteRequest {
  url: string;
  /** Write screenshots, logo and self-hosted fonts into `assets/web/<host>/` (with provenance). */
  save?: boolean;
  /** Set by the runtime: makes a `save` request cancellable (`POST …/research/requests/:requestId/cancel`). */
  requestId?: string;
  /**
   * The registrable domains of the websites the user linked (set by the runtime, never the model). When present, the
   * server refuses a request whose address, or any redirect hop or final address, is outside them, before anything
   * is fetched further or written. Absent: no site scope is enforced here (the runtime's own checks still apply).
   */
  allowedSites?: string[];
  /** Set by the runtime, never the model. */
  turnId?: string;
  agent?: AgentId | "user";
  model?: string | null;
}

export interface WebsiteScreenshot {
  /** `viewport.jpg` (above the fold, 1440×900) or `fullpage.jpg` (scaled to at most 1440×3000). */
  name: string;
  mimeType: string;
  /** Base64. */
  data: string;
  width: number;
  height: number;
}

export interface SavedWebsiteFont {
  family: string;
  weight: number;
  style: "normal" | "italic";
  /** Project-relative path. */
  path: string;
}

export interface SavedWebsiteFiles {
  /** `assets/web/<host>`. */
  dir: string;
  /** Every project-relative file written (or already present with the same bytes). */
  files: string[];
  logo: string | null;
  screenshots: string[];
  fonts: SavedWebsiteFont[];
}

export interface ReadWebsiteResult {
  site: WebsiteStyle;
  screenshots: WebsiteScreenshot[];
  saved?: SavedWebsiteFiles;
}

export const WEBSITE_FILE_MODES = ["save", "read"] as const;
/** `save`: download into the project; `read`: return the text (page, style sheet, script, JSON, SVG), nothing saved. */
export type WebsiteFileMode = (typeof WEBSITE_FILE_MODES)[number];

/** `POST /api/projects/:id/research/website/file` (full access only). */
export interface WebsiteFileRequest {
  url: string;
  mode: WebsiteFileMode;
  /** The linked page the file was found on (recorded as the provenance page). */
  pageUrl?: string;
  requestId?: string;
  /**
   * The registrable domains of the websites the user linked (set by the runtime, never the model). When present, the
   * server refuses a request whose address, or any redirect hop or final address, is outside them, before anything
   * is fetched further or written. Absent: no site scope is enforced here (the runtime's own checks still apply).
   */
  allowedSites?: string[];
  /** Set by the runtime, never the model. */
  turnId?: string;
  agent?: AgentId | "user";
  model?: string | null;
}

export interface WebsiteFileResult {
  url: string;
  /** After redirects. */
  finalUrl: string;
  kind: WebsiteResourceKind;
  mimeType: string | null;
  bytes: number;
  /** `read`: the text, cut at {@link WEBSITE_LIMITS.readTextChars}. */
  text?: string;
  truncated?: boolean;
  /** `save`: the project-relative file under `assets/web/<host>/files/` (an identical file is reused). */
  path?: string;
}

/** `POST /api/projects/:id/research/website/record` (full access only): a real-time recording of a page. */
export interface RecordWebsiteRequest {
  url: string;
  /** {@link WEBSITE_LIMITS.recordMinSeconds}–{@link WEBSITE_LIMITS.recordMaxSeconds}. */
  seconds: number;
  /** Record only this element (the video is cropped to it); default the whole viewport. */
  selector?: string;
  /** Scroll smoothly from the top to the bottom of the page during the recording. */
  scroll?: boolean;
  /** Viewport, default 1920×1080, even pixels up to {@link WEBSITE_LIMITS.recordMaxSide}. */
  width?: number;
  height?: number;
  requestId?: string;
  /**
   * The registrable domains of the websites the user linked (set by the runtime, never the model). When present, the
   * server refuses a request whose address, or any redirect hop or final address, is outside them, before anything
   * is fetched further or written. Absent: no site scope is enforced here (the runtime's own checks still apply).
   */
  allowedSites?: string[];
  turnId?: string;
  agent?: AgentId | "user";
  model?: string | null;
}

export interface RecordWebsiteResult {
  /** The project-relative MP4 under `assets/web/<host>/recordings/`. */
  path: string;
  finalUrl: string;
  width: number;
  height: number;
  /** Seconds. */
  duration: number;
  bytes: number;
  /** What the recorder noticed: the selector matched nothing, a cookie wall, a page that kept loading. */
  notes: string[];
}

/**
 * `read`: what `websites.readLinkedPages` allows (reading pages); `full`: what `websites.fullAccess` allows (files,
 * code, recordings — reading included).
 */
export const WEBSITE_GRANT_ACCESS = ["read", "full"] as const;
export type WebsiteGrantAccess = (typeof WEBSITE_GRANT_ACCESS)[number];

/**
 * `POST /api/projects/:id/research/website/grants` — the user allowed a Websites setting ONCE from the chat (the
 * runtime relays the click): until it is revoked (`DELETE …/website/grants/:turnId`, at the end of the turn) or
 * expires, website requests of that project carrying this `turnId` pass the setting's check as if it were on — for
 * `site` only (a host or registrable domain: the site and its sub-domains), or for every site when the grant says
 * `allSites` explicitly. Exactly one of the two is required: a missing or null `site` is never read as "every site".
 * The address rules still apply.
 */
export interface WebsiteGrantRequest {
  turnId: string;
  access: WebsiteGrantAccess;
  /** The one site the user allowed. */
  site?: string;
  /** The user explicitly allowed every site of the turn; excludes `site`. */
  allSites?: true;
}

export interface WebsiteGrant {
  turnId: string;
  access: WebsiteGrantAccess;
  /** The site the grant covers; null: every site of the turn. */
  site: string | null;
  grantedAt: number;
  expiresAt: number;
}

/** Most sites one request may name. */
export const MAX_ALLOWED_SITES = 50;

/** Whether an http(s) URL belongs to one of `sites` (registrable domains): the domain itself or any sub-domain. */
export function urlInAllowedSites(url: string, sites: readonly string[]): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;
  const host = parsed.hostname.toLowerCase().replace(/\.$/, "");
  return sites.some((site) => host === site || host.endsWith(`.${site}`));
}

export function isWebsiteGrant(value: unknown): value is WebsiteGrant {
  return (
    isRecord(value) &&
    typeof value.turnId === "string" &&
    WEBSITE_GRANT_ACCESS.some((access) => access === value.access) &&
    (value.site === null || typeof value.site === "string") &&
    typeof value.grantedAt === "number" &&
    typeof value.expiresAt === "number"
  );
}

// ── Parser ───────────────────────────────────────────────────────────────────

const text = (value: unknown, max: number): string =>
  typeof value === "string" ? value.slice(0, max) : "";

const optionalText = (value: unknown, max: number): string | null =>
  typeof value === "string" && value !== "" ? value.slice(0, max) : null;

const finite = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value : null;

const nonNegative = (value: unknown): number | null => {
  const number = finite(value);
  return number !== null && number >= 0 ? number : null;
};

const HEX = /^#[0-9a-f]{6}$/;

function hexOf(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const hex = value.trim().toLowerCase();
  return HEX.test(hex) ? hex : null;
}

function oneOf<T extends string>(allowed: readonly T[], value: unknown): T | null {
  return allowed.find((entry) => entry === value) ?? null;
}

function list(value: unknown, limit: number): unknown[] {
  return Array.isArray(value) ? value.slice(0, limit) : [];
}

function strings(value: unknown, limit: number, max: number): string[] {
  return list(value, limit * 2)
    .flatMap((entry) => (typeof entry === "string" && entry.trim() !== "" ? [entry.trim()] : []))
    .map((entry) => entry.slice(0, max))
    .slice(0, limit);
}

function numbers(value: unknown, limit: number): number[] {
  return list(value, limit).flatMap((entry) => {
    const number = nonNegative(entry);
    return number === null ? [] : [number];
  });
}

function httpUrl(value: unknown): string | null {
  if (typeof value !== "string" || value.length > WEBSITE_LIMITS.urlChars) return null;
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:" ? url.href : null;
  } catch {
    return null;
  }
}

function colorOf(raw: unknown): WebsiteColor | null {
  if (!isRecord(raw)) return null;
  const hex = hexOf(raw.hex);
  const role = oneOf(WEBSITE_COLOR_ROLES, raw.role);
  const count = nonNegative(raw.count);
  return hex && role && count !== null ? { hex, role, count } : null;
}

function fontOf(raw: unknown): WebsiteFont | null {
  if (!isRecord(raw)) return null;
  const family = text(raw.family, 120).trim();
  const source = oneOf(WEBSITE_FONT_SOURCES, raw.source);
  if (family === "" || !source) return null;
  return {
    family,
    weights: numbers(raw.weights, WEBSITE_LIMITS.weightsPerFont),
    source,
    url: httpUrl(raw.url),
    usedFor: list(raw.usedFor, WEBSITE_FONT_USES.length).flatMap((entry) => {
      const use = oneOf(WEBSITE_FONT_USES, entry);
      return use ? [use] : [];
    }),
  };
}

function textStyleOf(raw: unknown): WebsiteTextStyle | null {
  if (!isRecord(raw)) return null;
  const element = oneOf(WEBSITE_TEXT_ELEMENTS, raw.element);
  const fontSizePx = nonNegative(raw.fontSizePx);
  const fontWeight = nonNegative(raw.fontWeight);
  if (!element || fontSizePx === null || fontWeight === null) return null;
  return {
    element,
    sample: text(raw.sample, 80),
    fontFamily: text(raw.fontFamily, 160),
    fontSizePx,
    fontWeight,
    lineHeightPx: nonNegative(raw.lineHeightPx),
    letterSpacingPx: finite(raw.letterSpacingPx),
    color: hexOf(raw.color),
  };
}

function radiusOf(raw: unknown): WebsiteRadius | null {
  if (!isRecord(raw)) return null;
  const px = nonNegative(raw.px);
  const count = nonNegative(raw.count);
  return px !== null && count !== null ? { px, count } : null;
}

function buttonOf(raw: unknown): WebsiteButton | null {
  if (!isRecord(raw)) return null;
  const radiusPx = nonNegative(raw.radiusPx);
  const fontSizePx = nonNegative(raw.fontSizePx);
  const fontWeight = nonNegative(raw.fontWeight);
  if (radiusPx === null || fontSizePx === null || fontWeight === null) return null;
  return {
    label: text(raw.label, 60),
    background: hexOf(raw.background),
    color: hexOf(raw.color),
    border: optionalText(raw.border, 80),
    radiusPx,
    fontSizePx,
    fontWeight,
    padding: text(raw.padding, 60),
    shadow: optionalText(raw.shadow, WEBSITE_LIMITS.tokenValueChars),
  };
}

function tokenOf(raw: unknown): WebsiteToken | null {
  if (!isRecord(raw)) return null;
  const name = text(raw.name, 80);
  const value = text(raw.value, WEBSITE_LIMITS.tokenValueChars);
  return name.startsWith("--") && value !== "" ? { name, value } : null;
}

function resourceOf(raw: unknown): WebsiteResource | null {
  if (!isRecord(raw)) return null;
  const url = httpUrl(raw.url);
  const kind = oneOf(WEBSITE_RESOURCE_KINDS, raw.kind);
  if (!url || !kind) return null;
  return {
    url,
    kind,
    mimeType: optionalText(raw.mimeType, 120),
    bytes: nonNegative(raw.bytes),
    width: nonNegative(raw.width),
    height: nonNegative(raw.height),
    duration: nonNegative(raw.duration),
    usage: text(raw.usage, 160),
  };
}

function logoOf(raw: unknown): WebsiteLogo | null {
  if (!isRecord(raw)) return null;
  const source = oneOf(WEBSITE_LOGO_SOURCES, raw.source);
  const url = httpUrl(raw.url);
  if (!source || !url) return null;
  return {
    source,
    url,
    alt: text(raw.alt, 120),
    width: nonNegative(raw.width),
    height: nonNegative(raw.height),
    captured: raw.captured === true,
  };
}

function mapped<T>(value: unknown, limit: number, parse: (raw: unknown) => T | null): T[] {
  return list(value, limit * 2)
    .flatMap((entry) => {
      const parsed = parse(entry);
      return parsed === null ? [] : [parsed];
    })
    .slice(0, limit);
}

/**
 * A {@link WebsiteStyle} from untrusted JSON (the CLI child's output, a server answer): unusable entries are
 * dropped and every list is capped; null when the page identity (urls, host) is missing.
 */
export function parseWebsiteStyle(raw: unknown): WebsiteStyle | null {
  if (!isRecord(raw)) return null;
  const url = httpUrl(raw.url);
  const finalUrl = httpUrl(raw.finalUrl);
  const host = text(raw.host, 253).toLowerCase();
  const capturedAt = nonNegative(raw.capturedAt);
  if (!url || !finalUrl || host === "" || capturedAt === null) return null;
  const motion = isRecord(raw.motion) ? raw.motion : {};
  return {
    url,
    finalUrl,
    host,
    title: text(raw.title, WEBSITE_LIMITS.textChars),
    description: text(raw.description, WEBSITE_LIMITS.textChars),
    themeColor: hexOf(raw.themeColor),
    language: optionalText(raw.language, 20),
    colors: mapped(raw.colors, WEBSITE_LIMITS.colors, colorOf),
    fonts: mapped(raw.fonts, WEBSITE_LIMITS.fonts, fontOf),
    textStyles: mapped(raw.textStyles, WEBSITE_LIMITS.textStyles, textStyleOf),
    radii: mapped(raw.radii, WEBSITE_LIMITS.radii, radiusOf),
    shadows: strings(raw.shadows, WEBSITE_LIMITS.shadows, WEBSITE_LIMITS.tokenValueChars),
    buttons: mapped(raw.buttons, WEBSITE_LIMITS.buttons, buttonOf),
    tokens: mapped(raw.tokens, WEBSITE_LIMITS.tokens, tokenOf),
    motion: {
      durationsMs: numbers(motion.durationsMs, WEBSITE_LIMITS.durations),
      easings: strings(motion.easings, WEBSITE_LIMITS.easings, 100),
      keyframes: strings(motion.keyframes, WEBSITE_LIMITS.keyframes, 80),
      properties: strings(motion.properties, WEBSITE_LIMITS.properties, 40),
    },
    logos: mapped(raw.logos, WEBSITE_LIMITS.logos, logoOf),
    favicon: httpUrl(raw.favicon),
    ogImage: httpUrl(raw.ogImage),
    headings: strings(raw.headings, WEBSITE_LIMITS.headings, 160),
    navLabels: strings(raw.navLabels, WEBSITE_LIMITS.navLabels, 40),
    notes: strings(raw.notes, WEBSITE_LIMITS.notes, WEBSITE_LIMITS.textChars),
    resources: mapped(raw.resources, WEBSITE_LIMITS.resources, resourceOf),
    capturedAt,
  };
}

function screenshotOf(raw: unknown): WebsiteScreenshot | null {
  if (!isRecord(raw)) return null;
  const width = nonNegative(raw.width);
  const height = nonNegative(raw.height);
  if (
    typeof raw.name !== "string" ||
    typeof raw.mimeType !== "string" ||
    typeof raw.data !== "string" ||
    width === null ||
    height === null
  ) {
    return null;
  }
  return { name: raw.name, mimeType: raw.mimeType, data: raw.data, width, height };
}

export function isReadWebsiteResult(value: unknown): value is ReadWebsiteResult {
  return (
    isRecord(value) &&
    parseWebsiteStyle(value.site) !== null &&
    Array.isArray(value.screenshots) &&
    value.screenshots.every((entry) => screenshotOf(entry) !== null) &&
    (value.saved === undefined ||
      (isRecord(value.saved) &&
        typeof value.saved.dir === "string" &&
        Array.isArray(value.saved.files)))
  );
}

export function isWebsiteFileResult(value: unknown): value is WebsiteFileResult {
  return (
    isRecord(value) &&
    typeof value.url === "string" &&
    typeof value.finalUrl === "string" &&
    oneOf(WEBSITE_RESOURCE_KINDS, value.kind) !== null &&
    (value.mimeType === null || typeof value.mimeType === "string") &&
    nonNegative(value.bytes) !== null &&
    (value.text === undefined || typeof value.text === "string") &&
    (value.truncated === undefined || typeof value.truncated === "boolean") &&
    (value.path === undefined || typeof value.path === "string")
  );
}

export function isRecordWebsiteResult(value: unknown): value is RecordWebsiteResult {
  return (
    isRecord(value) &&
    typeof value.path === "string" &&
    typeof value.finalUrl === "string" &&
    nonNegative(value.width) !== null &&
    nonNegative(value.height) !== null &&
    nonNegative(value.duration) !== null &&
    nonNegative(value.bytes) !== null &&
    Array.isArray(value.notes) &&
    value.notes.every((note) => typeof note === "string")
  );
}
