import { WEBSITE_RESOURCE_KINDS, isRecord } from "@hyperframes/agent-protocol";
import type {
  RawButton,
  RawColor,
  RawFontUse,
  RawLogo,
  RawMotion,
  RawPage,
  RawResourceRef,
  RawTextStyle,
} from "./pageScript.js";

/**
 * What the in-page script returned, checked: the page is untrusted and runs its own scripts before ours, so nothing
 * it hands back is taken on trust. Entries that do not fit are dropped; a result without a page address is refused.
 */

const COLOR_ROLES = ["background", "surface", "text", "muted", "accent", "border"] as const;
const TEXT_ELEMENTS = ["h1", "h2", "h3", "body", "small"] as const;
const LOGO_SOURCES = ["inline_svg", "image", "og_image", "icon"] as const;

const text = (value: unknown, max = 400): string =>
  typeof value === "string" ? value.slice(0, max) : "";
const maybeText = (value: unknown, max = 400): string | null =>
  typeof value === "string" && value !== "" ? value.slice(0, max) : null;
const num = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value : null;

function rows<T>(value: unknown, limit: number, parse: (raw: unknown) => T | null): T[] {
  if (!Array.isArray(value)) return [];
  const out: T[] = [];
  for (const entry of value.slice(0, limit * 2)) {
    const parsed = parse(entry);
    if (parsed !== null) out.push(parsed);
    if (out.length >= limit) break;
  }
  return out;
}

const strings = (value: unknown, limit: number, max = 400): string[] =>
  rows(value, limit, (entry) =>
    typeof entry === "string" && entry !== "" ? entry.slice(0, max) : null,
  );

function colorOf(raw: unknown): RawColor | null {
  if (!isRecord(raw)) return null;
  const role = COLOR_ROLES.find((entry) => entry === raw.role);
  const count = num(raw.count);
  return role && count !== null && typeof raw.hex === "string"
    ? { hex: raw.hex, role, count }
    : null;
}

function fontOf(raw: unknown): RawFontUse | null {
  if (!isRecord(raw)) return null;
  const weight = num(raw.weight);
  const count = num(raw.count);
  const heading = num(raw.heading);
  const code = num(raw.code);
  if (weight === null || count === null || heading === null || code === null) return null;
  return {
    family: text(raw.family, 160),
    weight,
    italic: raw.italic === true,
    count,
    heading,
    code,
  };
}

function textStyleOf(raw: unknown): RawTextStyle | null {
  if (!isRecord(raw)) return null;
  const element = TEXT_ELEMENTS.find((entry) => entry === raw.element);
  const fontSizePx = num(raw.fontSizePx);
  const fontWeight = num(raw.fontWeight);
  if (!element || fontSizePx === null || fontWeight === null) return null;
  return {
    element,
    sample: text(raw.sample, 80),
    fontFamily: text(raw.fontFamily, 160),
    fontSizePx,
    fontWeight,
    lineHeightPx: num(raw.lineHeightPx),
    letterSpacingPx: num(raw.letterSpacingPx) ?? 0,
    color: maybeText(raw.color, 9),
  };
}

function buttonOf(raw: unknown): RawButton | null {
  if (!isRecord(raw)) return null;
  const radiusPx = num(raw.radiusPx);
  const fontSizePx = num(raw.fontSizePx);
  const fontWeight = num(raw.fontWeight);
  if (radiusPx === null || fontSizePx === null || fontWeight === null) return null;
  return {
    label: text(raw.label, 60),
    background: maybeText(raw.background, 9),
    color: maybeText(raw.color, 9),
    border: maybeText(raw.border, 80),
    radiusPx,
    fontSizePx,
    fontWeight,
    padding: text(raw.padding, 60),
    shadow: maybeText(raw.shadow, 200),
  };
}

