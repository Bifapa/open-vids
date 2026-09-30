import type {
  SpeakerTurn,
  TranscriptArtifact,
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
 * its duration-weighted majority speaker and every word in it carries that speaker.
 */
export function buildTranscript(
  source: string,
  raw: SpeechTranscription["words"],
  language: string | null,
  turns: readonly SpeakerTurn[] | null,
): TranscriptArtifact {
  const usableTurns = turns && turns.length > 0 ? turns : null;
  const words: TranscriptWord[] = normalizeWords(raw).map((word, i) => ({
    i,
    text: word.text,
    start: word.start,
    end: word.end,
    speaker: usableTurns ? speakerOf(word, usableTurns) : null,
  }));

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
  return { source, language, words, sentences, speechSeconds: round3(speechSeconds) };
}
