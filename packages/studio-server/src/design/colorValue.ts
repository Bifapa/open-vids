/** CSS colour literals found in free text, normalised to `#rrggbb` / `#rrggbbaa` (lowercase). */

const NAMED_COLORS: Readonly<Record<string, string>> = {
  aqua: "#00ffff",
  beige: "#f5f5dc",
  black: "#000000",
  blue: "#0000ff",
  brown: "#a52a2a",
  coral: "#ff7f50",
  crimson: "#dc143c",
  cyan: "#00ffff",
  darkgray: "#a9a9a9",
  darkgrey: "#a9a9a9",
  dimgray: "#696969",
  dimgrey: "#696969",
  fuchsia: "#ff00ff",
  gold: "#ffd700",
  gray: "#808080",
  green: "#008000",
  grey: "#808080",
  indigo: "#4b0082",
  ivory: "#fffff0",
  khaki: "#f0e68c",
  lavender: "#e6e6fa",
  lightgray: "#d3d3d3",
  lightgrey: "#d3d3d3",
  lime: "#00ff00",
  magenta: "#ff00ff",
  maroon: "#800000",
  navy: "#000080",
  olive: "#808000",
  orange: "#ffa500",
  pink: "#ffc0cb",
  purple: "#800080",
  red: "#ff0000",
  salmon: "#fa8072",
  silver: "#c0c0c0",
  skyblue: "#87ceeb",
  slategray: "#708090",
  slategrey: "#708090",
  tan: "#d2b48c",
  teal: "#008080",
  tomato: "#ff6347",
  turquoise: "#40e0d0",
  violet: "#ee82ee",
  white: "#ffffff",
  whitesmoke: "#f5f5f5",
  yellow: "#ffff00",
};

function byte(value: number): string {
  return Math.max(0, Math.min(255, Math.round(value)))
    .toString(16)
    .padStart(2, "0");
}

/** `#rrggbb`, or `#rrggbbaa` when the alpha is not fully opaque; null for a fully transparent colour. */
export function colorHex(r: number, g: number, b: number, alpha = 1): string | null {
  const a = Math.max(0, Math.min(1, alpha));
  if (a === 0) return null;
  const rgb = `#${byte(r)}${byte(g)}${byte(b)}`;
  const alphaByte = Math.round(a * 255);
  return alphaByte === 255 ? rgb : `${rgb}${byte(alphaByte)}`;
}

function normaliseHex(raw: string): string | null {
  const hex = raw.slice(1).toLowerCase();
  const expanded =
    hex.length === 3 || hex.length === 4
      ? [...hex].map((digit) => digit + digit).join("")
      : hex.length === 6 || hex.length === 8
        ? hex
        : null;
  if (expanded === null) return null;
  const red = Number.parseInt(expanded.slice(0, 2), 16);
  const green = Number.parseInt(expanded.slice(2, 4), 16);
  const blue = Number.parseInt(expanded.slice(4, 6), 16);
  const alpha = expanded.length === 8 ? Number.parseInt(expanded.slice(6, 8), 16) / 255 : 1;
  return colorHex(red, green, blue, alpha);
}

function channel(token: string, scale: number): number {
  return token.endsWith("%") ? (Number.parseFloat(token) / 100) * scale : Number.parseFloat(token);
}

function alphaOf(token: string | undefined): number {
  if (token === undefined || token === "") return 1;
  return token.endsWith("%") ? Number.parseFloat(token) / 100 : Number.parseFloat(token);
}

function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  const hue = (((h % 360) + 360) % 360) / 360;
  const sat = Math.max(0, Math.min(1, s));
  const light = Math.max(0, Math.min(1, l));
  const q = light < 0.5 ? light * (1 + sat) : light + sat - light * sat;
  const p = 2 * light - q;
  const at = (offset: number) => {
    const t = (((hue + offset) % 1) + 1) % 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  return [at(1 / 3) * 255, at(0) * 255, at(-1 / 3) * 255];
}

function functional(name: string, args: string): string | null {
  const parts = args
    .replace(/[/,]/g, " ")
    .trim()
    .split(/\s+/)
    .filter((part) => part !== "");
  if (parts.length < 3 || parts.length > 4) return null;
  const [first, second, third, fourth] = parts as [string, string, string, string | undefined];
  const numbers = [first, second, third].map((token) => Number.parseFloat(token));
  if (numbers.some((n) => !Number.isFinite(n))) return null;
  const alpha = alphaOf(fourth);
  if (!Number.isFinite(alpha)) return null;
  if (name === "rgb" || name === "rgba") {
    return colorHex(channel(first, 255), channel(second, 255), channel(third, 255), alpha);
  }
  const [r, g, b] = hslToRgb(
    Number.parseFloat(first),
    Number.parseFloat(second) / 100,
    Number.parseFloat(third) / 100,
  );
  return colorHex(r, g, b, alpha);
}

const COLOR_TOKEN =
  /#(?:[0-9a-f]{8}|[0-9a-f]{6}|[0-9a-f]{4}|[0-9a-f]{3})(?![0-9a-z_-])|\b(rgba?|hsla?)\(\s*([^()]*)\)|(?<![\w#.-])([a-z]+)(?![\w(-])/gi;

/**
 * Every colour in a CSS value, in order. Hex (3/4/6/8 digits), `rgb()/rgba()/hsl()/hsla()` in comma and space syntax,
 * and — only when `named` — the small table of named colours. `transparent`, `inherit`, `currentColor`, fully
 * transparent colours and `url(…)` contents are not colours here.
 */
export function colorsIn(value: string, named: boolean): string[] {
  const text = value.replace(/url\([^)]*\)/gi, " ");
  const found: string[] = [];
  for (const match of text.matchAll(COLOR_TOKEN)) {
    const whole = match[0];
    let color: string | null = null;
    if (whole.startsWith("#")) color = normaliseHex(whole);
    else if (match[1] !== undefined && match[2] !== undefined) {
      color = functional(match[1].toLowerCase(), match[2]);
    } else if (named && match[3] !== undefined) {
      color = NAMED_COLORS[match[3].toLowerCase()] ?? null;
    }
    if (color !== null) found.push(color);
  }
  return found;
}
