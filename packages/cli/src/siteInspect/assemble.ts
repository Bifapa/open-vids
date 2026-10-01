import {
  WEBSITE_LIMITS,
  parseWebsiteStyle,
  type WebsiteFont,
  type WebsiteFontUse,
  type WebsiteLogo,
  type WebsiteStyle,
} from "@hyperframes/agent-protocol";
import { topKeys, type CssFacts, type CssFontFace } from "./cssAnalysis.js";
import type { RawPage } from "./pageScript.js";

export interface CapturedFontFile {
  url: string;
  data: Uint8Array;
  mimeType: string;
}

/** A self-hosted font file the page loaded, chosen to be saved with the project. */
export interface PickedFontFile extends CapturedFontFile {
  family: string;
  weight: number;
  style: "normal" | "italic";
}

export interface AssembleInput {
  requestedUrl: string;
  raw: RawPage;
  css: CssFacts;
  /** Resolved values of the design-token custom properties (name → value). */
  tokenValues: ReadonlyArray<readonly [string, string]>;
  /** Font files the page loaded, by URL. */
  fontFiles: ReadonlyMap<string, CapturedFontFile>;
  logos: WebsiteLogo[];
  notes: string[];
  now: number;
}

const FILE_PRIORITY = ["woff2", "woff", "truetype", "opentype", "ttf", "otf"];

/** `__Inter_a1b2c3` (a font optimizer's renamed family) → `Inter`. */
export function displayFamily(family: string): string {
  const hashed = /^__(.+?)_[0-9a-f]{6,10}$/i.exec(family);
  return hashed?.[1] ? hashed[1].replace(/_/g, " ") : family;
}

const isFallbackFace = (family: string): boolean => /^__.+_fallback_[0-9a-f]+$/i.test(family);

