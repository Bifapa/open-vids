import type {
  SilenceMap,
  SpeakerTurn,
  TranscriptArtifact,
  TranscriptHallucinations,
  TranscriptSentence,
  TranscriptWord,
} from "@hyperframes/agent-protocol";
import type { SpeechTranscription } from "../types.js";

/** Shortest word the transcript keeps, seconds (recognizers sometimes emit zero-length words). */
const MIN_WORD_SECONDS = 0.01;
/** A silence this long between two words always starts a new sentence. */
const SENTENCE_GAP_SECONDS = 1.2;
/** A sentence never runs longer than this many words, whatever the punctuation says. */
const SENTENCE_MAX_WORDS = 45;
/** The word limit waits for up to this many trailing words rather than leaving them as a sentence of their own. */
const SENTENCE_MAX_ORPHAN_WORDS = 2;
/**
 * A speaker change inside a sentence splits it only with a pause of at least this long at the change and at least
 * SPEAKER_SPLIT_MIN_WORDS words on each side. Diarization turn edges are off by a few tenths of a second, so a change
 * without both is jitter in the middle of a phrase ("let's get into | it.").
 */
const SPEAKER_SPLIT_GAP_SECONDS = 0.25;
const SPEAKER_SPLIT_MIN_WORDS = 3;

/** A repeated sentence is a recognizer loop only when it has at least this many words: "Thank you." twice is speech. */
const LOOP_MIN_WORDS = 5;
/** ...and is said at least this many times in a row: a speaker repeats themselves twice, a looping recognizer keeps going. */
const LOOP_MIN_COPIES = 3;
/** Two sentences are "the same" when this share of their words match in order (1 = identical). */
const LOOP_SIMILARITY = 0.85;
/**
 * Copies of a loop follow each other without a pause (a recognizer fills its windows); a speaker who repeats a line
 * pauses between takes, and those retakes are for the take analysis to find, not for this filter to remove.
 */
const LOOP_MAX_GAP_SECONDS = 0.5;
/** The first copy of a loop is dropped too when silence covers at least this share of it. */
const LOOP_SILENT_SHARE = 0.5;
/** Runs spelled out in the note before the rest is only counted. */
const LOOP_NOTE_RUNS = 3;

const CJK = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uac00-\ud7af]/u;
const TERMINAL = /[.?!…。？！]["'”’)\]»」』]*$/u;
/** Recognizer tokens that stand for sound, not speech: `[BLANK_AUDIO]`, `(music)`, `*laughs*`, `♪`, `<noise>`. */
const NON_SPEECH = /^(?:\[[^\]]*\]|\([^)]*\)|\*[^*]*\*|<[^>]*>|[♪♫♬\s]+)$/u;
/** Abbreviations whose full stop does not end a sentence. */
const ABBREVIATION =
  /^(?:mr|mrs|ms|dr|prof|sr|jr|st|vs|etc|e\.g|i\.e|inc|ltd|т\.е|т\.д|т\.п|т\.к|напр|стр|гг|тыс|млн|млрд)\.$|^(?:\p{L}\.){2,}$/iu;

const round3 = (value: number): number => Math.round(value * 1000) / 1000;

interface CleanWord {
  text: string;
  start: number;
  end: number;
}

/** Trims, drops non-speech and empty tokens, orders by time and makes the words strictly ordered and non-overlapping. */
function normalizeWords(raw: SpeechTranscription["words"]): CleanWord[] {
  const cleaned: CleanWord[] = [];
  for (const entry of raw) {
    if (!Number.isFinite(entry.start) || !Number.isFinite(entry.end)) continue;
    const text = entry.text.trim();
    if (text.length === 0 || NON_SPEECH.test(text)) continue;
    const start = round3(Math.max(0, entry.start));
    const end = round3(Math.max(entry.end, start + MIN_WORD_SECONDS));
    if (!/[\p{L}\p{N}]/u.test(text)) {
      // Bare punctuation belongs to the word before it.
      const previous = cleaned[cleaned.length - 1];
      if (previous) previous.text += text;
      continue;
    }
    cleaned.push({ text, start, end });
  }
  cleaned.sort((a, b) => a.start - b.start || a.end - b.end);

  const words: CleanWord[] = [];
  for (const word of cleaned) {
    const previous = words[words.length - 1];
    if (previous && word.start < previous.end) {
      // Overlap: shorten the earlier word when it stays a word, else push this one after it.
      if (word.start - previous.start >= MIN_WORD_SECONDS) previous.end = word.start;
      else {
        word.start = previous.end;
        word.end = round3(Math.max(word.end, word.start + MIN_WORD_SECONDS));
      }
    }
    words.push(word);
  }
  return words;
}

