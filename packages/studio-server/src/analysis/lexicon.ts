/**
 * Word lists and token helpers shared by the deterministic analysis modules (take detection, segmentation).
 * English and Russian; extend a list by adding an entry — nothing else depends on its length.
 */

/** Lowercase letters and digits of a spoken word: punctuation, apostrophes and case dropped, `ё` → `е`. */
export function normalizeToken(text: string): string {
  return text
    .toLowerCase()
    .replace(/ё/g, "е")
    .replace(/[^\p{L}\p{N}]+/gu, "");
}

const STOPWORD_LIST = [
  // English
  ...`a about above after again all also am an and any are as at be because been before being below between both but by
  can could did do does doing down during each few for from further had has have having he her here hers herself him
  himself his how i if in into is it its itself just me more most my myself no nor not of off on once only or other
  our ours ourselves out over own same she should so some such than that the their theirs them themselves then there
  these they this those through to too under until up very was we were what when where which while who whom why will
  with would you your yours yourself yourselves im ive id ill youre youve theyre weve were dont doesnt didnt cant
  thats its lets gonna gotta wanna yeah okay ok well right um uh`.split(/\s+/),
  // Russian
  ...`и в во не что он на я с со как а то все она так его но да ты к у же вы за бы по только ее мне было вот от меня
  еще нет о из ему теперь когда даже ну вдруг ли если уже или ни быть был него до вас нибудь опять уж вам ведь там
  потом себя ничего ей может они тут где есть надо ней для мы тебя их чем была сам чтоб без будто чего раз тоже себе
  под будет ж тогда кто этот того потому этого какой совсем ним здесь этом один почти мой тем чтобы нее сейчас были
  куда зачем всех никогда можно при наконец два об другой хоть после над больше тот через эти нас про них какая
  много разве три эту моя впрочем хорошо свою этой перед иногда лучше чуть том нельзя такой им более всегда конечно
  всю между это эта они мы вот как бы значит короче типа`.split(/\s+/),
];

const STOPWORDS: ReadonlySet<string> = new Set(STOPWORD_LIST.map(normalizeToken));

export function isStopword(token: string): boolean {
  return STOPWORDS.has(token);
}

/** Speech filler sounds ("um", "uh", "ээ", "мм"): always safe to cut, one issue per word. */
const FILLER_SOUND = /^(?:u+m+|u+h+m*|e+r+m*|e+h+|h+m+|a+h+|m{2,}|mhm+|э+м*|м{2,}|х+м+|а+х+)$/u;

export function isFillerSound(token: string): boolean {
  return FILLER_SOUND.test(token);
}

/**
 * Discourse markers that are sometimes filler and sometimes content ("I like pizza" vs "it was, like, huge"). Reported
 * as low-confidence `review` issues, only when they stand apart by punctuation or pauses.
 */
export const SOFT_FILLERS: readonly (readonly string[])[] = [
  ["you", "know"],
  ["i", "mean"],
  ["like"],
  ["ну"],
  ["как", "бы"],
  ["типа"],
].map((phrase) => phrase.map(normalizeToken));

export interface RestartCue {
  tokens: readonly string[];
  /**
   * Strong cues announce a retake on their own. Weak cues ("one more time", "ещё раз") are ordinary speech unless the
   * sentence before them is actually said again, so they only count when a similar attempt follows.
   */
  strong: boolean;
}

const RESTARTS_ATTEMPT = /\b(?:start|restart|top|over|redo|take)\b|сначала|заново|перезапиш|дубль/u;

/**
 * The cue text says the whole attempt starts again ("let me start over", "from the top", "давай сначала"), so the words
 * before it are abandoned even where the new attempt is worded quite differently. "scratch that" and "one more time"
 * only retract or repeat the last thing said.
 */
export function announcesFullRestart(cueTokens: readonly string[]): boolean {
  return RESTARTS_ATTEMPT.test(cueTokens.join(" "));
}

