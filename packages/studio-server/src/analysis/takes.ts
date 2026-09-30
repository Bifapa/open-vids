import type {
  ShotMap,
  SilenceMap,
  TakeAction,
  TakeAnalysis,
  TakeIssue,
  TakeIssueKind,
  TranscriptArtifact,
} from "@hyperframes/agent-protocol";
import {
  CORRECTION_MARKERS,
  CORRECTION_SENTENCE_CUES,
  CUE_CLOSERS,
  CUE_LEAD_INS,
  CUE_TRAIL,
  INTENTIONAL_REPEATS,
  RESTART_CUES,
  SOFT_FILLERS,
  announcesFullRestart,
  isFillerSound,
  isStopword,
  normalizeToken,
} from "./lexicon.js";

/** A pause this long between words is a break in the delivery (a place a speaker restarts from). */
const BREAK_SECONDS = 0.5;
/** A later sentence only re-says an earlier one when it follows within this many seconds. */
const RETAKE_WINDOW_SECONDS = 20;
const RETAKE_MIN_SIMILARITY = 0.7;
const RETAKE_CUT_SIMILARITY = 0.8;
const RETAKE_MIN_WORDS = 4;
const RETAKE_MAX_LENGTH_RATIO = 1.5;
const CUE_MIN_SIMILARITY = 0.5;
/** How many sentences after a restart cue are searched for the new attempt. */
const CUE_LOOKAHEAD_SENTENCES = 3;
/** An abandoned attempt joins the retake when it says at least this share of the shorter side's content words again. */
const ATTEMPT_MIN_OVERLAP = 0.4;
/** A correction ("Sorry, three months.") retracts the sentence before it when the sentence after says it again this much. */
const CORRECTION_MIN_OVERLAP = 0.6;
const CORRECTION_MAX_WORDS = 6;
const CORRECTION_MAX_GAP_SECONDS = 3;
/** A pause this long ends the delivery an abandoned attempt belongs to. */
const ATTEMPT_PAUSE_SECONDS = 1;
const ATTEMPT_MAX_SENTENCES = 3;
const ATTEMPT_MAX_SECONDS = 30;
/** A run of at least this many words said again shortly after is a restart, not a stutter or an echo. */
const RESTART_RUN_MIN_WORDS = 3;
const RESTART_RUN_MAX_SECONDS = 6;
/** Words broken off after the run the speaker restarted ("... was that I — the biggest mistake ..."). */
const RESTART_RUN_MAX_TAIL = 3;
const PREFIX_RESTART_MIN_WORDS = 4;
const PREFIX_RESTART_MAX_GAP_SECONDS = 3;
/** A repeated sentence that says the earlier one again with at least this share of its content words is a retake. */
const RETAKE_MIN_OVERLAP = 0.85;
const RETAKE_MIN_OVERLAP_WORDS = 4;
const FALSE_START_MAX_WORDS = 7;
const FALSE_START_LOOKAHEAD_WORDS = 14;
/** Repeated words further apart than this are two statements, not a stutter. */
const STUTTER_MAX_GAP_SECONDS = 0.8;
/** A discourse marker ("like", "you know") counts as filler only when set off by at least this much pause. */
const MARKER_SET_OFF_SECONDS = 0.15;

