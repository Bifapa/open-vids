import type { AutonomySettings } from "@hyperframes/agent-protocol";

/**
 * What the user's Autonomy settings mean at run time (Settings → Execution → Autonomy).
 *
 * Locks are never overridden: the editing and story services refuse a change to a locked or hand-set item, and the
 * harness's file-tool guard refuses to rewrite a locked clip. `askBeforeLockedEdits` only decides what the agent does
 * when it meets such an item: stop and ask the user, or leave it alone and report it afterwards. The model sees that in
 * its team brief, in every delegated task, and appended to every refusal.
 *
 * Downloads are enforced by the research executor (`research/executor.ts`): with `askBeforeDownloads` an import is
 * refused until the user has approved ({@link approvesDownload}).
 */

export type TurnAutonomy = Pick<AutonomySettings, "askBeforeLockedEdits" | "askBeforeDownloads">;

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
  "Downloads need the user's approval first: Research may search and inspect, but import_asset (and read_website with save) is refused until the user has approved in this turn — an explicit instruction to download or import, a yes, or the Story workspace's Find missing material. Have Research list what it found (title, source, license and its status, size, page URL, why it fits) and report that to the user, then stop and wait for their answer.";
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

const NOT_LETTER = String.raw`(?<![\p{L}\p{N}])`;
const NOT_LETTER_AFTER = String.raw`(?![\p{L}\p{N}])`;

/**
 * Words with which a user approves a download: the action itself (download, import, fetch, grab), a yes, or
 * "add/use/take it". English and Russian. A deterministic text rule, not an understanding of the message.
 */
const APPROVES_DOWNLOAD = [
  String.raw`${NOT_LETTER}(?:download|import|fetch|grab|approve|confirm)(?:s|ed|d|ing)?${NOT_LETTER_AFTER}`,
  String.raw`${NOT_LETTER}(?:yes|yep|yeah|sure|ok|okay|go ahead|proceed|do it)${NOT_LETTER_AFTER}`,
  String.raw`${NOT_LETTER}(?:add|use|take|bring in|get)\s+(?:it|them|that|this|those|these|the\s+(?:first|second|third|last|best|top|\d+))${NOT_LETTER_AFTER}`,
  String.raw`скача`,
  String.raw`загруз`,
  String.raw`импорт`,
  String.raw`подтвержд`,
  String.raw`одобр`,
  String.raw`${NOT_LETTER}(?:да|давай|ок|окей|хорошо|добавь|добавляй|используй|бери|возьми)${NOT_LETTER_AFTER}`,
].map((source) => new RegExp(source, "giu"));

/** A negation shortly before the word ("don't download", "no, not yet", "не скачивай") cancels it. */
const NEGATION_BEFORE = new RegExp(
  String.raw`${NOT_LETTER}(?:don'?t|do not|dont|no|not|never|without|skip|avoid|не|нет|без|нельзя)\s+(?:[\p{L}\p{N}']+\s+){0,2}$`,
  "iu",
);

/** Whether a user message approves downloading (importing) outside material. */
export function approvesDownload(text: string): boolean {
  for (const pattern of APPROVES_DOWNLOAD) {
    for (const match of text.matchAll(pattern)) {
      const before = text.slice(Math.max(0, match.index - 40), match.index);
      if (!NEGATION_BEFORE.test(before)) return true;
    }
  }
  return false;
}

/** What the model reads when it tries to download before the user approved. */
export function downloadApprovalRefusal(): string {
  return "Not downloaded: the user asked to be asked before assets are downloaded, and has not approved a download in this turn. Do not import anything yet. Reply with what you found — for each candidate its title, source, license and its status, size, page URL and why it fits — and ask whether to import it (and which). The user answers in their next message; then you may import.";
}
