import type {
  ExtractedColor,
  ExtractedColorRole,
  ExtractedDuration,
  ExtractedValue,
} from "@hyperframes/agent-protocol";
import { EXTRACTED_COLOR_ROLES } from "@hyperframes/agent-protocol";
import { colorsIn } from "./colorValue.js";
import { resolveVars, type CssDeclaration } from "./cssScan.js";

/** Generic families and system-font aliases: they name no font a design system could carry. */
const GENERIC_FAMILIES: Readonly<Record<string, true>> = {
  serif: true,
  "sans-serif": true,
  monospace: true,
  cursive: true,
  fantasy: true,
  "system-ui": true,
  "ui-serif": true,
  "ui-sans-serif": true,
  "ui-monospace": true,
  "ui-rounded": true,
  emoji: true,
  math: true,
  fangsong: true,
  "-apple-system": true,
  blinkmacsystemfont: true,
  inherit: true,
  initial: true,
  unset: true,
  revert: true,
};

/** Properties whose values are never colours (a hex-looking word in a `content` string, an animation name). */
const NO_COLOR_PROPERTIES: Readonly<Record<string, true>> = {
  "font-family": true,
  font: true,
  content: true,
  src: true,
  "animation-name": true,
  "transition-property": true,
  "will-change": true,
  "grid-area": true,
  "grid-template-areas": true,
};

const SIZE_UNIT = "(?:px|rem|em|pt|%|cqmin|cqmax|cqw|cqh|vw|vh|vmin|vmax)";
const FONT_SHORTHAND = new RegExp(
  `(?:^|\\s)(\\d*\\.?\\d+${SIZE_UNIT}|xx-small|x-small|small|medium|large|x-large|xx-large|smaller|larger)(?:/\\S+)?\\s+(.+)$`,
  "i",
);
const TIMING =
  /cubic-bezier\([^)]*\)|steps\([^)]*\)|linear\([^)]*\)|(?<![\w-])(?:ease-in-out|ease-in|ease-out|ease|linear|step-start|step-end)(?![\w-])/gi;
const TIME = /(?<![\w.-])(\d*\.?\d+)(ms|s)(?![\w-])/gi;
const RADIUS_PROPERTY =
  /^border(?:-(?:top|bottom)-(?:left|right)|-(?:start|end)-(?:start|end))?-radius$/;

/** The role a colour has from the CSS property it was written in. */
export function colorRole(property: string): ExtractedColorRole {
  if (
    property === "background" ||
    property === "background-color" ||
    property === "background-image"
  ) {
    return "background";
  }
  if (property === "color" || property === "-webkit-text-fill-color") return "text";
  if (property.startsWith("border") || property.startsWith("outline")) return "border";
  if (property === "fill" || property === "stroke") return "fill";
  return "other";
}

function isColorProperty(property: string): boolean {
  return (
    property === "background" ||
    property === "fill" ||
    property === "stroke" ||
    property === "box-shadow" ||
    property === "text-shadow" ||
    property === "filter" ||
    property.startsWith("border") ||
    property.startsWith("outline") ||
    property.startsWith("background") ||
    property.endsWith("color") ||
    property.startsWith("text-decoration")
  );
}

/** A family name with its quotes removed, or null for a generic or empty one. */
function primaryFamily(stack: string): string | null {
  let name = "";
  let quote = "";
  const names: string[] = [];
  for (const ch of stack) {
    if (quote !== "") {
      if (ch === quote) quote = "";
      else name += ch;
    } else if (ch === '"' || ch === "'") quote = ch;
    else if (ch === ",") {
      names.push(name);
      name = "";
    } else name += ch;
  }
  names.push(name);
  for (const raw of names) {
    const family = raw.trim().replace(/\s+/g, " ");
    if (family !== "" && GENERIC_FAMILIES[family.toLowerCase()] !== true) return family;
  }
  return null;
}

