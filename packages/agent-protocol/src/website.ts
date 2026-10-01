/**
 * The website style reader: an agent reads a page the user linked in chat and gets the site's visual identity
 * (palette, fonts, logo, type scale, radii, buttons, motion character, screenshots) to build a motion composition in
 * that style.
 *
 * - The page is rendered in headless Chrome inside a CLI child process of the Studio server (never in the server
 *   itself); the server checks the global `websites.readLinkedPages` setting and the address rules (public http(s)
 *   hosts only) and answers {@link ReadWebsiteResult}.
 * - Which sites an agent may ask for (only the ones the user linked in the chat) is enforced by the agent runtime,
 *   which knows the messages; the server never sees them.
 * - `save` writes the screenshots, the logo and the self-hosted font files actually used into `assets/web/<host>/`,
 *   each with a provenance record (origin "website reference", license unknown) in the project's research ledger.
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