/** Word index ranges (inclusive) of the sentences that terminal punctuation, pauses and the word limit give. */
function sentenceSpans(words: readonly CleanWord[]): Array<[number, number]> {
  // Boundaries that hold whatever the diarization says: punctuation, long pauses, the word limit.
  const endsNaturally = (index: number): boolean => {
    const word = words[index];
    const next = words[index + 1];
    return (
      !word || !next || endsSentence(word.text) || next.start - word.end >= SENTENCE_GAP_SECONDS
    );
  };
  /** Words left in the sentence after `index` when only punctuation and pauses end it, counted up to `limit`. */
  const wordsLeft = (index: number, limit: number): number => {
    let left = 0;
    while (left < limit && !endsNaturally(index + left)) left++;
    return left;
  };
  const spans: Array<[number, number]> = [];
  let first = 0;
  for (const [index, word] of words.entries()) {
    const length = index - first + 1;
    // The word limit never strands one or two words as a sentence of their own.
    const overLimit =
      length >= SENTENCE_MAX_WORDS &&
      (length >= SENTENCE_MAX_WORDS + SENTENCE_MAX_ORPHAN_WORDS ||
        wordsLeft(index, SENTENCE_MAX_ORPHAN_WORDS + 1) > SENTENCE_MAX_ORPHAN_WORDS);
    if (word && (endsNaturally(index) || overLimit)) {
      spans.push([first, index]);
      first = index + 1;
    }
  }
  return spans;
}

/** Lower-cased words without punctuation: "Great team!" and "great, team" read the same. */
function loopTokens(words: readonly CleanWord[]): string[] {
  return words
    .map((word) => word.text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ""))
    .filter((token) => token.length > 0);
}

/** Share of the words two sentences have in common in order (longest common subsequence over the mean length). */
function similarity(a: readonly string[], b: readonly string[]): number {
  if (a.length === 0 || b.length === 0) return 0;
  let previous = new Array<number>(b.length + 1).fill(0);
  for (const x of a) {
    const row = [0];
    for (const [j, y] of b.entries()) {
      row.push(x === y ? (previous[j] ?? 0) + 1 : Math.max(previous[j + 1] ?? 0, row[j] ?? 0));
    }
    previous = row;
  }
  return (2 * (previous[b.length] ?? 0)) / (a.length + b.length);
}

/** `part` is the tail (`end`) or the head (`start`) of `whole`, at least LOOP_MIN_WORDS long. */
function isEdgeOf(
  part: readonly string[],
  whole: readonly string[],
  edge: "start" | "end",
): boolean {
  if (part.length < LOOP_MIN_WORDS || part.length >= whole.length) return false;
  const offset = edge === "end" ? whole.length - part.length : 0;
  return part.every((token, i) => token === whole[offset + i]);
}

const overlap = (a: { start: number; end: number }, b: { start: number; end: number }): number =>
  Math.max(0, Math.min(a.end, b.end) - Math.max(a.start, b.start));

function describeLoop(text: string, copies: number, start: number, end: number): string {
  const shown = text.length > 60 ? `${text.slice(0, 57).trimEnd()}…` : text;
  return `"${shown}" ×${copies} at ${start.toFixed(1)}–${end.toFixed(1)} s`;
}

