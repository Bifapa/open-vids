import type { AutonomySettings } from "@hyperframes/agent-protocol";

/**
 * What the user's Autonomy settings mean at run time (Settings → Execution → Autonomy).
 *
 * Locks are never overridden: the editing and story services refuse a change to a locked or hand-set item, and the
 * harness's file-tool guard refuses to rewrite a locked clip. `askBeforeLockedEdits` only decides what the agent does
 * when it meets such an item: stop and ask the user, or leave it alone and report it afterwards. The model sees that in
 * its team brief, in every delegated task, and appended to every refusal.
 *
 * Downloads are gated by the research executor (`research/executor.ts`): with `askBeforeDownloads` an import, a
 * saved website read, a full-access website file download or a page recording waits for the user's approval — a
 * message of the turn ({@link approvesDownload}), a Story resolve turn, or an `asset_download` card in the chat that
 * the call publishes and waits on (without a permission broker the call is refused with
 * {@link downloadApprovalRefusal} instead).
 */

export type TurnAutonomy = Pick<
  AutonomySettings,
  "planApproval" | "askBeforeLockedEdits" | "askBeforeDownloads"
>;

/** What an agent does after a refusal that names a locked or hand-set item. */
export function lockedEditAdvice(askFirst: boolean): string {
  return askFirst
    ? "The user wants to be asked before anything they locked or set by hand is changed: stop work on this item, tell them what you wanted to change and why, and wait for their answer (they can unlock it). Do not look for a way around the lock."
    : "Leave it exactly as it is and do not stop to ask: carry on with the rest of the task and list what you left untouched, and why, in your final reply. Do not look for a way around the lock.";
}

/**
 * A refusal the editing or story service made because of a lock or a user decision: our own `formatError` /
 * `formatStoryError` output, `code (operations[N]): message`.
 */
const LOCK_REFUSAL = /^(?:locked|user_decision)(?: \(operations\[\d+\]\))?: /m;

export function isLockRefusal(text: string): boolean {
  return LOCK_REFUSAL.test(text);
}

const LOCKED_BRIEF_ASK =
  "Locked or hand-set material (clips locked on the timeline, locked Story nodes, decisions the user made by hand) is never changed by an agent; the services refuse it. The user wants to be asked first: when the task needs such a change, stop work on that item, tell the user what you would change and why, and wait for their answer (they can unlock it or allow it in a Story rebuild). Do not look for a way around a lock.";
const LOCKED_BRIEF_LEAVE =
  "Locked or hand-set material (clips locked on the timeline, locked Story nodes, decisions the user made by hand) is never changed by an agent; the services refuse it. The user does not want to be interrupted for it: leave such items exactly as they are, carry on with the rest of the task, and list in your final reply what you left untouched and why. Do not look for a way around a lock.";
const DOWNLOADS_ASK =
  'Downloads: the user wants to approve outside material before it is imported. Whoever imports (Research, or you when Research is off in this chat) searches and imports what the job needs; when the user has not approved downloads in this turn yet, the import call (import_asset, read_website with save, get_website_file with mode "save", record_website) asks them in the chat and waits for their answer — never stop the turn just to ask in text, and do not list candidates and wait for a reply. An explicit instruction to download or import, or the Story workspace\'s Find missing material, already counts as approval (a bare yes does not, and a negation such as "don\'t download yet" cancels it). A restricted-license asset always asks for its own approval. If the user declines, continue without the outside material and say in your report what is missing.';
const DOWNLOADS_FREE =
  "Downloads: the user lets agents import material that fits the request without asking first (the Asset Search policy and the license rules still apply).";

/** The autonomy lines of the Director's `<team>` block. */
export function autonomyTeamLines(autonomy: TurnAutonomy): string[] {
  return [
    autonomy.askBeforeLockedEdits ? LOCKED_BRIEF_ASK : LOCKED_BRIEF_LEAVE,
    autonomy.askBeforeDownloads ? DOWNLOADS_ASK : DOWNLOADS_FREE,
  ];
}

