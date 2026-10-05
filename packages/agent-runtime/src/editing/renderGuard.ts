/**
 * The Director must not start a long render on its own: a render takes minutes per minute of video, so a composition
 * longer than this is only rendered when the user asked for a render, an export or a video file in this turn.
 */
export const LONG_RENDER_SECONDS = 180;

const NOT_LETTER = String.raw`(?<![\p{L}\p{N}])`;

/** English: render(ed/ing), export, an mp4 / video file, encode. Russian: рендер…, экспорт…, выгрузи…, видеофайл, "сохрани видео". A file name such as `talk.mp4` only names the footage and is not a request. */
const ASKS_FOR_RENDER = [
  String.raw`${NOT_LETTER}render(?:s|ed|ing)?(?![\p{L}\p{N}])`,
  String.raw`${NOT_LETTER}export(?:s|ed|ing)?(?![\p{L}\p{N}])`,
  String.raw`${NOT_LETTER}(?<![\p{L}\p{N}_-]\.)mp4(?![\p{L}\p{N}])`,
  String.raw`${NOT_LETTER}(?:video|movie|final)\s+file`,
  String.raw`${NOT_LETTER}encode(?![\p{L}\p{N}])`,
  String.raw`рендер`,
  String.raw`экспорт`,
  String.raw`выгруз`,
  String.raw`видеофайл`,
  String.raw`${NOT_LETTER}(?:сохрани\s+(?:мне\s+)?(?:финальн\p{L}*\s+)?|(?:собери|сделай)\s+(?:мне\s+)?финальн\p{L}*\s+)(?:видео|файл)`,
].map((source) => new RegExp(source, "giu"));

/** A negation shortly before the keyword ("don't render", "no export", "не рендери", "без экспорта") cancels it. */
const NEGATION_BEFORE = new RegExp(
  String.raw`${NOT_LETTER}(?:don'?t|do not|dont|no|not|never|without|skip|avoid|не|без|нельзя)\s+(?:[\p{L}\p{N}']+\s+){0,2}$`,
  "iu",
);

/** Whether a user message explicitly asks for a render, an export or a video file (English or Russian). */
export function asksForRender(text: string): boolean {
  for (const pattern of ASKS_FOR_RENDER) {
    for (const match of text.matchAll(pattern)) {
      const before = text.slice(Math.max(0, match.index - 40), match.index);
      if (!NEGATION_BEFORE.test(before)) return true;
    }
  }
  return false;
}

/** The refusal the model reads when it tries to render a long composition unasked. */
export function longRenderRefusal(duration: number): string {
  const minutes = Number((duration / 60).toFixed(1));
  return `Not rendered: the composition is ${minutes} minutes long and the user has not asked for a render or an export. A render of this length takes many minutes, so do not start one on your own. Finish your work, tell the user the edit is ready and offer to render it (they can ask for "render" or "export").`;
}
