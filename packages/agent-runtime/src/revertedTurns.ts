import type { ChatMessage, TurnSummary } from "@hyperframes/agent-protocol";

const PROMPT_EXCERPT_CHARS = 120;

export interface RevertedTurnNotice {
  prompt: string;
  revertedAt: number;
}

function userPromptText(messages: readonly ChatMessage[], turn: TurnSummary): string {
  const message = messages.find((entry) => entry.id === turn.promptMessageId);
  if (message?.role !== "user") return "";
  return message.parts
    .map((part) => (part.type === "text" ? part.text : ""))
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Earlier turns of the chat whose changes were reverted after the most recent previous turn started — the Director's
 * session still holds their messages, and nothing else tells it the edits are gone. A turn reverted before that
 * previous turn started was already announced to the Director by that turn's first prompt.
 */
export function revertedSinceLastPrompt(
  turns: readonly TurnSummary[],
  messages: readonly ChatMessage[],
  currentTurnId: string,
): RevertedTurnNotice[] {
  const previous = turns.filter((turn) => turn.id !== currentTurnId);
  const lastPromptAt = Math.max(...previous.map((turn) => turn.startedAt));
  const notices: RevertedTurnNotice[] = [];
  for (const turn of previous) {
    const checkpoint = turn.checkpoint;
    if (checkpoint?.status !== "reverted" || checkpoint.revertedAt === undefined) continue;
    if (checkpoint.revertedAt <= lastPromptAt) continue;
    notices.push({ prompt: userPromptText(messages, turn), revertedAt: checkpoint.revertedAt });
  }
  return notices.sort((a, b) => a.revertedAt - b.revertedAt);
}

function ago(ms: number): string {
  const minutes = Math.floor(Math.max(0, ms) / 60_000);
  if (minutes < 1) return "less than a minute ago";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours} h ago`;
  return `${Math.floor(hours / 24)} days ago`;
}

function excerpt(prompt: string): string {
  const chars = Array.from(prompt);
  return chars.length > PROMPT_EXCERPT_CHARS
    ? `${chars.slice(0, PROMPT_EXCERPT_CHARS).join("")}…`
    : prompt;
}

/** The prompt block telling the Director which earlier turns were undone; empty when none were. */
export function renderRevertedTurns(notices: readonly RevertedTurnNotice[], now: number): string {
  if (notices.length === 0) return "";
  const lines = notices.map(
    (notice) => `- ${JSON.stringify(excerpt(notice.prompt))} (${ago(now - notice.revertedAt)})`,
  );
  return [
    "<reverted-turns>",
    'The user reverted these earlier turns of this chat ("Revert this turn"): every project change they made is undone. Their messages are still in this conversation, but their edits, imports and story changes are gone — never describe them as present; inspect the project again before relying on them. Files they rendered stay in renders/ (renders are outside project history).',
    ...lines,
    "</reverted-turns>",
  ].join("\n");
}
