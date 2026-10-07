/**
 * Splits one scene recording into its lines. The scene's words come from the speech recognizer with their timings;
 * the lines' own spoken text says which words belong to which line. Both are reduced to normalised tokens and aligned
 * (longest common subsequence), so a misheard or merged word costs one token, not the split. The cut is never found
 * from silence: only from where the line's own words were recognised.
 */

export interface TimedWord {
  text: string;
  start: number;
  end: number;
}

export interface SceneLineText {
  id: string;
  /** What the narrator reads (tags removed). */
  spoken: string;
}

export interface SceneLineRange {
  id: string;
  start: number;
  end: number;
  /** The recognised words of the line, relative to `start`. */
  words: TimedWord[];
}

export type SceneSplit = { ok: true; lines: SceneLineRange[] } | { ok: false; reason: string };

/** Lines of the scene whose words are found in the recording, at least. */
const MIN_LINE_COVERAGE = 0.5;
/** Words of the whole scene found in the recording, at least. */
const MIN_SCENE_COVERAGE = 0.7;
/** Room kept before a line's first word and after its last, seconds (never into the neighbour's words). */
const LEAD_SECONDS = 0.15;
const TAIL_SECONDS = 0.25;

/** Letters and digits only, lower case: "Don't" and "don’t," compare equal. */
export function tokensOf(value: string): string[] {
  return value
    .toLowerCase()
    .normalize("NFKC")
    .replace(/[^\p{L}\p{N}\s]/gu, "")
    .split(/\s+/)
    .filter((token) => token.length > 0);
}

function withinOneEdit(a: string, b: string): boolean {
  if (a === b) return true;
  // A short word differing by one letter is a different word ("on"/"in"); only longer ones are a mishearing.
  if (Math.min(a.length, b.length) < 5 || Math.abs(a.length - b.length) > 1) return false;
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i += 1;
  if (a.length === b.length) return a.slice(i + 1) === b.slice(i + 1);
  const [long, short] = a.length > b.length ? [a, b] : [b, a];
  return long.slice(i + 1) === short.slice(i);
}

/** Pairs (script token, recognised word) of a longest common subsequence. */
export function lcsPairs(
  script: readonly string[],
  heard: readonly string[],
): Array<[number, number]> {
  const width = heard.length + 1;
  const table = new Uint16Array((script.length + 1) * width);
  for (let i = script.length - 1; i >= 0; i -= 1) {
    for (let j = heard.length - 1; j >= 0; j -= 1) {
      const down = table[(i + 1) * width + j] ?? 0;
      const right = table[i * width + j + 1] ?? 0;
      const diagonal = table[(i + 1) * width + j + 1] ?? 0;
      table[i * width + j] = withinOneEdit(script[i] ?? "", heard[j] ?? "")
        ? Math.max(diagonal + 1, down, right)
        : Math.max(down, right);
    }
  }
  const pairs: Array<[number, number]> = [];
  let i = 0;
  let j = 0;
  while (i < script.length && j < heard.length) {
    const here = table[i * width + j] ?? 0;
    if (
      withinOneEdit(script[i] ?? "", heard[j] ?? "") &&
      here === (table[(i + 1) * width + j + 1] ?? 0) + 1
    ) {
      pairs.push([i, j]);
      i += 1;
      j += 1;
    } else if (here === (table[(i + 1) * width + j] ?? 0)) i += 1;
    else j += 1;
  }
  return pairs;
}

export function splitScene(
  lines: readonly SceneLineText[],
  words: readonly TimedWord[],
  durationSeconds: number,
): SceneSplit {
  const scriptTokens: string[] = [];
  const lineOfToken: number[] = [];
  for (const [lineIndex, line] of lines.entries()) {
    for (const token of tokensOf(line.spoken)) {
      scriptTokens.push(token);
      lineOfToken.push(lineIndex);
    }
  }
  const heardTokens: string[] = [];
  const wordOfToken: number[] = [];
  for (const [wordIndex, word] of words.entries()) {
    for (const token of tokensOf(word.text)) {
      heardTokens.push(token);
      wordOfToken.push(wordIndex);
    }
  }
  if (scriptTokens.length === 0) return { ok: false, reason: "the scene has no words to speak" };
  if (heardTokens.length === 0)
    return { ok: false, reason: "no speech was recognised in the scene" };

  const pairs = lcsPairs(scriptTokens, heardTokens);
  const total = scriptTokens.length;
  if (pairs.length / total < MIN_SCENE_COVERAGE) {
    return {
      ok: false,
      reason: `only ${pairs.length} of ${total} words of the scene were found in the recognised speech`,
    };
  }

  // First and last recognised word of each line, and how many of its words were found.
  const found = lines.map(() => ({ first: -1, last: -1, count: 0 }));
  for (const [scriptIndex, heardIndex] of pairs) {
    const lineIndex = lineOfToken[scriptIndex];
    const wordIndex = wordOfToken[heardIndex];
    const entry = lineIndex === undefined ? undefined : found[lineIndex];
    if (!entry || wordIndex === undefined) continue;
    if (entry.first < 0) entry.first = wordIndex;
    entry.last = wordIndex;
    entry.count += 1;
  }
  const lineTokens = lines.map((_, lineIndex) => lineOfToken.filter((l) => l === lineIndex).length);
  for (const [lineIndex, entry] of found.entries()) {
    const line = lines[lineIndex];
    const expected = lineTokens[lineIndex] ?? 0;
    if (!line || expected === 0 || entry.first < 0 || entry.count / expected < MIN_LINE_COVERAGE) {
      return {
        ok: false,
        reason: `line ${line?.id ?? lineIndex} could not be found in the recognised speech`,
      };
    }
  }

  const ranges: SceneLineRange[] = [];
  for (const [lineIndex, entry] of found.entries()) {
    const line = lines[lineIndex];
    const firstWord = words[entry.first];
    const lastWord = words[entry.last];
    if (!line || !firstWord || !lastWord)
      return { ok: false, reason: "the recognised words are inconsistent" };
    const before = found[lineIndex - 1];
    const after = found[lineIndex + 1];
    const previousEnd = before ? (words[before.last]?.end ?? 0) : 0;
    const nextStart = after ? (words[after.first]?.start ?? durationSeconds) : durationSeconds;
    // Words of two lines may overlap by a few hundredths in a fast read: the gap is never negative.
    const gapBefore = Math.max(0, firstWord.start - previousEnd);
    const gapAfter = Math.max(0, nextStart - lastWord.end);
    const start = Math.max(0, firstWord.start - Math.min(LEAD_SECONDS, gapBefore / 2));
    const end = Math.min(durationSeconds, lastWord.end + Math.min(TAIL_SECONDS, gapAfter / 2));
    ranges.push({
      id: line.id,
      start: round3(start),
      end: round3(Math.max(end, start)),
      words: words.slice(entry.first, entry.last + 1).map((word) => ({
        text: word.text,
        start: round3(Math.max(0, word.start - start)),
        end: round3(Math.max(0, word.end - start)),
      })),
    });
  }
  return { ok: true, lines: ranges };
}

function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}
