import type { CssDeclaration } from "./cssScan.js";

/** What the literals of a composition's scripts say about design (GSAP calls only; `data-*` timing is not design). */
export interface ScriptFacts {
  /** The style options of each GSAP call, as CSS declarations (`backgroundColor: "#fff"` → `background-color`). */
  groups: CssDeclaration[][];
  easings: string[];
  durations: number[];
}

const MAX_CALLS = 2000;
const MAX_ARGS_CHARS = 6000;

const GSAP_CALL = /\.\s*(?:to|from|fromTo|set|timeline|defaults)\s*\(/g;

/** GSAP option keys that carry CSS values, and the CSS property each stands for. */
const STYLE_KEYS: Readonly<Record<string, string>> = {
  backgroundColor: "background-color",
  background: "background",
  color: "color",
  borderColor: "border-color",
  outlineColor: "outline-color",
  fill: "fill",
  stroke: "stroke",
  stopColor: "stop-color",
  boxShadow: "box-shadow",
  textShadow: "text-shadow",
  filter: "filter",
  borderRadius: "border-radius",
  fontFamily: "font-family",
  fontSize: "font-size",
  fontWeight: "font-weight",
};
/** Keys whose bare numbers GSAP applies as pixels. */
const PIXEL_KEYS: Readonly<Record<string, true>> = { fontSize: true, borderRadius: true };

const PAIR =
  /(?<![\w$.])(?:([A-Za-z_$][\w$]*)|"([^"\n]+)"|'([^'\n]+)')\s*:\s*(?:"((?:[^"\\\n]|\\.)*)"|'((?:[^'\\\n]|\\.)*)'|(-?\d*\.?\d+)(?![\w.]))/g;

interface Call {
  start: number;
  end: number;
}

/** Index of the `)` closing the call whose `(` ends just before `from`, within the cap. */
function callEnd(script: string, from: number): number | null {
  let depth = 1;
  let quote = "";
  const limit = Math.min(script.length, from + MAX_ARGS_CHARS);
  for (let i = from; i < limit; i++) {
    const ch = script[i];
    if (quote !== "") {
      if (ch === "\\") i++;
      else if (ch === quote) quote = "";
    } else if (ch === '"' || ch === "'" || ch === "`") quote = ch;
    else if (ch === "(") depth++;
    else if (ch === ")" && --depth === 0) return i;
  }
  return null;
}

/** The text of a call's arguments with every call nested inside it blanked, so each literal is read once. */
function ownArguments(script: string, call: Call, calls: readonly Call[]): string {
  let text = script.slice(call.start, call.end);
  for (const inner of calls) {
    if (inner === call || inner.start < call.start || inner.end > call.end) continue;
    const from = inner.start - call.start;
    text =
      text.slice(0, from) +
      " ".repeat(inner.end - inner.start) +
      text.slice(inner.end - call.start);
  }
  return text;
}

function pairValue(match: RegExpMatchArray): string {
  return (match[4] ?? match[5] ?? match[6] ?? "").trim();
}

export function scanScript(script: string, into: ScriptFacts): void {
  const calls: Call[] = [];
  for (const match of script.matchAll(GSAP_CALL)) {
    if (calls.length >= MAX_CALLS) break;
    const start = match.index + match[0].length;
    const end = callEnd(script, start);
    if (end !== null) calls.push({ start, end });
  }
  for (const call of calls) {
    const group: CssDeclaration[] = [];
    for (const pair of ownArguments(script, call, calls).matchAll(PAIR)) {
      const key = pair[1] ?? pair[2] ?? pair[3] ?? "";
      const value = pairValue(pair);
      if (key === "ease") {
        if (pair[6] === undefined && value !== "" && value.length <= 80) into.easings.push(value);
      } else if (key === "duration") {
        const seconds = Number(value);
        if (pair[6] !== undefined && seconds > 0 && Number.isFinite(seconds)) {
          into.durations.push(seconds);
        }
      } else if (Object.hasOwn(STYLE_KEYS, key) && value !== "") {
        const property = STYLE_KEYS[key] ?? key;
        const text = pair[6] !== undefined && PIXEL_KEYS[key] ? `${value}px` : value;
        group.push({ property, value: text });
      }
    }
    if (group.length > 0) into.groups.push(group);
  }
}
