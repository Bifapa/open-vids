import type { StoreApi } from "zustand/vanilla";
import type { EditorContext } from "@hyperframes/agent-protocol";
import { i18n, t } from "../i18n";
import type { AgentClient } from "./agentClient";
import { describeAgentError } from "./agentErrors";
import type { ActionResult } from "./agentSettingsSlice";
import type { AgentState } from "./agentStore";
import { designTurnRequest, type DesignTurnSpec } from "./designTurn";

/** What the design surface asks of the agent: one turn that creates or edits a design system. */
export interface AgentDesignSlice {
  /**
   * Starts the design turn in the open chat (a new chat when none is open). A refusal comes back as the message to
   * show where the user asked; the chat's own notice carries it too. Never rejects.
   */
  runDesignAction(spec: DesignTurnSpec): Promise<ActionResult>;
}

export interface AgentDesignSliceDeps {
  client: AgentClient;
  set: StoreApi<AgentState>["setState"];
  get: StoreApi<AgentState>["getState"];
  isDisposed: () => boolean;
  captureContext: () => EditorContext | undefined;
  /** Shows a failed action, first repairing whatever stale view of the world caused it. */
  onActionError: (error: unknown, chatId: string, message?: string) => Promise<void>;
}

export function createAgentDesignSlice({
  client,
  set,
  get,
  isDisposed,
  captureContext,
  onActionError,
}: AgentDesignSliceDeps): AgentDesignSlice {
  return {
    async runDesignAction(spec) {
      if (get().pending) return { ok: false, message: t("agent.chat.busyOther") };
      if (!get().chatId) await get().newChat();
      const chatId = get().chatId;
      if (!chatId || isDisposed()) {
        return { ok: false, message: get().notice?.message ?? t("agent.chat.openFirst") };
      }
      set({ pending: "send", notice: null });
      try {
        await client.startTurn(chatId, designTurnRequest(spec, captureContext(), i18n.language));
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
