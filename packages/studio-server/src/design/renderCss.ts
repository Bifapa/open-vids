import {
  DESIGN_EXTENDED_TOKENS,
  DESIGN_REQUIRED_TOKENS,
  DESIGN_TOKEN_NAME,
  isSafeDesignTokenValue,
  type DesignFontFile,
  type DesignManifestFont,
  type DesignTransition,
} from "@hyperframes/agent-protocol";
import { DesignFailure } from "./errors.js";

/** A value placed inside a CSS string: the characters that could end it or the block are dropped. */
export function cssString(value: string): string {
  return value.replace(/["'\\;{}<>\p{Cc}]/gu, "");
}

/** The tokens in file order: the contract's, then the extended ones, then the system's own. */
export function orderedTokens(tokens: Record<string, string>): [string, string][] {
  const known: string[] = [...DESIGN_REQUIRED_TOKENS, ...DESIGN_EXTENDED_TOKENS];
  const names = Object.keys(tokens);
  const ordered = [
    ...known.filter((name) => names.includes(name)),
    ...names.filter((name) => !known.includes(name)),
  ];
  return ordered.map((name) => {
    const value = tokens[name] ?? "";
    if (!DESIGN_TOKEN_NAME.test(name) || !isSafeDesignTokenValue(value))
      throw new DesignFailure("invalid_system", `Token ${name} is not a safe CSS custom property`);
    return [name, value.trim()];
  });
}

export function rootBlock(tokens: Record<string, string>): string {
  const lines = orderedTokens(tokens).map(([name, value]) => `  ${name}: ${value};`);
  return `:root {\n${lines.join("\n")}\n}`;
}

const FORMAT_BY_EXTENSION: Record<string, string> = {
  woff2: "woff2",
  woff: "woff",
  otf: "opentype",
  ttf: "truetype",
};

function faceCss(family: string, file: DesignFontFile): string {
  const format = FORMAT_BY_EXTENSION[file.path.split(".").pop() ?? ""] ?? "truetype";
  const lines = [
    `  font-family: "${cssString(family)}";`,
    `  font-style: ${file.style};`,
    `  font-weight: ${file.weight};`,
    "  font-display: swap;",
    `  src: url("${file.path}") format("${format}");`,
  ];
  if (file.unicodeRange && /^[Uu+0-9A-Fa-f?, -]+$/.test(file.unicodeRange))
    lines.push(`  unicode-range: ${file.unicodeRange};`);
  return `@font-face {\n${lines.join("\n")}\n}`;
}

/** One `@font-face` per stored file, with the relative `fonts/…` URL; system fonts have none. */
export function fontFaceCss(fonts: DesignManifestFont[]): string {
  const seen: string[] = [];
  const faces: string[] = [];
  for (const font of fonts) {
    for (const file of font.files) {
      const css = faceCss(font.family, file);
      if (seen.includes(css)) continue;
      seen.push(css);
      faces.push(css);
    }
  }
  return faces.join("\n");
}

export function tokensCssFile(
  tokens: Record<string, string>,
  fonts: DesignManifestFont[],
  version: number,
): string {
  const faces = fontFaceCss(fonts);
  return [
    `/* OpenVids design system, version ${version}: generated. Link it from a composition's head; to change it, save a new version. */`,
    rootBlock(tokens),
    ...(faces ? [faces] : []),
    "",
  ].join("\n\n");
}

const GSAP_CURVES: Record<string, [string, string, string]> = {
  sine: ["0.12, 0, 0.39, 0", "0.61, 1, 0.88, 1", "0.37, 0, 0.63, 1"],
  power1: ["0.11, 0, 0.5, 0", "0.5, 1, 0.89, 1", "0.45, 0, 0.55, 1"],
  power2: ["0.32, 0, 0.67, 0", "0.33, 1, 0.68, 1", "0.65, 0, 0.35, 1"],
  power3: ["0.5, 0, 0.75, 0", "0.25, 1, 0.5, 1", "0.76, 0, 0.24, 1"],
  power4: ["0.64, 0, 0.78, 0", "0.22, 1, 0.36, 1", "0.83, 0, 0.17, 1"],
  expo: ["0.7, 0, 0.84, 0", "0.16, 1, 0.3, 1", "0.87, 0, 0.13, 1"],
  circ: ["0.55, 0, 1, 0.45", "0, 0.55, 0.45, 1", "0.85, 0, 0.15, 1"],
  back: ["0.36, 0, 0.66, -0.56", "0.34, 1.56, 0.64, 1", "0.68, -0.6, 0.32, 1.6"],
};
const CSS_KEYWORDS = new Set(["linear", "ease", "ease-in", "ease-out", "ease-in-out"]);
const NUMBER = String.raw`-?\d{1,3}(?:\.\d{1,4})?`;
const CUBIC = new RegExp(
  String.raw`^cubic-bezier\(\s*${NUMBER}\s*,\s*${NUMBER}\s*,\s*${NUMBER}\s*,\s*${NUMBER}\s*\)$`,
);
const STEPS =
  /^steps\(\s*\d{1,3}\s*(?:,\s*(?:start|end|jump-start|jump-end|jump-none|jump-both))?\s*\)$/;

/** A CSS timing function for an ease written as one (kept) or as a GSAP name (`power2.out`, approximated). */
export function cssTimingFunction(ease: string): string {
  const value = ease.trim();
  if (CSS_KEYWORDS.has(value) || CUBIC.test(value) || STEPS.test(value)) return value;
  const gsap = /^(sine|power[1-4]|expo|circ|back)\.(in|out|inOut)$/.exec(value);
  const curve = gsap && GSAP_CURVES[gsap[1] ?? ""];
  if (gsap && curve) {
    const index = gsap[2] === "in" ? 0 : gsap[2] === "out" ? 1 : 2;
    return `cubic-bezier(${curve[index]})`;
  }
  return value === "none" ? "linear" : "ease";
}

const HOLD_SEC = 1.4;

const FROM_TO: Record<DesignTransition["kind"], [string, string]> = {
  cut: ["opacity: 0", "opacity: 1"],
  fade: ["opacity: 0", "opacity: 1"],
  slide: ["opacity: 0; transform: translateX(-45%)", "opacity: 1; transform: none"],
  push: ["transform: translateX(105%)", "transform: none"],
  wipe: ["clip-path: inset(0 100% 0 0)", "clip-path: inset(0 0 0 0)"],
  zoom: ["opacity: 0; transform: scale(0.55)", "opacity: 1; transform: none"],
  blur: ["opacity: 0; filter: blur(18px)", "opacity: 1; filter: blur(0)"],
  custom: ["opacity: 0; transform: translateY(30%) scale(0.9)", "opacity: 1; transform: none"],
};

/** One transition's looping sample: it plays over exactly `durationSec` with its ease, then holds. */
function transitionCss(transition: DesignTransition, index: number): string {
  const cycle = Math.max(transition.durationSec, 0) + HOLD_SEC;
  const end = Math.max(+((Math.max(transition.durationSec, 0) / cycle) * 100).toFixed(3), 0.01);
  const [from, to] = FROM_TO[transition.kind];
  const ease = transition.kind === "cut" ? "steps(1, end)" : cssTimingFunction(transition.ease);
  return [
    `@keyframes ov-k${index} {`,
    `  0% { ${from}; animation-timing-function: ${ease}; }`,
    `  ${end}% { ${to}; }`,
    `  100% { ${to}; }`,
    "}",
    `.ov-anim-${index} { animation: ov-k${index} ${+cycle.toFixed(3)}s linear infinite; }`,
  ].join("\n");
}

const BASE_CSS = `*, *::before, *::after { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--fg); font-family: var(--font-body); line-height: var(--leading-normal, 1.5); }
.ov-page { max-width: 1080px; margin: 0 auto; padding: calc(var(--space-3) * 1.5) var(--space-3); }
h1, h2, h3 { font-family: var(--font-display); line-height: var(--leading-tight, 1.15); margin: 0; }
h1 { font-size: var(--text-3xl, 40px); }
h2 { font-size: var(--text-xl, 24px); margin-bottom: var(--space-2); }
p { margin: 0 0 var(--space-2); }
code { font-family: var(--font-mono); font-size: 0.85em; color: var(--muted); }
.ov-muted { color: var(--muted); }
.ov-section { margin-top: calc(var(--space-3) * 2); padding-top: var(--space-3); border-top: 1px solid var(--border); }
.ov-palette { display: grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); gap: var(--space-2); }
.ov-swatch { background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius); overflow: hidden; }
.ov-swatch-chip { height: 64px; border-bottom: 1px solid var(--border); }
.ov-swatch-meta { padding: var(--space-1) var(--space-2); display: grid; gap: 2px; }
.ov-scale > * { margin: 0 0 var(--space-2); }
.ov-s4 { font-family: var(--font-display); font-size: var(--text-4xl, 56px); line-height: var(--leading-tight, 1.1); }
.ov-s3 { font-family: var(--font-display); font-size: var(--text-3xl, 40px); line-height: var(--leading-tight, 1.15); }
.ov-s2 { font-family: var(--font-display); font-size: var(--text-2xl, 32px); }
.ov-s1 { font-family: var(--font-display); font-size: var(--text-xl, 24px); }
.ov-body-lg { font-size: var(--text-lg, 18px); }
.ov-body { font-size: var(--text-base, 16px); }
.ov-body-sm { font-size: var(--text-sm, 13px); color: var(--muted); }
.ov-mono { font-family: var(--font-mono); font-size: var(--text-sm, 13px); }
.ov-cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(320px, 1fr)); gap: var(--space-3); }
.ov-card { container-type: size; position: relative; aspect-ratio: 16 / 9; overflow: hidden; background: var(--bg); border: 1px solid var(--border); border-radius: var(--radius); }
.ov-title-card { display: grid; align-content: center; gap: 2cqmin; padding: 8cqmin; }
.ov-kicker { font-size: 3.2cqmin; letter-spacing: 0.18em; text-transform: uppercase; color: var(--accent); }
.ov-bar { width: 14cqmin; height: 1.2cqmin; background: var(--brand); border-radius: var(--radius); }
.ov-big { font-family: var(--font-display); font-size: 11cqmin; line-height: var(--leading-tight, 1.1); }
.ov-sub { font-size: 4cqmin; color: var(--muted); }
.ov-stage-card { background: var(--surface); }
.ov-lower { position: absolute; left: 6cqmin; bottom: 8cqmin; display: grid; gap: 0.6cqmin; padding: 2.4cqmin 4cqmin; background: var(--bg); border-left: 1.2cqmin solid var(--brand); border-radius: var(--radius); box-shadow: var(--shadow-md, none); }
.ov-lower-name { font-family: var(--font-display); font-size: 6cqmin; }
.ov-lower-role { font-size: 3.6cqmin; color: var(--muted); }
.ov-trans { display: grid; grid-template-columns: 220px 1fr; gap: var(--space-3); align-items: center; margin-bottom: var(--space-3); }
.ov-stage { height: 96px; background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius); overflow: hidden; display: grid; place-items: center; }
.ov-mover { width: 100%; height: 100%; background: var(--brand); }
.ov-tag { display: inline-block; padding: 1px var(--space-1); border: 1px solid var(--border); border-radius: var(--radius); font-size: var(--text-sm, 12px); color: var(--muted); }
.ov-warn { border-color: var(--accent); color: var(--accent); }
.ov-list { margin: 0; padding-left: 1.2em; display: grid; gap: var(--space-1); }
.ov-cols { display: grid; grid-template-columns: 1fr 1fr; gap: var(--space-3); }
.ov-font { margin-bottom: var(--space-3); }
.ov-font-sample { font-size: var(--text-xl, 24px); margin-bottom: var(--space-1); }
.ov-shapes { display: flex; gap: var(--space-3); align-items: end; }
.ov-shape { width: 72px; height: 72px; background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius); }
.ov-logo { max-height: 96px; max-width: 320px; }
@media (max-width: 720px) { .ov-trans, .ov-cols { grid-template-columns: 1fr; } }
@media (prefers-reduced-motion: reduce) { .ov-mover { animation: none !important; } }`;

export function showcaseCss(transitions: DesignTransition[], fontFamilies: string[]): string {
  const fonts = fontFamilies.map(
    (family, index) => `.ov-font-${index} { font-family: "${cssString(family)}", sans-serif; }`,
  );
  return [BASE_CSS, ...fonts, ...transitions.map(transitionCss)].join("\n");
}