export function fontMime(url: string, contentType: string | null): string {
  if (
    contentType &&
    /^(font|application)\/(woff2?|ttf|otf|font-woff2?|x-font-(woff2?|ttf|otf)|vnd\.ms-opentype|sfnt)/i.test(
      contentType,
    )
  ) {
    if (/woff2/i.test(contentType)) return "font/woff2";
    if (/woff/i.test(contentType)) return "font/woff";
    if (/otf|opentype/i.test(contentType)) return "font/otf";
    return "font/ttf";
  }
  const extension = /\.(woff2|woff|ttf|otf)(?:$|[?#])/i.exec(url)?.[1]?.toLowerCase();
  if (extension === "woff2") return "font/woff2";
  if (extension === "woff") return "font/woff";
  if (extension === "otf") return "font/otf";
  return "font/ttf";
}

function faceCovers(face: CssFontFace, weight: number, italic: boolean): boolean {
  return face.italic === italic && weight >= face.weightMin && weight <= face.weightMax;
}

function bestSource(
  face: CssFontFace,
  files: ReadonlyMap<string, CapturedFontFile>,
): string | null {
  const loaded = face.srcs.filter((src) => files.has(src.url));
  loaded.sort(
    (a, b) =>
      FILE_PRIORITY.indexOf(a.format ?? "woff2") - FILE_PRIORITY.indexOf(b.format ?? "woff2"),
  );
  return loaded[0]?.url ?? null;
}

interface FamilyUse {
  family: string;
  count: number;
  heading: number;
  code: number;
  weights: Map<number, { italic: boolean; count: number }[]>;
}

function groupFonts(raw: RawPage): FamilyUse[] {
  const byFamily = new Map<string, FamilyUse>();
  for (const use of raw.fonts) {
    if (use.family === "" || isFallbackFace(use.family)) continue;
    const entry = byFamily.get(use.family) ?? {
      family: use.family,
      count: 0,
      heading: 0,
      code: 0,
      weights: new Map(),
    };
    entry.count += use.count;
    entry.heading += use.heading;
    entry.code += use.code;
    const rows = entry.weights.get(use.weight) ?? [];
    rows.push({ italic: use.italic, count: use.count });
    entry.weights.set(use.weight, rows);
    byFamily.set(use.family, entry);
  }
  return [...byFamily.values()].sort((a, b) => b.count - a.count);
}

export function assembleStyle(input: AssembleInput): {
  site: WebsiteStyle;
  fontPicks: PickedFontFile[];
} {
  const { raw, css, fontFiles } = input;
  const googleSheet =
    raw.stylesheetUrls.find((href) =>
      /(^|\.)fonts\.googleapis\.com\//.test(href.replace(/^https?:\/\//, "")),
    ) ?? null;
  const googleNames = new Set(raw.googleFamilies.map((name) => name.toLowerCase()));
  const picks: PickedFontFile[] = [];
  const pickedUrls = new Set<string>();

  const fonts: WebsiteFont[] = groupFonts(raw)
    .slice(0, WEBSITE_LIMITS.fonts)
    .map((usage): WebsiteFont => {
      const name = displayFamily(usage.family);
      const weights = [...usage.weights.entries()]
        .sort(
          (a, b) => b[1].reduce((n, r) => n + r.count, 0) - a[1].reduce((n, r) => n + r.count, 0),
        )
        .slice(0, WEBSITE_LIMITS.weightsPerFont)
        .map(([weight]) => weight)
        .sort((a, b) => a - b);
      const usedFor: WebsiteFontUse[] = [];
      if (usage.heading > 0 && usage.heading >= usage.count * 0.15) usedFor.push("heading");
      if (usage.count - usage.heading - usage.code > 0) usedFor.push("body");
      if (usage.code > 0) usedFor.push("code");
      const faces = css.fontFaces.filter(
        (face) => face.family.toLowerCase() === usage.family.toLowerCase(),
      );

      if (googleNames.has(name.toLowerCase())) {
        return { family: name, weights, source: "google", url: googleSheet, usedFor };
      }
      if (faces.length > 0) {
        const allGoogle = faces.every((face) =>
          face.srcs.every((src) => /^https?:\/\/fonts\.gstatic\.com\//.test(src.url)),
        );
        if (allGoogle) {
          const sheet = `https://fonts.googleapis.com/css2?family=${encodeURIComponent(name).replace(/%20/g, "+")}`;
          return { family: name, weights, source: "google", url: sheet, usedFor };
        }
        // Self-hosted: save the loaded file of each weight/style in use (one per weight, the latin subset first).
        let firstUrl: string | null = null;
        for (const [weight, rows] of usage.weights) {
          for (const italic of new Set(rows.map((row) => row.italic))) {
            const candidates = faces
              .filter((face) => faceCovers(face, weight, italic))
              .flatMap((face) => {
                const url = bestSource(face, fontFiles);
                return url ? [{ face, url }] : [];
              });
            const latin = candidates.find(({ face }) => /U\+0000/i.test(face.unicodeRange ?? ""));
            const chosen =
              latin ??
              candidates.sort(
                (a, b) =>
                  (fontFiles.get(b.url)?.data.byteLength ?? 0) -
                  (fontFiles.get(a.url)?.data.byteLength ?? 0),
              )[0];
            if (!chosen) continue;
            firstUrl ??= chosen.url;
            const file = fontFiles.get(chosen.url);
            if (!file || pickedUrls.has(chosen.url) || picks.length >= WEBSITE_LIMITS.savedFonts)
              continue;
            pickedUrls.add(chosen.url);
            picks.push({ ...file, family: name, weight, style: italic ? "italic" : "normal" });
          }
        }
        const declared = faces.flatMap((face) => face.srcs.map((src) => src.url))[0] ?? null;
        return { family: name, weights, source: "self_hosted", url: firstUrl ?? declared, usedFor };
      }
      return { family: name, weights, source: "system", url: null, usedFor };
    });

  const durations = [...new Set([...raw.motion.durationsMs, ...topKeys(css.durations, 8)])].slice(
    0,
    WEBSITE_LIMITS.durations,
  );
  const easings = [...new Set([...raw.motion.easings, ...topKeys(css.easings, 6)])].slice(
    0,
    WEBSITE_LIMITS.easings,
  );
  const properties = [...new Set([...raw.motion.properties, ...topKeys(css.properties, 8)])].slice(
    0,
    WEBSITE_LIMITS.properties,
  );
  const keyframes = [...new Set([...raw.motion.animationNames, ...css.keyframes])].slice(
    0,
    WEBSITE_LIMITS.keyframes,
  );

  const finalUrl = raw.finalUrl;
  const host = new URL(finalUrl).hostname.toLowerCase().replace(/^www\./, "");
  const icon = [...raw.icons].sort((a, b) => Number(b.svg) - Number(a.svg) || b.size - a.size)[0];

  const candidate = {
    url: input.requestedUrl,
    finalUrl,
    host,
    title: raw.title,
    description: raw.description,
    themeColor: raw.themeColor,
    language: raw.language,
    colors: raw.colors,
    fonts,
    textStyles: raw.textStyles.map((style) => ({
      ...style,
      fontFamily: displayFamily(style.fontFamily),
    })),
    radii: raw.radii,
    shadows: raw.shadows,
    buttons: raw.buttons,
    tokens: input.tokenValues
      .filter(([, value]) => value !== "")
      .map(([name, value]) => ({ name, value })),
    motion: { durationsMs: durations, easings, keyframes, properties },
    logos: input.logos,
    favicon: icon?.url ?? null,
    ogImage: raw.ogImage,
    headings: raw.headings,
    navLabels: raw.navLabels,
    notes: input.notes,
    capturedAt: input.now,
  };
  const site = parseWebsiteStyle(candidate);
  if (!site) throw new Error("The page's style could not be assembled (no usable address)");
  return { site, fontPicks: picks };
}