/**
 * Removes recognizer hallucination loops: the same sentence (at least LOOP_MIN_WORDS words, LOOP_MIN_COPIES or more in
 * a row, near-identical text) that a recognizer repeats window after window over music or noise. The first copy stays
 * (the speech it may stand for), unless silence covers most of it; a half-sentence cut off at either end of the run
 * goes with the copies. Repeats shorter than that, or said only twice, are speech and stay.
 */
function dropLoops(
  words: CleanWord[],
  silence: SilenceMap | null,
): { words: CleanWord[]; report: TranscriptHallucinations | null } {
  const spans = sentenceSpans(words);
  const tokens = spans.map(([from, to]) => loopTokens(words.slice(from, to + 1)));
  const timing = spans.map(([from, to]) => ({
    start: words[from]?.start ?? 0,
    end: words[to]?.end ?? 0,
  }));
  const follows = (a: number, b: number): boolean =>
    (timing[b]?.start ?? 0) - (timing[a]?.end ?? 0) <= LOOP_MAX_GAP_SECONDS;

  const dropped = new Set<number>();
  const notes: string[] = [];
  let runs = 0;
  let droppedSentences = 0;
  let index = 0;
  while (index < spans.length) {
    const head = tokens[index] ?? [];
    let last = index;
    if (head.length >= LOOP_MIN_WORDS) {
      while (
        last + 1 < spans.length &&
        follows(last, last + 1) &&
        similarity(tokens[last] ?? [], tokens[last + 1] ?? []) >= LOOP_SIMILARITY
      )
        last++;
    }
    const copies = last - index + 1;
    if (copies < LOOP_MIN_COPIES) {
      index = last + 1;
      continue;
    }

    const fragments: number[] = [];
    const before = index - 1;
    if (before >= 0 && follows(before, index) && isEdgeOf(tokens[before] ?? [], head, "end"))
      fragments.push(before);
    const after = last + 1;
    if (
      after < spans.length &&
      follows(last, after) &&
      isEdgeOf(tokens[after] ?? [], tokens[last] ?? [], "start")
    )
      fragments.push(after);

    const first = timing[index] ?? { start: 0, end: 0 };
    let silent = 0;
    for (const gap of silence?.silences ?? []) silent += overlap(gap, first);
    const keepFirst = silent < LOOP_SILENT_SHARE * (first.end - first.start);
    const removed = [...fragments, ...Array.from({ length: copies }, (_, k) => index + k)].filter(
      (sentence) => sentence !== index || !keepFirst,
    );
    for (const sentence of removed) dropped.add(sentence);
    runs++;
    droppedSentences += removed.length;
    const text = words
      .slice(spans[index]?.[0], (spans[index]?.[1] ?? 0) + 1)
      .map((word) => word.text)
      .join(" ");
    if (notes.length < LOOP_NOTE_RUNS)
      notes.push(describeLoop(text, copies, first.start, timing[last]?.end ?? first.end));
    index = last + 1;
  }
  if (runs === 0) return { words, report: null };

  const kept: CleanWord[] = [];
  for (const [sentence, [from, to]] of spans.entries()) {
    if (!dropped.has(sentence)) kept.push(...words.slice(from, to + 1));
  }
  const droppedWords = words.length - kept.length;
  const more = runs > notes.length ? `; ${runs - notes.length} more run(s)` : "";
  const note =
    `Dropped ${droppedWords} words of ${runs} repeated-sentence loop${runs === 1 ? "" : "s"} ` +
    `(recognizer hallucination): ${notes.join("; ")}${more}.`;
  return { words: kept, report: { runs, droppedSentences, droppedWords, note } };
}

/** Speaker of the turn that overlaps the word the most; the nearest turn when the word falls in a gap between turns. */
function speakerOf(word: CleanWord, turns: readonly SpeakerTurn[]): string | null {
  let best: SpeakerTurn | null = null;
  let bestOverlap = 0;
  let nearest: SpeakerTurn | null = null;
  let nearestDistance = Infinity;
  for (const turn of turns) {
    const overlap = Math.min(word.end, turn.end) - Math.max(word.start, turn.start);
    if (overlap > bestOverlap) {
      best = turn;
      bestOverlap = overlap;
    }
    const distance = Math.max(turn.start - word.end, word.start - turn.end, 0);
    if (distance < nearestDistance) {
      nearest = turn;
      nearestDistance = distance;
    }
  }
  return (best ?? nearest)?.speaker ?? null;
}

