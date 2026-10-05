import {
  isRecord,
  type ChatEvent,
  type ChatSummary,
  type ProjectEvent,
} from "@hyperframes/agent-protocol";

export function isChatEvent(value: unknown): value is ChatEvent {
  return (
    isRecord(value) &&
    typeof value.seq === "number" &&
    typeof value.chatId === "string" &&
    typeof value.type === "string"
  );
}

/** A project event the store folds; one of an unknown type (a newer runtime) is ignored. */
export function isProjectEvent(value: unknown): value is ProjectEvent {
  if (!isRecord(value)) return false;
  if (value.type === "chat.deleted") return typeof value.chatId === "string";
  return value.type === "chat.upserted" || value.type === "project.activeTurn";
}

export function parseJson(data: string): unknown {
  try {
    return JSON.parse(data);
  } catch {
    return undefined;
  }
}

/** The list with `chat` first, replacing its old entry; most recently updated first. */
export function upsertChat(chats: ChatSummary[], chat: ChatSummary): ChatSummary[] {
  const rest = chats.filter((existing) => existing.id !== chat.id);
  return [chat, ...rest].sort((a, b) => b.updatedAt - a.updatedAt);
}
