import type { StoreApi } from "zustand/vanilla";
import type { EditorContext, QuestionRequest } from "@hyperframes/agent-protocol";
import { i18n, t } from "../i18n";
import type { AgentClient } from "./agentClient";
import { describeAgentError, describeAgentFailure } from "./agentErrors";
import { runningTurn } from "./agentSelectors";
import type { ActionResult } from "./agentSettingsSlice";
import type { AgentState } from "./agentStore";
import { retryTurnRequest } from "./retryTurn";

/** How the user's answer to a question card ended: the question as the runtime now has it, or why it failed. */
export type QuestionAnswer =
  | { ok: true; question: QuestionRequest }
  | { ok: false; message: string };

/** What the user can do to the turns and runs of the open chat besides starting one. */
export interface AgentRunSlice {
  /**
   * Answers a pending question of a turn with an option or free text. The chat stream carries the updated part (the
   * source of truth); the answer returned here only ends the card's busy state. Never rejects.
   */
  answerQuestion(turnId: string, questionId: string, answer: string): Promise<QuestionAnswer>;
  /**
   * Stops one delegated run of the live turn; the turn and its other runs go on. The stream carries the run's new
   * state; a refusal (the run or turn just ended) is shown as the chat's notice. Never rejects.
   */
  cancelRun(turnId: string, runId: string): Promise<ActionResult>;
  /** Runs a failed turn again: its prompt and files, in the mode it had. A refusal is the chat's notice. */
  retryTurn(turnId: string): Promise<ActionResult>;
}

export interface AgentRunSliceDeps {
  client: AgentClient;
  set: StoreApi<AgentState>["setState"];
  get: StoreApi<AgentState>["getState"];
  isDisposed: () => boolean;
  captureContext: () => EditorContext | undefined;
  /** Shows a failed action, first repairing whatever stale view of the world caused it. */
  onActionError: (error: unknown, chatId: string, message?: string) => Promise<void>;
}

export function createAgentRunSlice({
  client,
  set,
  get,
  isDisposed,
  captureContext,
  onActionError,
}: AgentRunSliceDeps): AgentRunSlice {
  return {
    async answerQuestion(turnId, questionId, answer) {
      const chatId = get().chatId;
      if (!chatId) return { ok: false, message: describeAgentFailure("internal") };
      try {
        const { question } = await client.answerQuestion(chatId, turnId, questionId, answer);
        return { ok: true, question };
      } catch (error) {
        return { ok: false, message: describeAgentError(error) };
      }
    },

    async cancelRun(turnId, runId) {
      const chatId = get().chatId;
      if (!chatId) return { ok: false, message: describeAgentFailure("internal") };
      try {
        await client.cancelRun(chatId, turnId, runId);
        return { ok: true };
      } catch (error) {
        await onActionError(error, chatId);
        return { ok: false, message: describeAgentError(error) };
      }
    },

    async retryTurn(turnId) {
      const { chatId, chat, pending, activeTurn } = get();
      if (!chatId || !chat) return { ok: false, message: t("agent.chat.openFirst") };
      if (pending || activeTurn || runningTurn(chat)) {
        return { ok: false, message: t("agent.chat.busyOther") };
      }
      const failed = chat.turns.find((turn) => turn.id === turnId);
      const request = failed ? retryTurnRequest(chat, failed) : null;
      if (!request) return { ok: false, message: t("agent.chat.retryUnavailable") };
      set({ pending: "send", notice: null });
      try {
        await client.startTurn(chatId, {
          ...request,
          editorContext: captureContext(),
          userLanguage: i18n.language,
        });
        // The turn arrives on the stream; a stream that is not up yet catches up from the snapshot.
        if (!isDisposed() && get().streamStatus !== "open") await get().openChat(chatId);
        return { ok: true };
      } catch (error) {
        if (!isDisposed()) await onActionError(error, chatId);
        return { ok: false, message: describeAgentError(error) };
      } finally {
        if (!isDisposed()) set({ pending: null });
      }
    },
  };
}