function logoOf(raw: unknown): RawLogo | null {
  if (!isRecord(raw)) return null;
  const source = LOGO_SOURCES.find((entry) => entry === raw.source);
  if (!source) return null;
  const svg = typeof raw.svg === "string" && raw.svg.length <= 60_000 ? raw.svg : undefined;
  return {
    source,
    url: text(raw.url, 2048),
    alt: text(raw.alt, 120),
    width: num(raw.width),
    height: num(raw.height),
    ...(svg !== undefined && { svg }),
  };
}

function motionOf(raw: unknown): RawMotion {
  const value = isRecord(raw) ? raw : {};
  return {
    durationsMs: rows(value.durationsMs, 8, num),
    easings: strings(value.easings, 6, 100),
    properties: strings(value.properties, 8, 40),
    animationNames: strings(value.animationNames, 12, 80),
  };
}

export function parseRawPage(raw: unknown): RawPage | null {
  if (!isRecord(raw)) return null;
  const finalUrl = text(raw.finalUrl, 2048);
  try {
    const protocol = new URL(finalUrl).protocol;
    if (protocol !== "http:" && protocol !== "https:") return null;
  } catch {
    return null;
  }
  return {
    title: text(raw.title, 300),
    description: text(raw.description, 300),
    themeColor: maybeText(raw.themeColor, 9),
    language: maybeText(raw.language, 20),
    finalUrl,
    pageBackground: text(raw.pageBackground, 9),
    colors: rows(raw.colors, 24, colorOf),
    fonts: rows(raw.fonts, 200, fontOf),
    textStyles: rows(raw.textStyles, 8, textStyleOf),
    radii: rows(raw.radii, 6, (entry) => {
      if (!isRecord(entry)) return null;
      const px = num(entry.px);
      const count = num(entry.count);
      return px !== null && count !== null ? { px, count } : null;
    }),
    shadows: strings(raw.shadows, 4, 200),
    buttons: rows(raw.buttons, 6, buttonOf),
    logos: rows(raw.logos, 3, logoOf),
    icons: rows(raw.icons, 12, (entry) => {
      if (!isRecord(entry) || typeof entry.url !== "string") return null;
      return { url: entry.url.slice(0, 2048), size: num(entry.size) ?? 0, svg: entry.svg === true };
    }),
    ogImage: maybeText(raw.ogImage, 2048),
    headings: strings(raw.headings, 12, 160),
    navLabels: strings(raw.navLabels, 12, 40),
    motion: motionOf(raw.motion),
    googleFamilies: strings(raw.googleFamilies, 16, 80),
    inlineCss: strings(raw.inlineCss, 40, 400_000),
    stylesheetUrls: strings(raw.stylesheetUrls, 60, 2048),
    visibleElements: num(raw.visibleElements) ?? 0,
    textLength: num(raw.textLength) ?? 0,
    documentHeight: num(raw.documentHeight) ?? 0,
  };
}

function resourceOf(raw: unknown): RawResourceRef | null {
  if (!isRecord(raw)) return null;
  const url = maybeText(raw.url, 2048);
  if (url === null) return null;
  try {
    const protocol = new URL(url).protocol;
    if (protocol !== "http:" && protocol !== "https:") return null;
  } catch {
    return null;
  }
  const kind = WEBSITE_RESOURCE_KINDS.find((entry) => entry === raw.kind);
  if (!kind) return null;
  return {
    url,
    kind,
    width: num(raw.width),
    height: num(raw.height),
    duration: num(raw.duration),
    usage: text(raw.usage, 160),
  };
}

/** The DOM's file references from `RESOURCE_SCRIPT`, checked: unusable entries are dropped, the list is capped. */
export function parseRawResources(raw: unknown): RawResourceRef[] {
  return rows(raw, 400, resourceOf);
}

/** The `[name, value]` pairs of the token probe. */
export function parseTokenPairs(raw: unknown): Array<[string, string]> {
  return rows(raw, 160, (entry) => {
    if (!Array.isArray(entry) || typeof entry[0] !== "string" || typeof entry[1] !== "string") {
      return null;
    }
    const pair: [string, string] = [entry[0].slice(0, 80), entry[1].slice(0, 200)];
    return pair;
  });
}