/** The `<autonomy>` block every delegated specialist task carries (Research also gets the download rule). */
export function renderAutonomyBlock(autonomy: TurnAutonomy, agent: string): string {
  const lines = [autonomy.askBeforeLockedEdits ? LOCKED_BRIEF_ASK : LOCKED_BRIEF_LEAVE];
  if (agent === "research")
    lines.push(autonomy.askBeforeDownloads ? DOWNLOADS_ASK : DOWNLOADS_FREE);
  return `<autonomy>\n${lines.join("\n")}\n</autonomy>`;
}

const NOT_LETTER = String.raw`(?<![\p{L}\p{N}'])`;
const NOT_LETTER_AFTER = String.raw`(?![\p{L}\p{N}])`;

/**
 * What a user says to approve a download: an action word aimed at the material (download, import, fetch, grab, bring
 * it in, add it to the project; скачай, загрузи, импортируй, добавь его в проект). A bare yes/ok/sure/да/давай is NOT
 * an approval: it may answer anything, and when the text does not clearly approve the call asks with a card instead.
 * English and Russian; a deterministic text rule, not an understanding of the message.
 */
const APPROVES_DOWNLOAD = [
  String.raw`${NOT_LETTER}(?:download|import|fetch|grab)(?:ing)?${NOT_LETTER_AFTER}`,
  String.raw`${NOT_LETTER}(?:bring|pull)\s+(?:it|them|that|those|these|this)?\s*in${NOT_LETTER_AFTER}`,
  String.raw`${NOT_LETTER}(?:add|put|save)\s+(?:it|them|that|this|those|these)\s+(?:to|into|in)\s+(?:the\s+)?(?:project|timeline|assets)${NOT_LETTER_AFTER}`,
  // Russian imperative and infinitive only, word-anchored: the nouns ("анимация загрузки", "импорт", "подтверждение")
  // and past tense ("загрузил своё видео": the user says what they already uploaded) are not approvals.
  String.raw`${NOT_LETTER}(?:скача(?:й|йте|ть|ем|ю)|скачива(?:й|йте|ть|ем|ю)|скачи(?:ть|те)?|качай(?:те)?|качать)${NOT_LETTER_AFTER}`,
  String.raw`${NOT_LETTER}(?:загрузи(?:ть|те|м)?|загружай(?:те)?|загружать)${NOT_LETTER_AFTER}`,
  String.raw`${NOT_LETTER}(?:импортируй(?:те)?|импортируем|импортировать|импортни(?:те)?|импортнуть)${NOT_LETTER_AFTER}`,
  String.raw`${NOT_LETTER}(?:добавь(?:те)?|добавляй(?:те)?|вставь(?:те)?|сохрани(?:ть|те)?)\s+(?:его|ее|её|их|это|эти|этот|эту|то)(?:\s+(?:себе\s+)?(?:в|на)\s+(?:проект|таймлайн))?${NOT_LETTER_AFTER}`,
  String.raw`${NOT_LETTER}(?:добавь(?:те)?|вставь(?:те)?)\s+(?:[\p{L}\p{N}-]+\s+){0,3}в\s+проект${NOT_LETTER_AFTER}`,
].map((source) => new RegExp(source, "giu"));

/**
 * A negation, a refusal or a postponement: "don't download", "I haven't decided", "isn't", "wouldn't", "neither", "nor",
 * "no, not yet", "never", "without", "wait", "later", "не скачивай", "нет", "пока не", "потом", "без", "никогда" — plus
 * the common one-word negations of a few other languages. Any of them in the same sentence as an action word cancels
 * it, before or after it. Apostrophes are folded to `'` first; the apostrophe may also be missing ("dont", "isnt").
 */
const NEGATION = new RegExp(
  String.raw`${NOT_LETTER}(?:(?:is|are|was|were|have|has|had|would|could|should|must|need|do|does|did|ai)n'?t|won'?t|can'?t|cannot|do\s+not|no|not|neither|nor|never|nothing|nobody|none|without|skip|avoid|stop|cancel|wait|hold\s+off|later|nope|nah|не|нет|нету|ни|ничего|никогда|никто|никак\p{L}*|без|нельзя|пока|позже|потом|погоди\p{L}*|подожди\p{L}*|отмени\p{L}*|отложи\p{L}*|стоп|хватит|nicht|kein\p{L}*|nein|nunca|sin|jamais|pas|sans|non|não|nao|sem|ні)${NOT_LETTER_AFTER}`,
  "iu",
);