function weightsOf(value: string): number[] {
  const weights: number[] = [];
  for (const token of value.toLowerCase().split(/\s+/)) {
    if (token === "normal") weights.push(400);
    else if (token === "bold") weights.push(700);
    else if (/^\d{1,4}$/.test(token) && Number(token) >= 1 && Number(token) <= 1000) {
      weights.push(Number(token));
    }
  }
  return weights;
}

/** Normalises a CSS timing function so equal curves count together. */
function timingOf(raw: string): string {
  const bezier = /^cubic-bezier\(([^)]*)\)$/i.exec(raw.trim());
  if (!bezier) return raw.trim().toLowerCase().replace(/\s+/g, " ");
  const numbers = (bezier[1] ?? "").split(",").map((part) => Number(part.trim()));
  return numbers.length === 4 && numbers.every(Number.isFinite)
    ? `cubic-bezier(${numbers.join(", ")})`
    : raw.trim();
}

function bump<K>(map: Map<K, number>, key: K): void {
  map.set(key, (map.get(key) ?? 0) + 1);
}

/** Count desc, then the value itself ascending (plain code-unit order, never locale-dependent). */
function ranked<T>(map: Map<T, number>, order: (a: T, b: T) => number): Array<[T, number]> {
  return [...map].sort((a, b) => b[1] - a[1] || order(a[0], b[0]));
}

const byText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

interface FontTally {
  family: string;
  count: number;
  weights: Set<number>;
}

/** Everything the extraction counts; groups of declarations (one rule, one element) go in, ranked values come out. */
export class DesignTally {
  private readonly colors = new Map<string, { count: number; roles: Set<ExtractedColorRole> }>();
  private readonly fonts = new Map<string, FontTally>();
  private readonly easings = new Map<string, number>();
  private readonly durations = new Map<number, number>();
  private readonly radii = new Map<string, number>();
  private readonly fontSizes = new Map<string, number>();
  private readonly shadows = new Map<string, number>();

  constructor(private readonly vars: ReadonlyMap<string, string>) {}

  addEasing(raw: string): void {
    const value = timingOf(raw);
    if (value !== "") bump(this.easings, value);
  }

  addDuration(seconds: number): void {
    if (seconds > 0 && Number.isFinite(seconds))
      bump(this.durations, Math.round(seconds * 1000) / 1000);
  }

  private addColors(property: string, value: string): void {
    if (NO_COLOR_PROPERTIES[property] === true) return;
    const role = colorRole(property);
    for (const color of colorsIn(value, isColorProperty(property))) {
      const entry = this.colors.get(color) ?? { count: 0, roles: new Set<ExtractedColorRole>() };
      entry.count += 1;
      entry.roles.add(role);
      this.colors.set(color, entry);
    }
  }

  private addFont(family: string, weights: readonly number[]): void {
    const key = family.toLowerCase();
    const entry = this.fonts.get(key) ?? { family, count: 0, weights: new Set<number>() };
    entry.count += 1;
    for (const weight of weights) entry.weights.add(weight);
    this.fonts.set(key, entry);
  }

  private addTransitionLike(property: string, value: string): void {
    for (const timing of value.matchAll(TIMING)) this.addEasing(timing[0]);
    if (property === "transition" || property === "animation") {
      for (const item of splitTopLevel(value)) {
        const first = [...item.matchAll(TIME)][0];
        if (first?.[1] !== undefined) this.addDuration(secondsOf(first[1], first[2]));
      }
    } else if (property.endsWith("-duration")) {
      for (const time of value.matchAll(TIME)) {
        if (time[1] !== undefined) this.addDuration(secondsOf(time[1], time[2]));
      }
    }
  }

