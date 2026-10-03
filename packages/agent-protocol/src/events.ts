import type {
  ActiveTurnInfo,
  Activity,
  AgentError,
  AgentRun,
  AssistantMessage,
  AssistantMessageStatus,
  ChatMessage,
  ChatSummary,
  ExecutionPlan,
  PermissionRequest,
  StoryOffer,
  TaskMessage,
  TurnCheckpoint,
  TurnSummary,
} from "./types.js";
import type { TurnQaState } from "./qa.js";

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
  /**
   * Text parts of a reply turned out to be an interim progress note: the runtime is about to check the result
   * (render QA) and the final report follows it. Ids of parts that are not text are ignored.
   */
  | { type: "assistant.parts.interim"; messageId: string; partIds: string[] }
  | {
      type: "thinking.updated";
      messageId: string;
      partId: string;
      delta: string;
      done: boolean;
    }
  | { type: "activity.updated"; messageId: string; activity: Activity }
  /**
   * A permission request of the running turn was created or answered: its part appears in the main conversation's
   * assistant message (whichever agent asked) and is updated in place as the user answers or the turn expires it.
   */
  | { type: "permission.updated"; messageId: string; permission: PermissionRequest }
  /**
   * A Story Mode offer of this turn appeared or changed state (accepted, declined, expired): its card lives in the
   * main conversation's assistant message and is updated in place, wherever the answer came from.
   */
  | { type: "storyOffer.updated"; messageId: string; offer: StoryOffer }
  | { type: "message.completed"; messageId: string; status: AssistantMessageStatus }
  | { type: "checkpoint.updated"; turnId: string; checkpoint: TurnCheckpoint }
  /** The Director published or revised the turn's compact plan. */
  | { type: "plan.updated"; turnId: string; plan: ExecutionPlan }
  /** The turn's autonomous render QA progressed (a pass started a phase, finished, or the session ended). */
  | { type: "qa.updated"; turnId: string; qa: TurnQaState }
  /**
   * A delegated run began: its task message and empty reply open the agent's thread, and a delegation part is added
   * to `parentMessageId` (the Director's reply, or the specialist reply that called Jev).
   */
  | {
      type: "agent.started";
      run: AgentRun;
      parentMessageId: string;
      taskMessage: TaskMessage;
      assistantMessage: AssistantMessage;
    }
  /** A run changed while still in flight (queued → running, model resolved). */
  | { type: "agent.updated"; run: AgentRun }
  /** A run ended; `run.status` says how (completed, failed, aborted, cancelled, interrupted). */
  | { type: "agent.completed"; run: AgentRun }
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
