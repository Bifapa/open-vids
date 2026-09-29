import type {
  ActiveTurnInfo,
  Activity,
  AgentError,
  AssistantMessageStatus,
  ChatMessage,
  ChatSummary,
  TurnCheckpoint,
  TurnSummary,
} from "./types.js";

/**
 * Product-level chat events. They describe what happened in the conversation,
 * never how a harness produced it (no tool names, no raw provider events).
 *
 * Every event of a chat carries a gap-free, strictly increasing `seq`, so a
 * client can resume a stream from the last seq it folded in.
 */
export type ChatEventPayload =
  | { type: "chat.created"; chat: ChatSummary }
  | { type: "chat.updated"; chat: ChatSummary }
  | {
      type: "turn.started";
      turn: TurnSummary;
      /** The user message that opened the turn and the empty assistant message that will stream. */
      promptMessage: ChatMessage;
      assistantMessage: ChatMessage;
    }
  /** A message added mid-turn (a steering instruction). */
  | { type: "message.appended"; message: ChatMessage }
  | { type: "assistant.text.delta"; messageId: string; partId: string; delta: string }
  | {
      type: "thinking.updated";
      messageId: string;
      partId: string;
      delta: string;
      done: boolean;
    }
  | { type: "activity.updated"; messageId: string; activity: Activity }
  | { type: "message.completed"; messageId: string; status: AssistantMessageStatus }
  | { type: "checkpoint.updated"; turnId: string; checkpoint: TurnCheckpoint }
  | { type: "turn.completed"; turn: TurnSummary }
  | { type: "turn.failed"; turn: TurnSummary; error: AgentError }
  | { type: "turn.aborted"; turn: TurnSummary };

export type ChatEventType = ChatEventPayload["type"];

export type ChatEvent = ChatEventPayload & {
  seq: number;
  chatId: string;
  /** Epoch milliseconds, assigned by the runtime. */
  ts: number;
};

/** Project-level notifications: not sequenced, not replayed; clients refetch the chat list on (re)connect. */
export type ProjectEvent =
  | { type: "chat.upserted"; chat: ChatSummary }
  | { type: "project.activeTurn"; activeTurn: ActiveTurnInfo | null };

export const TURN_TERMINAL_EVENTS = ["turn.completed", "turn.failed", "turn.aborted"] as const;

export function isTurnTerminalEvent(
  event: ChatEventPayload,
): event is Extract<ChatEventPayload, { type: (typeof TURN_TERMINAL_EVENTS)[number] }> {
  return (
    event.type === "turn.completed" || event.type === "turn.failed" || event.type === "turn.aborted"
  );
}
