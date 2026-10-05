import { isIdleQuestion, isNegatedAround, sentenceAround } from "../autonomy.js";

/**
 * The Director must not start a long render on its own: a render takes minutes per minute of video, so a composition
 * longer than this is only rendered when the user asked for a render, an export or a video file in this turn — or
 * approved it on the `long_render` card the call then shows.
 */
export const LONG_RENDER_SECONDS = 180;

const NOT_LETTER = String.raw`(?<![\p{L}\p{N}])`;
const NOT_LETTER_AFTER = String.raw`(?![\p{L}\p{N}])`;

interface RenderWording {
  readonly pattern: RegExp;
  /** A bare noun or verb ("render", "export", "рендер"): it also names things that happened, so it needs a request context. */
  readonly bare: boolean;
}

const wording = (source: string, bare = false): RenderWording => ({
  pattern: new RegExp(source, "giu"),
  bare,
});

/**
 * English: render(ed/ing), export, an mp4 / video file, encode, "send/give me the video", "make/produce the final
 * video". Russian: рендер…, экспорт…, выгрузи…, видеофайл, "сохрани видео", "пришли/дай ролик", "сделай (финальное)
 * видео". A file name such as `talk.mp4` only names the footage and is not a request. This is a fast path for the
 * obvious wording, not a classifier: a request it misses is asked on a card, which costs one click.
 */
const ASKS_FOR_RENDER: readonly RenderWording[] = [
  wording(String.raw`${NOT_LETTER}render(?:s|ed|ing)?${NOT_LETTER_AFTER}`, true),
  wording(String.raw`${NOT_LETTER}export(?:s|ed|ing)?${NOT_LETTER_AFTER}`, true),
  wording(String.raw`${NOT_LETTER}(?<![\p{L}\p{N}_-]\.)mp4${NOT_LETTER_AFTER}`),
  wording(String.raw`${NOT_LETTER}(?:video|movie|final)\s+file`),
  wording(String.raw`${NOT_LETTER}encode${NOT_LETTER_AFTER}`),
  wording(
    String.raw`${NOT_LETTER}(?:send|give|get|deliver|produce|make|create|save|output|generate)\s+(?:me\s+)?(?:the\s+|a\s+|my\s+)?(?:final\s+|finished\s+|full\s+|complete\s+)(?:video|movie|clip|cut)${NOT_LETTER_AFTER}`,
  ),
  wording(
    String.raw`${NOT_LETTER}(?:send|give|deliver)\s+(?:me\s+)?(?:the\s+)?(?:video|movie|clip)${NOT_LETTER_AFTER}`,
  ),
  // Russian verbs (imperative, infinitive, "let's") are requests by themselves; the nouns need a context.
  wording(String.raw`${NOT_LETTER}(?:от|с)?рендер(?:и(?:ть|те)?|ь(?:те)?|им)${NOT_LETTER_AFTER}`),
  wording(
    String.raw`${NOT_LETTER}экспорт(?:ируй(?:те)?|ировать|ируем|ни(?:те)?)${NOT_LETTER_AFTER}`,
  ),
  wording(String.raw`${NOT_LETTER}рендер(?:а|у|е|ом|ы|ов|инг\p{L}*)?${NOT_LETTER_AFTER}`, true),
  wording(String.raw`${NOT_LETTER}экспорт(?:а|у|е|ом|ы|ов)?${NOT_LETTER_AFTER}`, true),
  wording(String.raw`${NOT_LETTER}выгрузи(?:ть|те)?${NOT_LETTER_AFTER}`),
  wording(String.raw`${NOT_LETTER}выгрузк\p{L}*\s+(?:видео|ролик|файл)`),
  wording(String.raw`видеофайл`),
  wording(
    String.raw`${NOT_LETTER}(?:сохрани(?:ть)?|собери(?:ть)?|сделай(?:те)?|сделать|пришли(?:те)?|дай(?:те)?|отправь(?:те)?|скинь(?:те)?)\s+(?:мне\s+)?(?:готов\p{L}*\s+|финальн\p{L}*\s+|итогов\p{L}*\s+|полн\p{L}*\s+)?(?:видео|ролик|файл|фильм)${NOT_LETTER_AFTER}`,
  ),
];

/**
 * "Make the video shorter" asks for an edit, not a file: the generic "make/сделай the video" phrasings above require
 * a finished/final marker or a delivery verb, and this removes the remaining edit-the-video wording.
 */
const EDIT_OF_VIDEO = new RegExp(
  String.raw`${NOT_LETTER}(?:сделай|сделать|сделайте)\s+(?:мне\s+)?(?:видео|ролик)\s+(?:короче|длиннее|быстрее|медленнее|ярче|темнее|тише|громче)`,
  "iu",
);

