import type { VoiceLine, VoiceTake } from "@hyperframes/agent-protocol";
import { lcsPairs, tokensOf, type TimedWord } from "./align.js";

/**
 * The words a caption shows, with the times the narrator spoke them. Captions show the line's own SOURCE text ("In
 * July 2022"), while the recognizer hears what was said ("in july twenty twenty two"): the two are aligned (longest
 * common subsequence over normalised tokens) and each source word takes the time of the heard word it matches. A
 * source word without a match (a number, an abbreviation, a word the recognizer missed) takes the span of the heard
 * words that sit between its matched neighbours, shared among the unmatched source words by their length.
 */
function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}

/**
 * The source text's words as written (punctuation stays on the word) with times from the heard words, relative to the
 * heard words' own zero (the take's start). Empty when nothing was heard: there is no time to give.
 */
export function alignSourceWords(sourceText: string, heard: readonly TimedWord[]): TimedWord[] {
  const source = sourceText.split(/\s+/).filter((word) => word.length > 0);
  if (source.length === 0 || heard.length === 0) return [];

  // One normalised token per word ("don't," and "Don’t" are the same; "well-known" is one token). Words that reduce
  // to nothing (a lone dash) take no part in the alignment: they are interpolated like any other.
  const sourceAt: number[] = [];
  const heardAt: number[] = [];
  const sourceTokens: string[] = [];
  const heardTokens: string[] = [];
  for (const [index, word] of source.entries()) {
    const token = tokensOf(word).join("");
    if (token.length === 0) continue;
    sourceAt.push(index);
    sourceTokens.push(token);
  }
  for (const [index, word] of heard.entries()) {
    const token = tokensOf(word.text).join("");
    if (token.length === 0) continue;
    heardAt.push(index);
    heardTokens.push(token);
  }
  // Source index -> heard index of the matched pairs.
  const matched = new Map<number, number>();
  for (const [s, h] of lcsPairs(sourceTokens, heardTokens)) {
    const sourceIndex = sourceAt[s];
    const heardIndex = heardAt[h];
    if (sourceIndex !== undefined && heardIndex !== undefined) matched.set(sourceIndex, heardIndex);
  }

  const out: TimedWord[] = new Array<TimedWord>(source.length);
  const firstHeard = heard[0];
  const lastHeard = heard[heard.length - 1];
  if (!firstHeard || !lastHeard) return [];

  let previousHeard = -1;
  let index = 0;
  while (index < source.length) {
    const hit = matched.get(index);
    if (hit !== undefined) {
      const word = heard[hit];
      out[index] = {
        text: source[index] ?? "",
        start: round3(word?.start ?? 0),
        end: round3(word?.end ?? 0),
      };
      previousHeard = hit;
      index += 1;
      continue;
    }
    // A run of unmatched source words, up to the next matched one.
    let stop = index;
    while (stop < source.length && !matched.has(stop)) stop += 1;
    const nextHeard = stop < source.length ? (matched.get(stop) ?? heard.length) : heard.length;
    const between = heard.slice(previousHeard + 1, nextHeard);
    const before = previousHeard >= 0 ? heard[previousHeard] : undefined;
    const after = nextHeard < heard.length ? heard[nextHeard] : undefined;
    const first = between[0];
    const last = between[between.length - 1];
    // The heard words in the gap when there are any, else the silence between the neighbours (nothing before the
    // first or after the last heard word: a zero-length span at it).
    const from = first ? first.start : (before?.end ?? after?.start ?? firstHeard.start);
    const to = last ? last.end : Math.max(from, after?.start ?? before?.end ?? lastHeard.end);
    const weights = source.slice(index, stop).map((word) => Math.max(1, word.length));
    const total = weights.reduce((sum, weight) => sum + weight, 0);
    let at = from;
    for (const [offset, weight] of weights.entries()) {
      const end = offset === weights.length - 1 ? to : at + ((to - from) * weight) / total;
      out[index + offset] = {
        text: source[index + offset] ?? "",
        start: round3(at),
        end: round3(Math.max(at, end)),
      };
      at = end;
    }
    index = stop;
  }
  return out;
}

/**
 * The line's caption words for a take: its source text timed by the take's recognised words (relative to the take's
 * start). Null when the take has no recognised words.
 */
export function takeCaptionWords(line: VoiceLine, take: VoiceTake): TimedWord[] | null {
  if (!take.words || take.words.length === 0) return null;
  const words = alignSourceWords(line.text, take.words);
  return words.length > 0 ? words : null;
}