/** A sentence ends at . ! ? … before a space or the end, or at ; or a line break (so `example.com` stays whole). */
const SENTENCE_END = /[.!?…]+(?=\s|$)|[;\n]/g;

/** Typographic apostrophes folded to `'`, so "don’t" matches like "don't". */
const plainApostrophes = (text: string): string => text.replace(/[’‘ʼ`]/g, "'");

/**
 * The sentence around `[start, end)`. With `answerFollows`, a plain `?` after the match does not end it: what follows a
 * question ("download it? no, wait") is its answer.
 */
export function sentenceAround(
  text: string,
  start: number,
  end: number,
  answerFollows = false,
): [number, number] {
  let from = 0;
  let to = text.length;
  for (const match of text.matchAll(SENTENCE_END)) {
    const boundary = match.index + match[0].length;
    if (boundary <= start) from = boundary;
    else if (match.index >= end) {
      if (answerFollows && match[0].includes("?") && !/[.…]/.test(match[0])) continue;
      to = boundary;
      break;
    }
  }
  return [from, to];
}

/**
 * Whether the words at `[matchStart, matchEnd)` are cancelled by a negation anywhere else in the same sentence —
 * before or after them: "don't download anything yet", "ok, but не скачивай". A question mark after the match does not
 * close the scope, so the answer to "download it?" ("no, wait") cancels it; a question before the match does. The one
 * tolerant negator behind the download approval and the render request: a miss is harmless because the call then asks
 * with a card, and a wrong "yes" is what costs the user.
 */
export function isNegatedAround(text: string, matchStart: number, matchEnd: number): boolean {
  const folded = plainApostrophes(text);
  const [from, to] = sentenceAround(folded, matchStart, matchEnd, true);
  return NEGATION.test(`${folded.slice(from, matchStart)} ${folded.slice(matchEnd, to)}`);
}

/** "Can you download it?" asks for the action; "should I download it?" or "can we download?" only wonder. */
const POLITE_REQUEST =
  /(?:can|could|would|will)\s+you|please|pls|можешь|можете|мог\s+бы|могли\s+бы|пожалуйста/iu;

export function isIdleQuestion(text: string, start: number, end: number): boolean {
  const [from, to] = sentenceAround(text, start, end);
  const sentence = text.slice(from, to);
  return /\?\s*$/.test(sentence.trimEnd()) && !POLITE_REQUEST.test(sentence);
}

/**
 * Whether a user message approves downloading (importing) outside material: an action word aimed at the material,
 * in a sentence with no negation and that is not a bare question. Mixed messages ("yes, but don't download",
 * "ok, now fix the intro") do not approve; a user who meant it is asked once with a card.
 */
export function approvesDownload(text: string): boolean {
  const folded = plainApostrophes(text);
  for (const pattern of APPROVES_DOWNLOAD) {
    for (const match of folded.matchAll(pattern)) {
      const end = match.index + match[0].length;
      if (isNegatedAround(folded, match.index, end)) continue;
      if (isIdleQuestion(folded, match.index, end)) continue;
      return true;
    }
  }
  return false;
}

/**
 * What the model reads when it tries to download before the user approved and the chat cannot show an approval card
 * (no permission broker): the old text flow, where the user answers in their next message.
 */
export function downloadApprovalRefusal(): string {
  return "Not downloaded: the user asked to be asked before assets are downloaded, and has not approved a download in this turn. Do not import anything yet. Reply with what you found — for each candidate its title, source, license and its status, size, page URL and why it fits — and ask whether to import it (and which). The user answers in their next message; then you may import.";
}

/** What the model reads when the user answered “Don't allow” on the download card: no download is allowed this turn. */
export function downloadDeclinedRefusal(): string {
  return "Not downloaded: the user declined downloads in this turn. Continue without outside material; do not retry any download this turn and do not ask again. Tell the user in your report which material is missing so they can add it themselves or allow downloads next time.";
}