const round2 = (value: number): number => Math.round(value * 100) / 100;
const PUNCT_BREAK = /[.?!…,;:—–-]["'”’)\]»]*$/u;
/** A word that ends in an ellipsis or a dash: the speaker broke off. */
const TRAILS_OFF = /(?:\.\.\.|…|[-—–])["'”’)\]»]*$/u;
const SENTENCE_PUNCT = /[.?!…]["'”’)\]»]*$/u;

interface Draft {
  kind: TakeIssueKind;
  start: number;
  end: number;
  sentences: string[];
  confidence: number;
  action: TakeAction;
  note: string;
  keep: string | null;
}

function withinOneEdit(a: string, b: string): boolean {
  if (Math.abs(a.length - b.length) > 1) return false;
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  if (i === a.length || i === b.length) return true;
  const skipBoth = a.slice(i + 1) === b.slice(i + 1);
  const skipA = a.slice(i + 1) === b.slice(i);
  const skipB = a.slice(i) === b.slice(i + 1);
  return skipBoth || skipA || skipB;
}

/** Same spoken word; long words also match across one letter of inflection or recognition error ("cat"/"cats" do not). */
function sameToken(a: string, b: string): boolean {
  if (a === b) return true;
  return a.length >= 5 && b.length >= 5 && withinOneEdit(a, b);
}

/** Length of the longest common subsequence of two token lists. */
function lcsLength(a: readonly string[], b: readonly string[]): number {
  let previous: number[] = new Array<number>(b.length + 1).fill(0);
  for (const left of a) {
    const row: number[] = [0];
    for (let j = 1; j <= b.length; j++) {
      const right = b[j - 1] ?? "";
      row.push(
        sameToken(left, right)
          ? (previous[j - 1] ?? 0) + 1
          : Math.max(previous[j] ?? 0, row[j - 1] ?? 0),
      );
    }
    previous = row;
  }
  return previous[b.length] ?? 0;
}

const diceSimilarity = (a: readonly string[], b: readonly string[]): number =>
  a.length + b.length === 0 ? 0 : (2 * lcsLength(a, b)) / (a.length + b.length);

function contentOverlap(a: readonly string[], b: readonly string[]): number {
  const other = new Set(b);
  return new Set(a.filter((token) => !isStopword(token) && other.has(token))).size;
}

/** Distinct words that carry meaning: no stopwords, no filler sounds. */
function meaningful(tokens: readonly string[]): string[] {
  const result: string[] = [];
  for (const token of tokens)
    if (!isStopword(token) && !isFillerSound(token) && !result.includes(token)) result.push(token);
  return result;
}

/**
 * Share of the shorter side's meaningful words that the other side also says: 1 when one is contained in the other, so a
 * retake that adds a clause to the sentence it replaces still matches.
 */
function overlapCoefficient(a: readonly string[], b: readonly string[]): number {
  const left = meaningful(a);
  const right = meaningful(b);
  if (left.length === 0 || right.length === 0) return 0;
  const shared = left.filter((token) => right.some((other) => sameToken(token, other))).length;
  return shared / Math.min(left.length, right.length);
}

/** Detects the words a speaker would cut: see the module's callers for the cut/review policy. */
export function detectTakeIssues(input: {
  transcript: TranscriptArtifact;
  silence: SilenceMap | null;
  shots: ShotMap | null;
}): TakeAnalysis {
  const { transcript, silence, shots } = input;
  const { words, sentences } = transcript;
  const count = words.length;
  const tokens = words.map((word) => normalizeToken(word.text));
  const consumed: boolean[] = new Array<boolean>(count).fill(false);
  const sentenceOf: number[] = new Array<number>(count).fill(0);
  for (const [index, sentence] of sentences.entries())
    for (let i = sentence.firstWord; i <= sentence.lastWord; i++) sentenceOf[i] = index;

  // Seconds of pause after each word: the word gap, or more where the silence map says the recognizer stretched a word.
  const pauses: number[] = new Array<number>(count).fill(Infinity);
  const silences = silence?.silences ?? [];
  let cursor = 0;
  for (let i = 0; i + 1 < count; i++) {
    const current = words[i];
    const next = words[i + 1];
    if (!current || !next) continue;
    const from = (current.start + current.end) / 2;
    const to = (next.start + next.end) / 2;
    while (cursor < silences.length && (silences[cursor]?.end ?? Infinity) < from) cursor++;
    let quiet = 0;
    for (let s = cursor; s < silences.length; s++) {
      const range = silences[s];
      if (!range || range.start >= to) break;
      quiet += Math.max(0, Math.min(range.end, to) - Math.max(range.start, from));
    }
    pauses[i] = Math.max(next.start - current.end, quiet);
  }

  const drafts: Draft[] = [];
  const sentenceId = (index: number): string => sentences[index]?.id ?? `s${index + 1}`;
  const idsIn = (first: number, last: number): string[] => {
    const ids: string[] = [];
    for (let i = first; i <= last; i++) {
      const id = sentenceId(sentenceOf[i] ?? 0);
      if (ids[ids.length - 1] !== id) ids.push(id);
    }
    return ids;
  };
  const isConsumed = (first: number, last: number): boolean => {
    for (let i = first; i <= last; i++) if (consumed[i]) return true;
    return false;
  };
  const add = (
    kind: TakeIssueKind,
    first: number,
    last: number,
    confidence: number,
    action: TakeAction,
    note: string,
    sentenceIds: string[],
    keep: string | null,
  ) => {
    const head = words[first];
    const tail = words[last];
    if (!head || !tail) return;
    for (let i = first; i <= last; i++) consumed[i] = true;
    drafts.push({
      kind,
      start: head.start,
      end: tail.end,
      sentences: sentenceIds,
      confidence: round2(Math.min(0.99, Math.max(0.01, confidence))),
      action,
      note,
      keep,
    });
  };
  /** Tokens of a word range as compared between takes: no filler sounds, no empty tokens. */
  const contentTokens = (first: number, last: number): string[] => {
    const result: string[] = [];
    for (let i = first; i <= last; i++) {
      const token = tokens[i];
      if (token && !isFillerSound(token)) result.push(token);
    }
    return result;
  };
  const quote = (first: number, last: number): string => {
    const text = words
      .slice(first, last + 1)
      .map((word) => word.text)
      .join(" ")
      .replace(/[\s.,;:—–-]+$/u, "");
    return `“${text.length > 56 ? `${text.slice(0, 55)}…` : text}”`;
  };
  const speakerOfSentence = (index: number) => sentences[index]?.speaker ?? null;

  // ── Restart cues and the attempt before them ───────────────────────────────

  function detectRestartCues() {
    let i = 0;
    while (i < count) {
      const cue = consumed[i]
        ? undefined
        : RESTART_CUES.find((candidate) =>
            candidate.tokens.every((token, offset) => tokens[i + offset] === token),
          );
      if (!cue) {
        i++;
        continue;
      }
      let first = i;
      let last = i + cue.tokens.length - 1;
      // Extend over a spoken tail ("scratch that, from the top") up to its last closing word.
      let closer = -1;
      for (let k = last + 1; k < count && k <= last + 5; k++) {
        if (sentenceOf[k] !== sentenceOf[last] || consumed[k]) break;
        if (!CUE_TRAIL.has(tokens[k] ?? "") || (pauses[k - 1] ?? 0) >= 0.8) break;
        if (CUE_CLOSERS.has(tokens[k] ?? "")) closer = k;
      }
      // A weak cue that is followed by "start over" / "again" announces a retake by itself.
      const strong = cue.strong || closer > last;
      if (closer > last) last = closer;
      // Lead-ins belong to the cue ("no, no, sorry, let me start over").
      for (let k = first - 1, taken = 0; k >= 0 && taken < 3; k--, taken++) {
        if (consumed[k] || !CUE_LEAD_INS.has(tokens[k] ?? "") || (pauses[k] ?? 0) >= 0.8) break;
        first = k;
      }

      const cueSentence = sentenceOf[first] ?? 0;
      let attempt = attemptBefore(first, cueSentence);
      let following = attempt ? bestRetake(attempt, last, cueSentence) : null;
      // "Let me start over": the whole attempt goes even when the new one is worded differently.
      if (attempt && !following && strong && announcesFullRestart(tokens.slice(first, last + 1)))
        following = nextAttempt(last, cueSentence);
      if (attempt && following) attempt = extendAttempt(attempt, following.sentence);
      const cueText = quote(first, last);
      if (attempt && following) {
        const keepId = sentenceId(following.sentence);
        const badSentences = idsIn(attempt.first, attempt.last);
        const badSentence = sentences[sentenceOf[attempt.first] ?? 0];
        const wholeSentence =
          badSentence?.firstWord === attempt.first && badSentence.lastWord === attempt.last;
        const badLabel = wholeSentence
          ? (badSentences[0] ?? "")
          : `${badSentences[0] ?? ""} (${quote(attempt.first, attempt.last)})`;
        add(
          "retake",
          attempt.first,
          attempt.last,
          following.similarity > 0 ? 0.5 + following.similarity * 0.45 : 0.65,
          "cut",
          following.similarity > 0
            ? `${badLabel} is said again as ${keepId} after the restart cue ${cueText} (${Math.round(following.similarity * 100)}% similar)`
            : `${badLabel} is abandoned at the restart cue ${cueText}; the new attempt is ${keepId}`,
          [...badSentences, ...(badSentences.includes(keepId) ? [] : [keepId])],
          keepId,
        );
        add(
          "restart_cue",
          first,
          last,
          strong ? 0.9 : 0.75,
          "cut",
          `${cueText} announces a retake; the new attempt is ${keepId}`,
          idsIn(first, last),
          keepId,
        );
      } else if (strong) {
        add(
          "restart_cue",
          first,
          last,
          0.85,
          "cut",
          `${cueText} announces a retake (no matching new attempt found)`,
          idsIn(first, last),
          null,
        );
      }
      i = last + 1;
    }
  }

  /** The words said before a cue that the speaker is abandoning: the sentence fragment before it, else the previous sentence. */
  function attemptBefore(first: number, sentenceIndex: number) {
    const sentence = sentences[sentenceIndex];
    if (!sentence) return null;
    let start = sentence.firstWord;
    for (let k = start; k < first; k++) if (consumed[k]) start = k + 1;
    if (start < first && contentTokens(start, first - 1).length >= 2)
      return { first: start, last: first - 1 };
    const previous = sentences[sentenceIndex - 1];
    if (!previous || isConsumed(previous.firstWord, previous.lastWord)) return null;
    const gap = (words[first]?.start ?? 0) - previous.end;
    return gap <= 10 ? { first: previous.firstWord, last: previous.lastWord } : null;
  }

  /** The sentence that follows a cue, taken as the new attempt without comparing it to the abandoned words. */
  function nextAttempt(
    cueLast: number,
    cueSentence: number,
  ): { sentence: number; similarity: number } | null {
    const own = sentences[cueSentence];
    if (!own) return null;
    if (cueLast < own.lastWord && contentTokens(cueLast + 1, own.lastWord).length >= 3)
      return { sentence: cueSentence, similarity: 0 };
    const next = sentences[cueSentence + 1];
    if (
      next &&
      next.speaker === own.speaker &&
      !isConsumed(next.firstWord, next.lastWord) &&
      next.start - (words[cueLast]?.end ?? 0) <= 10
    )
      return { sentence: cueSentence + 1, similarity: 0 };
    return null;
  }

  /**
   * Widens an abandoned attempt that begins at a sentence start over the sentences before it that belong to the same
   * delivery (same speaker, no pause of a second) and say the same thing as the new attempt.
   */
  function extendAttempt(
    attempt: { first: number; last: number },
    keepSentence: number,
  ): { first: number; last: number } {
    const startSentence = sentenceOf[attempt.first] ?? 0;
    const keep = sentences[keepSentence];
    if (!keep || sentences[startSentence]?.firstWord !== attempt.first) return attempt;
    const keepTokens = contentTokens(keep.firstWord, keep.lastWord);
    const endTime = words[attempt.last]?.end ?? 0;
    let first = attempt.first;
    for (
      let k = startSentence - 1, steps = 0;
      k >= 0 && steps < ATTEMPT_MAX_SENTENCES;
      k--, steps++
    ) {
      const earlier = sentences[k];
      if (!earlier || isConsumed(earlier.firstWord, earlier.lastWord)) break;
      if (earlier.speaker !== speakerOfSentence(startSentence)) break;
      if ((words[first]?.start ?? 0) - earlier.end >= ATTEMPT_PAUSE_SECONDS) break;
      if (endTime - earlier.start > ATTEMPT_MAX_SECONDS) break;
      if (
        overlapCoefficient(contentTokens(earlier.firstWord, earlier.lastWord), keepTokens) <
        ATTEMPT_MIN_OVERLAP
      )
        break;
      first = earlier.firstWord;
    }
    return { first, last: attempt.last };
  }

  /** The new attempt after a cue: the rest of the cue's sentence, or one of the next sentences, saying the abandoned words again. */
  function bestRetake(
    attempt: { first: number; last: number },
    cueLast: number,
    cueSentence: number,
  ): { sentence: number; similarity: number } | null {
    const said = contentTokens(attempt.first, attempt.last);
    if (said.length === 0) return null;
    const candidates: Array<{ first: number; last: number; sentence: number }> = [];
    const own = sentences[cueSentence];
    if (own && cueLast < own.lastWord)
      candidates.push({ first: cueLast + 1, last: own.lastWord, sentence: cueSentence });
    for (let s = cueSentence + 1; s <= cueSentence + CUE_LOOKAHEAD_SENTENCES; s++) {
      const sentence = sentences[s];
      if (!sentence) break;
      if (sentence.start - (words[cueLast]?.end ?? 0) > 30) break;
      candidates.push({ first: sentence.firstWord, last: sentence.lastWord, sentence: s });
    }
    let best: { sentence: number; similarity: number } | null = null;
    for (const candidate of candidates) {
      if (isConsumed(candidate.first, candidate.last)) continue;
      const tokensOfCandidate = contentTokens(candidate.first, candidate.last).slice(
        0,
        Math.ceil(said.length * 1.5) + 2,
      );
      const shared = lcsLength(said, tokensOfCandidate);
      if (shared < Math.min(2, said.length)) continue;
      const similarity = shared / said.length;
      if (similarity >= CUE_MIN_SIMILARITY && (!best || similarity > best.similarity))
        best = { sentence: candidate.sentence, similarity };
    }
    return best;
  }

  // ── A short sentence that takes back the one before it ("Sorry, three months.") ─────

  function detectCorrectionSentences() {
    for (const [index, sentence] of sentences.entries()) {
      const size = sentence.lastWord - sentence.firstWord + 1;
      if (size > CORRECTION_MAX_WORDS || isConsumed(sentence.firstWord, sentence.lastWord))
        continue;
      const opens = CORRECTION_SENTENCE_CUES.some((cue) =>
        cue.every((token, offset) => tokens[sentence.firstWord + offset] === token),
      );
      const before = sentences[index - 1];
      const after = sentences[index + 1];
      if (!opens || !before || !after) continue;
      if (before.speaker !== sentence.speaker || after.speaker !== sentence.speaker) continue;
      if (
        sentence.start - before.end > CORRECTION_MAX_GAP_SECONDS ||
        after.start - sentence.end > CORRECTION_MAX_GAP_SECONDS
      )
        continue;
      if (
        isConsumed(before.firstWord, before.lastWord) ||
        isConsumed(after.firstWord, after.lastWord)
      )
        continue;
      const overlap = overlapCoefficient(
        contentTokens(before.firstWord, before.lastWord),
        contentTokens(after.firstWord, after.lastWord),
      );
      if (overlap < CORRECTION_MIN_OVERLAP) continue;
      const attempt = extendAttempt({ first: before.firstWord, last: before.lastWord }, index + 1);
      const bad = idsIn(attempt.first, attempt.last);
      add(
        "retake",
        attempt.first,
        attempt.last,
        0.5 + overlap * 0.4,
        "cut",
        `${bad[0] ?? before.id} is corrected in ${sentence.id} (${quote(sentence.firstWord, sentence.lastWord)}) and said again as ${after.id} (${Math.round(overlap * 100)}% overlap)`,
        [...bad, sentence.id, after.id],
        after.id,
      );
      add(
        "restart_cue",
        sentence.firstWord,
        sentence.lastWord,
        0.8,
        "cut",
        `${quote(sentence.firstWord, sentence.lastWord)} corrects ${before.id}; the new attempt is ${after.id}`,
        [sentence.id],
        after.id,
      );
    }
  }

  // ── A phrase started, dropped and started again ────────────────────────────

  /**
   * A run of words said again within a few seconds, with only filler or cue words (or a broken-off word or two) between
   * the copies: "your, um, no, and the ceiling panel goes right above your head". The first copy and what lies between
   * are cut; the sentence holding the second copy is the keeper.
   */
  function detectRestartedRuns() {
    const isCueWord = (token: string): boolean => isFillerSound(token) || CUE_LEAD_INS.has(token);
    for (let j = 1; j < count; j++) {
      if (consumed[j] || !tokens[j]) continue;
      const start = words[j]?.start ?? 0;
      let best: { first: number; matched: number } | null = null;
      for (let a = j - 1; a >= 0; a--) {
        const candidate = words[a];
        if (!candidate || consumed[a] || start - candidate.start > RESTART_RUN_MAX_SECONDS) break;
        if ((sentenceOf[j] ?? 0) - (sentenceOf[a] ?? 0) > 1) break;
        let matched = 0;
        while (
          a + matched < j &&
          j + matched < count &&
          !consumed[j + matched] &&
          sameToken(tokens[a + matched] ?? "", tokens[j + matched] ?? "")
        )
          matched++;
        if (matched < RESTART_RUN_MIN_WORDS) continue;
        // A sentence that ends inside the first copy is a finished sentence said twice, not a restart.
        let finished = false;
        for (let k = a; k < a + matched - 1; k++)
          if (SENTENCE_PUNCT.test(words[k]?.text ?? "")) finished = true;
        if (finished) continue;
        if (meaningful(tokens.slice(a, a + matched)).length < 2) continue;
        if (!best || matched >= best.matched) best = { first: a, matched };
      }
      if (!best) continue;
      const between = tokens.slice(best.first + best.matched, j);
      const broken = between.filter((token) => !isCueWord(token)).length;
      const lastText = words[j - 1]?.text ?? "";
      const restarted =
        between.length > broken ||
        TRAILS_OFF.test(lastText) ||
        (between.length === 0 && sentenceOf[j - 1] === sentenceOf[j]);
      if (broken > RESTART_RUN_MAX_TAIL || !restarted || isConsumed(best.first, j - 1)) continue;
      const keepId = sentenceId(sentenceOf[j] ?? 0);
      const bad = idsIn(best.first, j - 1);
      add(
        "false_start",
        best.first,
        j - 1,
        0.7 + 0.03 * Math.min(best.matched, 5),
        "cut",
        `${quote(best.first, j - 1)} is dropped and started again in ${keepId}`,
        [...bad, ...(bad.includes(keepId) ? [] : [keepId])],
        keepId,
      );
    }
  }

  /** A sentence broken off that the next sentence starts again, however long the broken one ran ("The biggest mistake I made was that I…"). */
  function detectPrefixRestarts() {
    for (let index = 0; index + 1 < sentences.length; index++) {
      const earlier = sentences[index];
      const later = sentences[index + 1];
      if (!earlier || !later || earlier.speaker !== later.speaker) continue;
      if (later.start - earlier.end > PREFIX_RESTART_MAX_GAP_SECONDS) continue;
      if (
        isConsumed(earlier.firstWord, earlier.lastWord) ||
        isConsumed(later.firstWord, later.lastWord)
      )
        continue;
      const said = contentTokens(earlier.firstWord, earlier.lastWord);
      const again = contentTokens(later.firstWord, later.lastWord);
      if (said.length >= again.length) continue;
      // Broken off: it trails away ("…that I...") or stops on a word no sentence ends on ("…was that I").
      const brokenOff =
        TRAILS_OFF.test(words[earlier.lastWord]?.text ?? "") ||
        isStopword(tokens[earlier.lastWord] ?? "");
      if (!brokenOff) continue;
      let shared = 0;
      while (shared < said.length && sameToken(said[shared] ?? "", again[shared] ?? "")) shared++;
      if (shared < PREFIX_RESTART_MIN_WORDS) continue;
      add(
        "false_start",
        earlier.firstWord,
        earlier.lastWord,
        0.7 + 0.02 * Math.min(shared, 8),
        "cut",
        `${earlier.id} (${quote(earlier.firstWord, earlier.lastWord)}) breaks off and ${later.id} starts again with the same ${shared} words`,
        [earlier.id, later.id],
        later.id,
      );
    }
  }

  // ── A few words abandoned and restarted ────────────────────────────────────

  function detectFalseStarts() {
    let unitStart = 0;
    for (let m = 0; m + 1 < count; m++) {
      const endsSentence = sentenceOf[m] !== sentenceOf[m + 1];
      const isBreak = endsSentence || (pauses[m] ?? 0) >= BREAK_SECONDS;
      if (!isBreak) continue;
      const first = unitStart;
      unitStart = m + 1;
      const lastWord = words[m];
      if (!lastWord || isConsumed(first, m)) continue;
      if (!endsSentence && PUNCT_BREAK.test(lastWord.text)) continue;
      if (speakerOfSentence(sentenceOf[m] ?? 0) !== speakerOfSentence(sentenceOf[m + 1] ?? 0))
        continue;
      if ((pauses[m] ?? 0) > 6) continue;
      const abandoned = contentTokens(first, m);
      if (abandoned.length < 2 || abandoned.length > FALSE_START_MAX_WORDS) continue;
      let end = m + 1;
      while (end < count && end <= m + FALSE_START_LOOKAHEAD_WORDS && !consumed[end]) end++;
      const next = contentTokens(m + 1, end - 1);
      let shared = 0;
      while (
        shared < abandoned.length &&
        shared < next.length &&
        sameToken(abandoned[shared] ?? "", next[shared] ?? "")
      )
        shared++;
      if (shared < 2 || shared * 2 < abandoned.length || shared >= next.length) continue;
      const keepId = sentenceId(sentenceOf[m + 1] ?? 0);
      const bad = idsIn(first, m);
      add(
        "false_start",
        first,
        m,
        0.55 + 0.1 * Math.min(shared, 4),
        "cut",
        `${quote(first, m)} is abandoned and started again in ${keepId}`,
        [...bad, ...(bad.includes(keepId) ? [] : [keepId])],
        keepId,
      );
    }
  }

  // ── A sentence said again ──────────────────────────────────────────────────

  function detectRetakes() {
    const replacedBy = new Map<number, { later: number; similarity: number }>();
    for (const [i, earlier] of sentences.entries()) {
      if (isConsumed(earlier.firstWord, earlier.lastWord)) continue;
      const said = contentTokens(earlier.firstWord, earlier.lastWord);
      if (said.length < RETAKE_MIN_WORDS) continue;
      let best: { later: number; similarity: number } | null = null;
      for (let j = i + 1; j < sentences.length; j++) {
        const later = sentences[j];
        if (!later || later.start - earlier.end > RETAKE_WINDOW_SECONDS) break;
        if (later.speaker !== earlier.speaker || isConsumed(later.firstWord, later.lastWord))
          continue;
        const again = contentTokens(later.firstWord, later.lastWord);
        if (again.length === 0 || said.length > RETAKE_MAX_LENGTH_RATIO * again.length) continue;
        // The later take may add a clause to the earlier one: containment counts, a little less than an exact match.
        const overlap = overlapCoefficient(said, again);
        const contained =
          meaningful(said).length >= RETAKE_MIN_OVERLAP_WORDS && overlap >= RETAKE_MIN_OVERLAP
            ? overlap * 0.9
            : 0;
        const similarity = Math.max(diceSimilarity(said, again), contained);
        if (similarity < RETAKE_MIN_SIMILARITY) continue;
        const contentWords = said.filter((token) => !isStopword(token)).length;
        if (contentOverlap(said, again) < Math.max(1, Math.min(2, contentWords))) continue;
        if (!best || similarity > best.similarity) best = { later: j, similarity };
      }
      if (best) replacedBy.set(i, best);
    }
    for (const [i, found] of replacedBy) {
      const earlier = sentences[i];
      if (!earlier) continue;
      // Said three times: the last one is the keeper.
      let keep = found.later;
      for (let next = replacedBy.get(keep); next; next = replacedBy.get(keep)) keep = next.later;
      const keepId = sentenceId(keep);
      add(
        "retake",
        earlier.firstWord,
        earlier.lastWord,
        found.similarity,
        found.similarity >= RETAKE_CUT_SIMILARITY ? "cut" : "review",
        `${earlier.id} is said again as ${keepId} (${Math.round(found.similarity * 100)}% similar)`,
        [earlier.id, keepId],
        keepId,
      );
    }
  }

  // ── Corrections inside one sentence ("in 2019 — no, 2018") ────────────────

  function detectCorrections() {
    for (let k = 1; k + 1 < count; k++) {
      const marker = CORRECTION_MARKERS.find((candidate) =>
        candidate.tokens.every((token, offset) => tokens[k + offset] === token),
      );
      if (!marker) continue;
      const last = k + marker.tokens.length - 1;
      const before = k - 1;
      const after = last + 1;
      const sentence = sentenceOf[k];
      if (after >= count || sentenceOf[before] !== sentence || sentenceOf[after] !== sentence)
        continue;
      if (isConsumed(before, last)) continue;
      const wasSaid = tokens[before] ?? "";
      const correction = tokens[after] ?? "";
      if (marker.numericOnly) {
        if (!/\d/.test(wasSaid) || !/\d/.test(correction)) continue;
        const setOff =
          PUNCT_BREAK.test(words[before]?.text ?? "") ||
          PUNCT_BREAK.test(words[last]?.text ?? "") ||
          (pauses[before] ?? 0) >= 0.25;
        if (!setOff) continue;
      }
      const id = sentenceId(sentence ?? 0);
      add(
        "retake",
        before,
        last,
        marker.numericOnly ? 0.6 : 0.5,
        "review",
        `${id}: ${quote(before, last)} is corrected inside the sentence to “${words[after]?.text ?? ""}”`,
        [id],
        id,
      );
    }
  }

  // ── Stutters and filler words ──────────────────────────────────────────────

  function detectStutters() {
    const glued = (i: number): boolean =>
      !SENTENCE_PUNCT.test(words[i]?.text ?? "") && !PUNCT_BREAK.test(words[i]?.text ?? "");
    for (let i = 0; i + 1 < count; i++) {
      const token = tokens[i] ?? "";
      if (consumed[i] || !token || isFillerSound(token) || /\d/.test(token)) continue;
      const repeatsWord =
        token === tokens[i + 1] &&
        !INTENTIONAL_REPEATS.has(token) &&
        !consumed[i + 1] &&
        sentenceOf[i] === sentenceOf[i + 1] &&
        glued(i) &&
        (pauses[i] ?? 0) < STUTTER_MAX_GAP_SECONDS;
      if (repeatsWord) {
        let copies = 2;
        while (
          tokens[i + copies] === token &&
          !consumed[i + copies] &&
          sentenceOf[i + copies] === sentenceOf[i] &&
          glued(i + copies - 1) &&
          (pauses[i + copies - 1] ?? 0) < STUTTER_MAX_GAP_SECONDS
        )
          copies++;
        const id = sentenceId(sentenceOf[i] ?? 0);
        add(
          "stutter",
          i,
          i + copies - 2,
          0.85,
          "cut",
          `${quote(i, i)} is repeated (${id})`,
          [id],
          null,
        );
        continue;
      }
      const second = tokens[i + 1] ?? "";
      const phrase =
        i + 3 < count &&
        token !== second &&
        !isFillerSound(second) &&
        tokens[i + 2] === token &&
        tokens[i + 3] === second &&
        !isConsumed(i, i + 3) &&
        sentenceOf[i] === sentenceOf[i + 3] &&
        glued(i + 1) &&
        (pauses[i + 1] ?? 0) < STUTTER_MAX_GAP_SECONDS;
      if (phrase) {
        let copies = 2;
        while (
          tokens[i + 2 * copies] === token &&
          tokens[i + 2 * copies + 1] === second &&
          !isConsumed(i + 2 * copies, i + 2 * copies + 1) &&
          sentenceOf[i + 2 * copies + 1] === sentenceOf[i] &&
          glued(i + 2 * copies - 1) &&
          (pauses[i + 2 * copies - 1] ?? 0) < STUTTER_MAX_GAP_SECONDS
        )
          copies++;
        const id = sentenceId(sentenceOf[i] ?? 0);
        add(
          "stutter",
          i,
          i + 2 * (copies - 1) - 1,
          0.9,
          "cut",
          `${quote(i, i + 1)} is repeated (${id})`,
          [id],
          null,
        );
      }
    }
  }

  function detectFillers() {
    for (let i = 0; i < count; i++) {
      if (consumed[i]) continue;
      const token = tokens[i] ?? "";
      const id = sentenceId(sentenceOf[i] ?? 0);
      if (isFillerSound(token)) {
        add(
          "filler",
          i,
          i,
          0.9,
          "cut",
          `${quote(i, i)} at ${words[i]?.start.toFixed(1)} s (${id})`,
          [id],
          null,
        );
        continue;
      }
      const marker = SOFT_FILLERS.find((phrase) =>
        phrase.every((part, offset) => tokens[i + offset] === part),
      );
      if (!marker) continue;
      const last = i + marker.length - 1;
      if (isConsumed(i, last) || sentenceOf[last] !== sentenceOf[i]) continue;
      const previous = words[i - 1];
      const before =
        i === (sentences[sentenceOf[i] ?? 0]?.firstWord ?? 0) ||
        (previous !== undefined &&
          (PUNCT_BREAK.test(previous.text) || (pauses[i - 1] ?? 0) >= MARKER_SET_OFF_SECONDS));
      const after =
        PUNCT_BREAK.test(words[last]?.text ?? "") || (pauses[last] ?? 0) >= MARKER_SET_OFF_SECONDS;
      if (!before || !after) continue;
      add(
        "filler",
        i,
        last,
        0.3,
        "review",
        `${quote(i, last)} may be filler at ${words[i]?.start.toFixed(1)} s (${id}); it can also be part of the sentence`,
        [id],
        null,
      );
    }
  }

  // ── Picture problems under speech ──────────────────────────────────────────

  function detectVisual() {
    for (const problem of shots?.problems ?? []) {
      let first = -1;
      let last = -1;
      for (const [i, word] of words.entries()) {
        if (word.end <= problem.start || word.start >= problem.end) continue;
        if (first < 0) first = i;
        last = i;
      }
      if (first < 0) continue;
      const ids = idsIn(first, last);
      const label = problem.kind === "black" ? "Picture is black" : "Picture is frozen";
      drafts.push({
        kind: problem.kind,
        start: problem.start,
        end: problem.end,
        sentences: ids,
        confidence: 0.95,
        action: "review",
        note: `${label} from ${problem.start.toFixed(1)} to ${problem.end.toFixed(1)} s while speech continues under it (${ids.join(", ")})`,
        keep: null,
      });
    }
  }

  detectRestartCues();
  detectCorrectionSentences();
  detectRestartedRuns();
  detectPrefixRestarts();
  detectFalseStarts();
  detectRetakes();
  detectCorrections();
  detectStutters();
  detectFillers();
  detectVisual();

  const order = new Map<TakeIssueKind, number>();
  for (const kind of [
    "restart_cue",
    "retake",
    "false_start",
    "stutter",
    "filler",
    "black",
    "frozen",
  ] as const)
    order.set(kind, order.size);
  drafts.sort(
    (a, b) =>
      a.start - b.start || a.end - b.end || (order.get(a.kind) ?? 0) - (order.get(b.kind) ?? 0),
  );
  const issues: TakeIssue[] = drafts.map((draft, index) => ({ id: `t${index + 1}`, ...draft }));
  return { source: transcript.source, issues };
}
