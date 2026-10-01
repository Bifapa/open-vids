import postcss from "postcss";

/** What a page's style sheets declare, read from the sheets' own text (cross-origin sheets included). */
export interface CssFontFace {
  /** The `font-family` name as declared (unquoted). */
  family: string;
  weightMin: number;
  weightMax: number;
  italic: boolean;
  unicodeRange: string | null;
  /** Absolute URLs, in the order of the `src` list. */
  srcs: Array<{ url: string; format: string | null }>;
}

export interface CssFacts {
  fontFaces: CssFontFace[];
  /** Custom properties declared on `:root` that look like design tokens, semantic names first. */
  tokenNames: string[];
  keyframes: string[];
  /** How often each duration (ms), easing and transitioned property is declared. */
  durations: Map<number, number>;
  easings: Map<string, number>;
  properties: Map<string, number>;
}

export interface CssSheet {
  text: string;
  /** Where relative URLs in the sheet resolve from: the sheet's own URL, or the page's for inline CSS. */
  baseUrl: string;
}

const MAX_TOKEN_CANDIDATES = 160;
const TOKEN_NAME =
  /^--(?:[a-z0-9]+-)?(?:color|colour|bg|background|fg|foreground|text|font|radius|radii|shadow|space|spacing|ease|easing|duration|brand|primary|secondary|accent|surface|border|gray|grey|neutral|muted|ring|card|popover|destructive|success|warning|danger|info|size|gap|leading|tracking)/i;