function cues(strong: boolean, phrases: readonly string[]): RestartCue[] {
  return phrases.map((phrase) => ({
    tokens: phrase.split(/\s+/).map(normalizeToken),
    strong,
  }));
}

/** Longest phrases first, so "let me start over" wins over "start over". */
export const RESTART_CUES: readonly RestartCue[] = [
  ...cues(true, [
    "let me start over",
    "let me start again",
    "let me start that again",
    "let me say that again",
    "let me say it again",
    "let me try that again",
    "let me try again",
    "let me do that again",
    "let me say that one more time",
    "let me say it one more time",
    "let me try that one more time",
    "let me try it one more time",
    "let me do that one more time",
    "let me do it one more time",
    "let me redo that",
    "let me rephrase that",
    "let me restart",
    "lets start over",
    "lets start again",
    "lets do that again",
    "start over",
    "scratch that",
    "take two",
    "take 2",
    "take three",
    "take 3",
    "давай заново",
    "давайте заново",
    "давай сначала",
    "давайте сначала",
    "начну сначала",
    "начну заново",
    "начнем сначала",
    "начнем заново",
    "перезапишу",
    "перезапишем",
    "запишу заново",
    "дубль два",
    "дубль 2",
  ]),
  ...cues(false, [
    "sorry let me",
    "one more time",
    "start again",
    "from the top",
    "давай еще раз",
    "давайте еще раз",
    "еще раз",
    "сначала",
    "заново",
  ]),
].sort((a, b) => b.tokens.length - a.tokens.length);

/**
 * Openers of a short sentence that corrects the one before it ("Sorry, three months."). Weak on their own ("No, thanks"),
 * so they only count when the sentence before and the one after say nearly the same thing.
 */
export const CORRECTION_SENTENCE_CUES: readonly (readonly string[])[] = [
  ["sorry"],
  ["no"],
  ["wait"],
  ["i", "mean"],
  ["correction"],
  ["простите"],
  ["извините"],
  ["то", "есть"],
  ["нет"],
].map((phrase) => phrase.map(normalizeToken));

/** Words that may precede a cue and belong to it ("no, no, sorry, let me start over"). */
export const CUE_LEAD_INS: ReadonlySet<string> = new Set(
  "sorry oops whoops okay ok no nope wait stop извини извините простите ой нет стоп"
    .split(" ")
    .map(normalizeToken),
);

/** Words that may follow a cue phrase and belong to it ("scratch that, from the top"). */
export const CUE_TRAIL: ReadonlySet<string> = new Set(
  "start over again begin from the top one more time that it say try redo rephrase заново сначала еще раз"
    .split(" ")
    .map(normalizeToken),
);

/** A cue tail is only kept up to the last of these words, so "scratch that the weather…" keeps "the weather". */
export const CUE_CLOSERS: ReadonlySet<string> = new Set(
  "over again top time заново сначала раз".split(" ").map(normalizeToken),
);

/** Words that mark an in-sentence correction ("in 2019, no, 2018"). Value: needs both neighbours to be numbers. */
export const CORRECTION_MARKERS: readonly { tokens: readonly string[]; numericOnly: boolean }[] = [
  { tokens: ["no"], numericOnly: true },
  { tokens: ["нет"], numericOnly: true },
  { tokens: ["sorry"], numericOnly: true },
  { tokens: ["or", "rather"], numericOnly: false },
  { tokens: ["i", "mean"], numericOnly: true },
  { tokens: ["точнее"], numericOnly: false },
  { tokens: ["вернее"], numericOnly: false },
];

/** Words that are deliberately doubled in normal speech, never a stutter. */
export const INTENTIONAL_REPEATS: ReadonlySet<string> = new Set(
  "very no so really bye ha hello hey yes yeah okay ok well now that had is many more never please sorry thank thanks да нет очень так ну вот давай"
    .split(" ")
    .map(normalizeToken),
);
