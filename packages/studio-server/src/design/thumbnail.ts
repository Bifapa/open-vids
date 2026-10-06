import type { DesignManifestFont } from "@hyperframes/agent-protocol";

const COLOR =
  /^(?:#[0-9a-f]{3,8}|(?:rgb|rgba|hsl|hsla|hwb|lab|lch|oklab|oklch|color)\([0-9a-z.,%\s/+-]{1,120}\)|[a-z]{3,30})$/i;
const SWATCHES = ["--brand", "--accent", "--accent-2", "--fg", "--surface"];

function attr(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** A paint for an SVG attribute: the token when it is a plain colour, else a neutral stand-in (`var()` cannot resolve). */
function paint(tokens: Record<string, string>, name: string, fallback: string): string {
  const value = tokens[name]?.trim();
  return value && COLOR.test(value) && !/^(?:inherit|currentcolor|var)$/i.test(value)
    ? value
    : fallback;
}

/** The library card: palette swatches and the display font's name, as plain SVG (no script, no external reference). */
export function renderThumbnail(
  tokens: Record<string, string>,
  fonts: DesignManifestFont[],
): string {
  const display = fonts.find((font) => font.role === "display") ?? fonts[0];
  const name = display ? display.family : "";
  const swatches = SWATCHES.map(
    (token, index) =>
      `<rect x="${24 + index * 70}" y="150" width="62" height="46" rx="6" fill="${attr(
        paint(tokens, token, "#888888"),
      )}" stroke="${attr(paint(tokens, "--border", "#888888"))}" stroke-width="1"/>`,
  ).join("");
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 225" width="400" height="225" role="img"><rect width="400" height="225" fill="${attr(
    paint(tokens, "--bg", "#111111"),
  )}"/><rect x="24" y="36" width="56" height="6" rx="3" fill="${attr(
    paint(tokens, "--brand", "#888888"),
  )}"/><text x="24" y="104" font-family="system-ui, sans-serif" font-size="${
    name.length > 18 ? 30 : 42
  }" font-weight="700" fill="${attr(paint(tokens, "--fg", "#eeeeee"))}">${attr(
    name.slice(0, 40),
  )}</text>${swatches}</svg>
`;
}
