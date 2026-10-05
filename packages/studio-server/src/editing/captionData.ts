import { isRecord } from "@hyperframes/agent-protocol";

const GROUPS_MARK = "var GROUPS = ";

/** One word of a caption group as `buildCaptionsComposition` writes it. */
export interface StoredWord {
  id: string;
  text: string;
  start: number;
  end: number;
}

export interface StoredGroup {
  id: string;
  start: number;
  end: number;
  text: string;
  words: StoredWord[];
}

/** Where the JSON array of `var GROUPS = [...];` sits in a captions composition (end exclusive), or null. */
function groupsSpan(source: string): { from: number; to: number } | null {
  const mark = source.indexOf(GROUPS_MARK);
  if (mark < 0) return null;
  const from = mark + GROUPS_MARK.length;
  if (source[from] !== "[") return null;
  let depth = 0;
  let inString = false;
  for (let index = from; index < source.length; index += 1) {
    const char = source[index];
    if (inString) {
      if (char === "\\") index += 1;
      else if (char === '"') inString = false;
    } else if (char === '"') inString = true;
    else if (char === "[") depth += 1;
    else if (char === "]") {
      depth -= 1;
      if (depth === 0) return { from, to: index + 1 };
    }
  }
  return null;
}

function isStoredWord(value: unknown): value is StoredWord {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.text === "string" &&
    typeof value.start === "number" &&
    typeof value.end === "number"
  );
}

function isStoredGroup(value: unknown): value is StoredGroup {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.text === "string" &&
    typeof value.start === "number" &&
    typeof value.end === "number" &&
    Array.isArray(value.words) &&
    value.words.every(isStoredWord)
  );
}

/** The cue groups a captions composition holds; null when it is not one `apply_captions` wrote. */
export function readStoredGroups(source: string): StoredGroup[] | null {
  const span = groupsSpan(source);
  if (!span) return null;
  try {
    const parsed: unknown = JSON.parse(source.slice(span.from, span.to));
    return Array.isArray(parsed) && parsed.every(isStoredGroup) ? parsed : null;
  } catch {
    return null;
  }
}

/** The captions composition with its groups replaced (escaped like the original write). */
export function withStoredGroups(source: string, groups: readonly StoredGroup[]): string {
  const span = groupsSpan(source);
  if (!span) throw new Error("captions composition has no GROUPS array");
  const json = JSON.stringify(groups).replace(/</g, "\\u003c");
  return `${source.slice(0, span.from)}${json}${source.slice(span.to)}`;
}

/** `var DURATION = n;` of a captions composition, or null. */
export function readStoredDuration(source: string): number | null {
  const match = /var DURATION = (\d+(?:\.\d+)?);/.exec(source);
  return match?.[1] ? Number.parseFloat(match[1]) : null;
}
