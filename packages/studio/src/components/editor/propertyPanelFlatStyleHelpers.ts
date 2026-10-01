import { formatPercent, t } from "../../i18n";

/** The collapsed Style group's line: the fill state, then the opacity. */
export function flatStyleSummary(styles: Record<string, string>): string {
  const opacity = parseFloat(styles.opacity ?? "1");
  const fill =
    styles["background-image"] && styles["background-image"] !== "none"
      ? "image"
      : styles["background-color"]
        ? "set"
        : "none";
  return t("inspector.group.styleSummary", {
    fill,
    opacity: formatPercent(Math.round((Number.isFinite(opacity) ? opacity : 1) * 100) / 100),
  });
}

// Mirrors legacy `propertyPanelStyleSections.tsx`'s `SelectField` "Style" options —
// the single source of truth for which border-style tokens are valid.
export const STROKE_STYLE_OPTIONS: string[] = [
  "none",
  "solid",
  "dashed",
  "dotted",
  "double",
  "hidden",
  "groove",
  "ridge",
  "inset",
  "outset",
];