  /** One rule's (or one element's) declarations: a font family pairs with the weight written beside it. */
  addGroup(declarations: readonly CssDeclaration[]): void {
    const resolved = declarations
      .filter((declaration) => !declaration.property.startsWith("--"))
      .map((declaration) => ({
        property: declaration.property,
        value: resolveVars(declaration.value, this.vars).trim(),
      }))
      .filter((declaration) => !declaration.value.includes("var("));
    const weights = resolved
      .filter((declaration) => declaration.property === "font-weight")
      .flatMap((declaration) => weightsOf(declaration.value));
    for (const { property, value } of resolved) {
      if (/^(inherit|initial|unset|revert)$/i.test(value)) continue;
      this.addColors(property, value);
      if (property === "font-family") {
        const family = primaryFamily(value);
        if (family !== null) this.addFont(family, weights);
      } else if (property === "font") {
        this.addFontShorthand(value);
      } else if (property === "font-size") {
        if (/\d/.test(value)) bump(this.fontSizes, collapse(value));
      } else if (RADIUS_PROPERTY.test(property)) {
        bump(this.radii, collapse(value));
      } else if (property === "box-shadow" || property === "text-shadow") {
        if (value.toLowerCase() !== "none") bump(this.shadows, collapse(value));
      } else if (property === "filter" || property === "backdrop-filter") {
        for (const shadow of value.matchAll(/drop-shadow\(((?:[^()]|\([^()]*\))*)\)/gi)) {
          if (shadow[1] !== undefined) bump(this.shadows, collapse(shadow[1]));
        }
      } else if (
        property === "transition" ||
        property === "animation" ||
        property.endsWith("-timing-function") ||
        property.endsWith("-duration")
      ) {
        this.addTransitionLike(property, value);
      }
    }
  }

  private addFontShorthand(value: string): void {
    const match = FONT_SHORTHAND.exec(value);
    if (!match?.[1] || !match[2]) return;
    bump(this.fontSizes, collapse(match[1]));
    const family = primaryFamily(match[2]);
    if (family === null) return;
    this.addFont(family, weightsOf(value.slice(0, match.index)));
  }

  colorList(): ExtractedColor[] {
    return [...this.colors]
      .sort((a, b) => b[1].count - a[1].count || byText(a[0], b[0]))
      .map(([value, entry]) => ({
        value,
        count: entry.count,
        roles: EXTRACTED_COLOR_ROLES.filter((role) => entry.roles.has(role)),
      }));
  }

  /** Used families, most used first, with the weights seen in use. */
  fontList(): FontTally[] {
    return [...this.fonts.values()].sort(
      (a, b) => b.count - a.count || byText(a.family.toLowerCase(), b.family.toLowerCase()),
    );
  }

  easingList(): ExtractedValue[] {
    return values(this.easings);
  }

  durationList(): ExtractedDuration[] {
    return ranked(this.durations, (a, b) => a - b).map(([seconds, count]) => ({ seconds, count }));
  }

  radiusList(): ExtractedValue[] {
    return values(this.radii);
  }

  fontSizeList(): ExtractedValue[] {
    return values(this.fontSizes);
  }

  shadowList(): ExtractedValue[] {
    return values(this.shadows);
  }
}

function values(map: Map<string, number>): ExtractedValue[] {
  return ranked(map, byText).map(([value, count]) => ({ value, count }));
}

function collapse(value: string): string {
  return value.trim().replace(/\s+/g, " ");
}

function secondsOf(amount: string, unit: string | undefined): number {
  const number = Number(amount);
  return unit?.toLowerCase() === "ms" ? number / 1000 : number;
}

/** Splits a comma list at the top level (commas inside `cubic-bezier(...)` stay). */
function splitTopLevel(value: string): string[] {
  const items: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < value.length; i++) {
    const ch = value[i];
    if (ch === "(") depth++;
    else if (ch === ")") depth = Math.max(0, depth - 1);
    else if (ch === "," && depth === 0) {
      items.push(value.slice(start, i));
      start = i + 1;
    }
  }
  items.push(value.slice(start));
  return items;
}

export { weightsOf };