/** `--color-red-500`, `--gray-100`: a palette step, not a decision of this site. */
const SCALE_STEP = /-(?:50|[1-9]00|950|[0-9])$/;
const TIME = /^-?(?:\d+\.?\d*|\.\d+)(?:ms|s)$/i;
const EASING =
  /^(?:ease|ease-in|ease-out|ease-in-out|linear|step-start|step-end)$|^(?:cubic-bezier|steps|linear)\(/i;
const TRANSITION_KEYWORDS = new Set([
  "none",
  "all",
  "initial",
  "inherit",
  "unset",
  "normal",
  "reverse",
  "alternate",
  "forwards",
  "backwards",
  "both",
  "infinite",
  "running",
  "paused",
]);

function unquote(value: string): string {
  return value.trim().replace(/^["']|["']$/g, "");
}

function weightRange(value: string | undefined): [number, number] {
  const text = (value ?? "normal").trim().toLowerCase();
  if (text === "normal") return [400, 400];
  if (text === "bold") return [700, 700];
  const numbers = text
    .split(/\s+/)
    .map(Number)
    .filter((n) => Number.isFinite(n));
  const [first, second] = numbers;
  if (first === undefined) return [400, 400];
  return [first, second ?? first];
}

function resolveUrl(raw: string, base: string): string | null {
  try {
    const url = new URL(raw.trim(), base);
    return url.protocol === "http:" || url.protocol === "https:" ? url.href : null;
  } catch {
    return null;
  }
}

function faceSources(src: string, base: string): CssFontFace["srcs"] {
  const out: CssFontFace["srcs"] = [];
  const pattern =
    /url\(\s*(?:"([^"]*)"|'([^']*)'|([^)]*?))\s*\)(?:\s*format\(\s*["']?([^"')]+)["']?\s*\))?/gi;
  for (const match of src.matchAll(pattern)) {
    const url = resolveUrl(match[1] ?? match[2] ?? match[3] ?? "", base);
    if (url) out.push({ url, format: match[4]?.toLowerCase() ?? null });
  }
  return out;
}

/** Top-level comma split (a `cubic-bezier(0.2, 0, 0, 1)` keeps its commas). */
function splitList(value: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = "";
  for (const char of value) {
    if (char === "(") depth += 1;
    if (char === ")") depth = Math.max(0, depth - 1);
    if (char === "," && depth === 0) {
      parts.push(current.trim());
      current = "";
    } else {
      current += char;
    }
  }
  if (current.trim() !== "") parts.push(current.trim());
  return parts;
}

function splitWords(value: string): string[] {
  const words: string[] = [];
  let depth = 0;
  let current = "";
  for (const char of value) {
    if (char === "(") depth += 1;
    if (char === ")") depth = Math.max(0, depth - 1);
    if (/\s/.test(char) && depth === 0) {
      if (current !== "") words.push(current);
      current = "";
    } else {
      current += char;
    }
  }
  if (current !== "") words.push(current);
  return words;
}

function ms(value: string): number | null {
  if (!TIME.test(value)) return null;
  const n = parseFloat(value);
  return Math.round(/ms$/i.test(value) ? n : n * 1000);
}

function count<K>(map: Map<K, number>, key: K): void {
  map.set(key, (map.get(key) ?? 0) + 1);
}

export function analyzeCss(sheets: readonly CssSheet[]): CssFacts {
  const facts: CssFacts = {
    fontFaces: [],
    tokenNames: [],
    keyframes: [],
    durations: new Map(),
    easings: new Map(),
    properties: new Map(),
  };
  const tokens = new Set<string>();

  for (const sheet of sheets) {
    let root: postcss.Root;
    try {
      root = postcss.parse(sheet.text);
    } catch {
      continue;
    }

    root.walkAtRules((rule) => {
      if (/keyframes$/i.test(rule.name)) {
        const name = unquote(rule.params);
        if (name !== "" && !facts.keyframes.includes(name)) facts.keyframes.push(name);
        return;
      }
      if (rule.name.toLowerCase() !== "font-face") return;
      const declared: Record<string, string> = {};
      rule.walkDecls((decl) => {
        declared[decl.prop.toLowerCase()] = decl.value;
      });
      const family = unquote(declared["font-family"] ?? "");
      const srcs = faceSources(declared.src ?? "", sheet.baseUrl);
      if (family === "" || srcs.length === 0) return;
      const [weightMin, weightMax] = weightRange(declared["font-weight"]);
      facts.fontFaces.push({
        family,
        weightMin,
        weightMax,
        italic: /italic|oblique/i.test(declared["font-style"] ?? ""),
        unicodeRange: declared["unicode-range"] ?? null,
        srcs,
      });
    });

    root.walkRules((rule) => {
      const rootLevel = rule.selectors.some((selector) =>
        /^(?::root|html|:host|body)$/i.test(selector.trim()),
      );
      if (!rootLevel) return;
      rule.walkDecls(/^--/, (decl) => {
        if (decl.prop.startsWith("--tw-") || !TOKEN_NAME.test(decl.prop)) return;
        tokens.add(decl.prop);
      });
    });

    root.walkDecls((decl) => {
      const prop = decl.prop.toLowerCase();
      if (prop === "transition-duration" || prop === "animation-duration") {
        for (const item of splitList(decl.value)) {
          const value = ms(item);
          if (value !== null && value > 0) count(facts.durations, value);
        }
      } else if (prop === "transition-timing-function" || prop === "animation-timing-function") {
        for (const item of splitList(decl.value)) if (EASING.test(item)) count(facts.easings, item);
      } else if (prop === "transition-property") {
        for (const item of splitList(decl.value)) {
          if (!TRANSITION_KEYWORDS.has(item.toLowerCase()) && !item.startsWith("--"))
            count(facts.properties, item);
        }
      } else if (prop === "transition" || prop === "animation") {
        for (const item of splitList(decl.value)) {
          const words = splitWords(item);
          const duration = words.map(ms).find((value) => value !== null);
          if (duration !== undefined && duration !== null && duration > 0)
            count(facts.durations, duration);
          const easing = words.find((word) => EASING.test(word));
          if (easing) count(facts.easings, easing);
          if (prop === "transition") {
            const property = words.find(
              (word) =>
                !TIME.test(word) &&
                !EASING.test(word) &&
                !TRANSITION_KEYWORDS.has(word.toLowerCase()) &&
                !word.startsWith("--"),
            );
            if (property) count(facts.properties, property);
          }
        }
      }
    });
  }

  const semantic = [...tokens].filter((name) => !SCALE_STEP.test(name));
  const scales = [...tokens].filter((name) => SCALE_STEP.test(name));
  facts.tokenNames = [...semantic, ...scales].slice(0, MAX_TOKEN_CANDIDATES);
  return facts;
}

/** Keys of a count map, most frequent first. */
export function topKeys<K>(map: Map<K, number>, limit: number): K[] {
  return [...map.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([key]) => key);
}