export function joinWords(words: readonly TranscriptWord[]): string {
  let text = "";
  for (const word of words) {
    if (text.length > 0) {
      const glued = CJK.test(text[text.length - 1] ?? "") && CJK.test(word.text[0] ?? "");
      if (!glued) text += " ";
    }
    text += word.text;
  }
  return text;
}

function endsSentence(text: string): boolean {
  return TERMINAL.test(text) && !ABBREVIATION.test(text);
}

function dominantSpeaker(words: readonly TranscriptWord[]): string | null {
  const seconds = new Map<string, number>();
  for (const word of words) {
    if (word.speaker === null) continue;
    seconds.set(word.speaker, (seconds.get(word.speaker) ?? 0) + (word.end - word.start));
  }
  let best: string | null = null;
  let bestSeconds = 0;
  for (const [speaker, total] of seconds) {
    if (total > bestSeconds) {
      best = speaker;
      bestSeconds = total;
    }
  }
  return best;
}

/**
 * Builds the transcript artifact from a recognizer's words: cleans them up and groups them into sentences (terminal
 * punctuation, a pause of 1.2 s or more, 45 words, or a speaker change that has a pause of 0.25 s and three words on
 * each side). Each word first takes the speaker of the diarization turn it overlaps most; a sentence then belongs to
 * its duration-weighted majority speaker and every word in it carries that speaker. A sentence the recognizer looped
 * (see `dropLoops`) is removed first and recorded in `hallucinations`; `silence` tells loops over silence from loops
 * over music or noise.
 */
export function buildTranscript(
  source: string,
  raw: SpeechTranscription["words"],
  language: string | null,
  turns: readonly SpeakerTurn[] | null,
  silence: SilenceMap | null = null,
): TranscriptArtifact {
  const usableTurns = turns && turns.length > 0 ? turns : null;
  const loops = dropLoops(normalizeWords(raw), silence);
  const words: TranscriptWord[] = loops.words.map((word, i) => ({
    i,
    text: word.text,
    start: word.start,
    end: word.end,
    speaker: usableTurns ? speakerOf(word, usableTurns) : null,
  }));

  const spans = sentenceSpans(words);

  const sentences: TranscriptSentence[] = [];
  const close = (from: number, to: number) => {
    const inside = words.slice(from, to + 1);
    const head = inside[0];
    const tail = inside[inside.length - 1];
    if (!head || !tail) return;
    const speaker = dominantSpeaker(inside);
    for (const word of inside) word.speaker = speaker;
    sentences.push({
      id: `s${sentences.length + 1}`,
      start: head.start,
      end: tail.end,
      firstWord: head.i,
      lastWord: tail.i,
      text: joinWords(inside),
      speaker,
    });
  };
  for (const [from, to] of spans) {
    let start = from;
    for (let index = from; index < to; index++) {
      const word = words[index];
      const next = words[index + 1];
      if (
        word &&
        next &&
        next.speaker !== word.speaker &&
        next.start - word.end >= SPEAKER_SPLIT_GAP_SECONDS &&
        index - start + 1 >= SPEAKER_SPLIT_MIN_WORDS &&
        to - index >= SPEAKER_SPLIT_MIN_WORDS
      ) {
        close(start, index);
        start = index + 1;
      }
    }
    close(start, to);
  }

  let speechSeconds = 0;
  for (const word of words) speechSeconds += word.end - word.start;
  const artifact: TranscriptArtifact = {
    source,
    language,
    words,
    sentences,
    speechSeconds: round3(speechSeconds),
  };
  if (loops.report) artifact.hallucinations = loops.report;
  return artifact;
}
