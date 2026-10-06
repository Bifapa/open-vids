import {
  DESIGN_LIMITS,
  DESIGN_REQUIRED_TOKENS,
  isSafeDesignTokenValue,
  type DesignFontRole,
  type DesignFontSpec,
  type DesignLogoSpec,
  type DesignTransition,
  type DesignTransitionKind,
  type SavedWebsiteFiles,
  type WebsiteColor,
  type WebsiteColorRole,
  type WebsiteFont,
  type WebsiteStyle,
} from "@hyperframes/agent-protocol";

/**
 * A design system spec drafted from a website's style by fixed rules: every hex is the site's, every font the site's
 * family with its real source, every duration and easing the site's CSS. The model refines it (names the colors, tunes
 * the roles, writes the rules) but starts from exact values. Same style in, same draft out.
 */
export interface DesignSpecDraft {
  /** Required tokens the site gave a value for, plus the generic defaults listed in `defaultedTokens`. */
  tokens: Record<string, string>;
  fonts: DesignFontSpec[];
  transitions: DesignTransition[];
  motionRules: string[];
  logo: DesignLogoSpec | null;
  summary: string;
  /** Required tokens the site did not reveal (a color role it never used): the model must choose, from the site's palette. */
  missingTokens: string[];
  /** Tokens filled with a generic default because the site said nothing about them (spacing, an easing). */
  defaultedTokens: string[];
  /** What the mapping decided that the model should know (a font not saved, a duplicated accent). */
  notes: string[];
}

const DEFAULT_EASING_STANDARD = "cubic-bezier(0.4, 0, 0.2, 1)";
const DEFAULT_EASING_EMPHASIS = "cubic-bezier(0.2, 0.8, 0.2, 1)";
const DEFAULT_BEAT = "0.4s";
const DEFAULT_RADIUS = "8px";
const DEFAULT_SPACES = ["8px", "16px", "32px"] as const;
const DEFAULT_SANS = "system-ui, sans-serif";
const DEFAULT_MONO = "ui-monospace, monospace";
const BEAT_MIN_MS = 150;
const BEAT_MAX_MS = 1_200;
const BEAT_TARGET_MS = 400;
const TRANSITION_COUNT = 3;
const LOGO_EXTENSIONS = /\.(png|jpe?g|svg|webp)$/i;

/** The site's colors of one role, most used first (ties by hex, so the order never depends on the input order). */
function colorsOf(colors: readonly WebsiteColor[], role: WebsiteColorRole): string[] {
  return colors
    .filter((color) => color.role === role)
    .sort((a, b) => b.count - a.count || a.hex.localeCompare(b.hex))
    .map((color) => color.hex);
}

function roundTo(value: number, digits: number): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function fontRoleOf(font: WebsiteFont): DesignFontRole {
  if (font.usedFor.includes("heading")) return "display";
  if (font.usedFor.includes("body")) return "body";
  if (font.usedFor.includes("code")) return "mono";
  return "other";
}

function weightsOf(font: WebsiteFont): number[] {
  const weights = [
    ...new Set(
      font.weights.filter((weight) => Number.isInteger(weight) && weight >= 100 && weight <= 900),
    ),
  ].sort((a, b) => a - b);
  return weights.length > 0 ? weights.slice(0, 9) : [400];
}

/** The saved face of a self-hosted family closest to regular weight, if the read saved any. */
function savedFace(family: string, saved: SavedWebsiteFiles | null | undefined) {
  const faces = (saved?.fonts ?? []).filter(
    (face) => face.family.toLowerCase() === family.toLowerCase(),
  );
  const normal = faces.filter((face) => face.style === "normal");
  const pool = normal.length > 0 ? normal : faces;
  return pool.sort((a, b) => Math.abs(a.weight - 400) - Math.abs(b.weight - 400))[0] ?? null;
}

interface FontDraft {
  fonts: DesignFontSpec[];
  notes: string[];
}

