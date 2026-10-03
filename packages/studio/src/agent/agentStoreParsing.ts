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

export function isProjectEvent(value: unknown): value is ProjectEvent {
  return isRecord(value) && (value.type === "chat.upserted" || value.type === "project.activeTurn");
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