/** Words that may stand before a request without changing it: "please render", "ok, now export", "давай, рендер". */
const FILLER_LEAD =
  /^(?:(?:please|pls|ok(?:ay)?|yes|yeah|sure|now|then|also|and|so|just|well|hey|thanks|great|good|perfect|next|finally|alright|go\s+ahead(?:\s+and)?|пожалуйста|ок|окей|да|ага|теперь|потом|затем|тогда|и|а|ну|давай(?:те)?|хорошо|отлично|итак|далее)[\s,.:;!-]*)*$/iu;

/** What may end the words before a bare "render" for it to be a request: "can you", "let's", "start the", "сделай". */
const REQUEST_OPENER =
  /(?:^|[^\p{L}\p{N}])(?:(?:can|could|would|will)\s+you|you\s+can|let.?s|(?:want|need|like|wish|going|ready|time|have|about)\s+(?:you\s+)?to|(?:i|we)\s+(?:want|need)\s+(?:a|an|the|my|our)?|(?:want|need)\s+(?:a|an|the)|(?:start|run|do|make|begin|launch|kick\s+off|trigger|perform|produce)(?:\s+(?:the|a|an|my|our|that|this))?(?:\s+(?:final|full|high[- ]quality|quick|test|proper))?|and|then|also|and\s+then|мне\s+нужен|нужен|нужно|надо|хочу|давай(?:те)?|можешь|можете|пора|(?:сделай|сделайте|запусти|запустите|начни|начните|выполни|выполните)(?:\s+мне)?(?:\s+(?:финальный|полный|быстрый|тестовый))?|и|а|потом|затем)\s*$/iu;

/** What a remark about a render that already happened says next to it: "the render took", "рендер был". */
const REMARK_AFTER =
  /^\s+(?:\p{L}+\s+)?(?:took|takes|taking|was|were|looked|looks|failed|fails|crashed|stalled|hung|hangs|занял\p{L}*|занимает|был\p{L}*|получил\p{L}*|вышел|упал|завис\p{L}*|тормозит|слишком)(?![\p{L}\p{N}])/iu;

/**
 * A bare "render"/"export"/"рендер" is a request when it opens its clause as an imperative ("Render it", "please
 * export") or follows a request opener ("can you", "let's", "start the", "сделай"). "The last render took forever",
 * "I rendered it yesterday" and "рендер был долгим" only talk about one, and a past-tense form never asks.
 */
function bareWordAsks(text: string, start: number, end: number): boolean {
  if (/ed$/iu.test(text.slice(start, end))) return false;
  const [from, to] = sentenceAround(text, start, end);
  const before = text.slice(from, start);
  const lead = before
    .slice(Math.max(before.lastIndexOf(","), before.lastIndexOf(":"), before.lastIndexOf("—")) + 1)
    .trim();
  if (REMARK_AFTER.test(text.slice(end, to))) return false;
  return FILLER_LEAD.test(lead) || REQUEST_OPENER.test(lead);
}

/**
 * Whether a user message asks for a render, an export or a video file (English or Russian wording; the same tolerant
 * negation rule as the download approval: "don't render it yet", "render later" and "без экспорта" ask for nothing; a
 * question that only wonders ("how long does the export take?") and a remark about a render that already happened do
 * not ask either).
 */
export function asksForRender(text: string): boolean {
  if (EDIT_OF_VIDEO.test(text)) return false;
  for (const { pattern, bare } of ASKS_FOR_RENDER) {
    for (const match of text.matchAll(pattern)) {
      const end = match.index + match[0].length;
      if (isNegatedAround(text, match.index, end)) continue;
      if (isIdleQuestion(text, match.index, end)) continue;
      if (bare && !bareWordAsks(text, match.index, end)) continue;
      return true;
    }
  }
  return false;
}

/** The refusal the model reads when it tries to render a long composition unasked and no card could be shown. */
export function longRenderRefusal(duration: number): string {
  const minutes = Number((duration / 60).toFixed(1));
  return `Not rendered: the composition is ${minutes} minutes long and the user has not asked for a render or an export. A render of this length takes many minutes, so do not start one on your own. Finish your work, tell the user the edit is ready and offer to render it (they can ask for "render" or "export").`;
}

/** What the model reads when the user answered "Don't allow" on the long-render card. */
export function longRenderDeclinedRefusal(duration: number): string {
  const minutes = Number((duration / 60).toFixed(1));
  return `Not rendered: the user declined rendering this ${minutes}-minute composition. Do not try again in this turn; tell the user the edit is ready and that they can ask for a render whenever they want one.`;
}