function draftFonts(style: WebsiteStyle, saved: SavedWebsiteFiles | null | undefined): FontDraft {
  const fonts: DesignFontSpec[] = [];
  const notes: string[] = [];
  const taken = new Set<DesignFontRole>();
  for (const font of style.fonts) {
    if (fonts.length >= DESIGN_LIMITS.fonts) break;
    if (/["'\\;{}<>]/.test(font.family) || font.family.trim().length === 0) continue;
    const wanted = fontRoleOf(font);
    // One display, one body and one mono font: a second family of the same role is "other".
    const role = wanted !== "other" && taken.has(wanted) ? "other" : wanted;
    taken.add(role);
    if (font.source === "google") {
      fonts.push({
        family: font.family,
        role,
        source: "google",
        weights: weightsOf(font),
        license: null,
      });
    } else if (font.source === "self_hosted") {
      const face = savedFace(font.family, saved);
      if (face) {
        fonts.push({
          family: font.family,
          role,
          source: "file",
          weights: [face.weight],
          ...(face.style === "italic" && { italic: true }),
          projectPath: face.path,
          license: null,
        });
        notes.push(
          `${font.family} is self-hosted by the site: the saved file ${face.path} is used (license unknown unless the site states one; only that face is kept).`,
        );
      } else {
        fonts.push({
          family: font.family,
          role,
          source: "system",
          weights: weightsOf(font),
          license: null,
        });
        notes.push(
          `${font.family} is self-hosted by the site and was NOT saved: it is listed as a system font (not portable). Read the site again with save: true to keep the file, or replace it with the closest Google Fonts family and mark it guess: true.`,
        );
      }
    } else {
      fonts.push({
        family: font.family,
        role,
        source: "system",
        weights: weightsOf(font),
        license: null,
      });
    }
  }
  return { fonts, notes };
}

function fontStack(family: string, generic: string): string {
  return `"${family}", ${generic}`;
}

function logoOf(saved: SavedWebsiteFiles | null | undefined): DesignLogoSpec | null {
  return saved?.logo && LOGO_EXTENSIONS.test(saved.logo)
    ? { projectPath: saved.logo, license: null }
    : null;
}

/** The duration (ms) the site uses for a typical beat: the one nearest 400 ms within a sane range. */
function beatOf(durationsMs: readonly number[]): number | null {
  const sane = durationsMs.filter((ms) => ms >= BEAT_MIN_MS && ms <= BEAT_MAX_MS);
  return (
    [...sane].sort(
      (a, b) => Math.abs(a - BEAT_TARGET_MS) - Math.abs(b - BEAT_TARGET_MS) || a - b,
    )[0] ?? null
  );
}

const seconds = (ms: number): string => `${roundTo(ms / 1000, 3)}s`;

function kindsOf(properties: readonly string[]): DesignTransitionKind[] {
  const kinds: DesignTransitionKind[] = [];
  for (const property of properties) {
    const kind: DesignTransitionKind =
      property === "clip-path"
        ? "wipe"
        : property === "filter" || property === "backdrop-filter"
          ? "blur"
          : property === "transform"
            ? "slide"
            : property === "opacity"
              ? "fade"
              : "custom";
    if (!kinds.includes(kind)) kinds.push(kind);
  }
  return kinds;
}

const capitalise = (word: string): string => `${word.slice(0, 1).toUpperCase()}${word.slice(1)}`;

export function websiteStyleToSpecDraft(
  style: WebsiteStyle,
  saved?: SavedWebsiteFiles | null,
): DesignSpecDraft {
  const tokens: Record<string, string> = {};
  const defaulted: string[] = [];
  const notes: string[] = [];
  const setDefault = (name: string, value: string) => {
    tokens[name] = value;
    defaulted.push(name);
  };

  // Colors: each role of the site maps to its token; a role the site never used falls back inside the site's palette.
  const background = colorsOf(style.colors, "background");
  const surfaces = colorsOf(style.colors, "surface");
  const text = colorsOf(style.colors, "text");
  const muted = colorsOf(style.colors, "muted");
  const border = colorsOf(style.colors, "border");
  const accents = colorsOf(style.colors, "accent");
  const other = colorsOf(style.colors, "other");
  const bg = background[0] ?? surfaces[0];
  const surface = [...surfaces, ...background.slice(1)].find((hex) => hex !== bg);
  const brand = accents[0] ?? style.themeColor ?? other[0];
  const colorTokens: [string, string | undefined][] = [
    ["--bg", bg],
    ["--fg", text[0]],
    ["--muted", muted[0] ?? text[1]],
    ["--surface", surface],
    ["--border", border[0]],
    ["--brand", brand],
    ["--accent", accents[1] ?? brand],
    ["--accent-2", accents[2] ?? accents[1] ?? brand],
  ];
  for (const [name, value] of colorTokens) if (value) tokens[name] = value;
  if (accents.length < 3)
    notes.push(
      `The site has ${accents.length} accent ${accents.length === 1 ? "color" : "colors"}: --accent and --accent-2 reuse the nearest one; change them only with a color from the site's palette.`,
    );

  // Fonts.
  const { fonts, notes: fontNotes } = draftFonts(style, saved);
  notes.push(...fontNotes);
  const roleFont = (role: DesignFontRole) => fonts.find((font) => font.role === role);
  const display = roleFont("display") ?? roleFont("body") ?? fonts[0];
  const body = roleFont("body") ?? roleFont("display") ?? fonts[0];
  const mono = roleFont("mono");
  if (display) tokens["--font-display"] = fontStack(display.family, "sans-serif");
  else setDefault("--font-display", DEFAULT_SANS);
  if (body) tokens["--font-body"] = fontStack(body.family, "sans-serif");
  else setDefault("--font-body", DEFAULT_SANS);
  if (mono) tokens["--font-mono"] = fontStack(mono.family, "monospace");
  else setDefault("--font-mono", DEFAULT_MONO);

  // Shape and spacing.
  const radius = style.radii[0];
  if (radius) tokens["--radius"] = `${roundTo(radius.px, 1)}px`;
  else setDefault("--radius", DEFAULT_RADIUS);
  DESIGN_REQUIRED_TOKENS.filter((name) => /^--space-\d$/.test(name)).forEach((name, index) => {
    setDefault(name, DEFAULT_SPACES[index] ?? DEFAULT_SPACES[0]);
  });

  // Type scale: the site's sizes in px, by element.
  const sizeTokens: Record<string, string> = {
    h1: "--text-4xl",
    h2: "--text-2xl",
    h3: "--text-xl",
    body: "--text-base",
    small: "--text-sm",
  };
  for (const entry of style.textStyles) {
    const name = sizeTokens[entry.element];
    if (name && !(name in tokens) && entry.fontSizePx > 0)
      tokens[name] = `${roundTo(entry.fontSizePx, 1)}px`;
    const leading =
      entry.lineHeightPx !== null && entry.fontSizePx > 0
        ? roundTo(entry.lineHeightPx / entry.fontSizePx, 2)
        : null;
    if (leading !== null && entry.element === "body" && !("--leading-normal" in tokens))
      tokens["--leading-normal"] = `${leading}`;
    if (leading !== null && entry.element === "h1" && !("--leading-tight" in tokens))
      tokens["--leading-tight"] = `${leading}`;
  }
  const shadows = style.shadows.filter((shadow) => isSafeDesignTokenValue(shadow));
  (["--shadow-sm", "--shadow-md", "--shadow-lg"] as const).forEach((name, index) => {
    const shadow = shadows[index];
    if (shadow) tokens[name] = shadow;
  });

  // Motion.
  const durations = [
    ...new Set(style.motion.durationsMs.filter((ms) => ms > 0 && ms <= 10_000)),
  ].sort((a, b) => a - b);
  const easings = [
    ...new Set(
      style.motion.easings.filter((ease) => ease !== "linear" && isSafeDesignTokenValue(ease)),
    ),
  ];
  const beat = beatOf(durations);
  if (beat !== null) tokens["--dur-beat"] = seconds(beat);
  else setDefault("--dur-beat", DEFAULT_BEAT);
  const shortest = durations[0];
  const longest = durations.at(-1);
  if (shortest !== undefined && beat !== null && shortest < beat)
    tokens["--dur-fast"] = seconds(shortest);
  if (longest !== undefined && beat !== null && longest > beat)
    tokens["--dur-slow"] = seconds(longest);
  const [standard, emphasis] = easings;
  if (standard) tokens["--ease-standard"] = standard;
  else setDefault("--ease-standard", DEFAULT_EASING_STANDARD);
  if (emphasis) tokens["--ease-emphasis"] = emphasis;
  else setDefault("--ease-emphasis", DEFAULT_EASING_EMPHASIS);

  const kinds = kindsOf(style.motion.properties);
  const transitions: DesignTransition[] = [];
  const count =
    durations.length === 0 ? 0 : Math.min(TRANSITION_COUNT, Math.max(1, easings.length));
  for (let index = 0; index < count; index += 1) {
    const kind = kinds[index % Math.max(1, kinds.length)] ?? "custom";
    const duration = durations[index % durations.length] ?? 400;
    transitions.push({
      name: `${capitalise(kind)} ${index + 1}`,
      kind,
      durationSec: roundTo(duration / 1000, 3),
      ease: easings[index] ?? standard ?? DEFAULT_EASING_STANDARD,
      note: "Taken from the site's CSS transitions; the kind is inferred from the properties it animates.",
    });
  }
  const motionRules: string[] = [];
  if (durations.length > 0)
    motionRules.push(
      `The site's own motion runs ${shortest}–${longest} ms${easings.length > 0 ? ` with ${easings.slice(0, 3).join(", ")}` : ""}.`,
    );

  const missingTokens = DESIGN_REQUIRED_TOKENS.filter((name) => !(name in tokens));
  const description = style.description.trim();
  const summary = `Style read from ${style.host}${style.title ? ` (“${style.title.replace(/[<>]/g, "")}”)` : ""}${description ? `: ${description.replace(/[<>]/g, "")}` : "."}`;
  return {
    tokens,
    fonts,
    transitions,
    motionRules,
    logo: logoOf(saved),
    summary: summary.slice(0, DESIGN_LIMITS.noteChars),
    missingTokens: [...missingTokens],
    defaultedTokens: defaulted,
    notes,
  };
}

/** The draft as the model reads it: the starting spec as JSON plus what is missing, defaulted and decided. */
export function formatSpecDraft(draft: DesignSpecDraft): string {
  const spec = {
    tokens: draft.tokens,
    fonts: draft.fonts,
    transitions: draft.transitions,
    motionRules: draft.motionRules,
    ...(draft.logo && { logo: draft.logo }),
    summary: draft.summary,
  };
  const lines = [
    "Design system draft from this site (mapped by fixed rules; every color, font family, duration and easing is the site's own — keep them exact and only refine: name the colors with colorNames, add dos/donts and motion rules, fix roles).",
    JSON.stringify(spec),
  ];
  if (draft.missingTokens.length > 0)
    lines.push(
      `Required tokens the site did not reveal — choose each from the site's palette above: ${draft.missingTokens.join(", ")}.`,
    );
  if (draft.defaultedTokens.length > 0)
    lines.push(
      `Tokens filled with a generic default (the site said nothing about them; change them if the brief says otherwise): ${draft.defaultedTokens.join(", ")}.`,
    );
  for (const note of draft.notes) lines.push(`Note: ${note}`);
  return lines.join("\n");
}
