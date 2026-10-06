import { isSafeDesignTokenValue, type DesignLicenseFacts } from "@hyperframes/agent-protocol";
import { t } from "../i18n";

/** The tokens a swatch row shows, in order; the library's own summary uses the same five. */
const PALETTE_TOKENS = ["--bg", "--fg", "--brand", "--accent", "--accent-2"] as const;

/** What the popover shows about the attached snapshot, read from the project's own `design/tokens.css`. */
export interface SnapshotFacts {
  palette: string[];
  displayFont: string | null;
}

/** A colour that is safe to paint as a swatch; anything with a declaration or block break is not drawn. */
export function swatchColors(values: readonly string[]): string[] {
  const colors: string[] = [];
  for (const value of values) {
    const color = value.trim();
    if (isSafeDesignTokenValue(color) && !color.includes("var(") && !colors.includes(color)) {
      colors.push(color);
    }
  }
  return colors;
}

/** The `--name: value;` declarations of a stylesheet; the last declaration of a name wins. */
function readCustomProperties(css: string): Map<string, string> {
  const properties = new Map<string, string>();
  for (const match of css.matchAll(/(--[a-z][a-z0-9-]*)\s*:\s*([^;{}]+);/g)) {
    properties.set(match[1], match[2].trim());
  }
  return properties;
}

/** The first family of a font stack (`"Inter", system-ui` → `Inter`); null for an empty or variable-driven value. */
function firstFontFamily(stack: string): string | null {
  if (stack.includes("var(")) return null;
  const first =
    stack
      .split(",")[0]
      ?.trim()
      .replace(/^["']|["']$/g, "") ?? "";
  return first.length > 0 ? first : null;
}

/** The snapshot's swatches and display font, from the text of its `tokens.css`. */
export function snapshotFacts(css: string): SnapshotFacts {
  const properties = readCustomProperties(css);
  const palette = swatchColors(PALETTE_TOKENS.map((token) => properties.get(token) ?? ""));
  const display = properties.get("--font-display");
  return { palette, displayFont: display === undefined ? null : firstFontFamily(display) };
}

/** One honest note about a system: a licence nobody recorded, or a font that is not stored with it. */
export interface DesignChip {
  id: string;
  label: string;
}

/** `unknownLicenses` entries are `font:<Family>` or `logo`. */
function unknownLicenseLabel(name: string): string {
  if (name === "logo") return t("studio.design.chip.logoLicense");
  if (name.startsWith("font:")) {
    return t("studio.design.chip.fontLicense", { family: name.slice("font:".length) });
  }
  return t("studio.design.chip.otherLicense", { name });
}

/**
 * The warnings of a system as chips: unknown licences (checked before export) and fonts that are not portable. A font
 * used for two roles is listed once.
 */
export function designChips(facts: DesignLicenseFacts): DesignChip[] {
  return [
    ...[...new Set(facts.unknownLicenses)].map((name) => ({
      id: `license:${name}`,
      label: unknownLicenseLabel(name),
    })),
    ...[...new Set(facts.nonPortableFonts)].map((family) => ({
      id: `system-font:${family}`,
      label: t("studio.design.chip.nonPortable", { family }),
    })),
  ];
}
