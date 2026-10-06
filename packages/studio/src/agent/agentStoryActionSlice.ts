import type { StoreApi } from "zustand/vanilla";
import type {
  ChatSummary,
  EditorContext,
  StoryAction,
  StoryActionOptions,
} from "@hyperframes/agent-protocol";
import { i18n, t } from "../i18n";
import type { AgentClient } from "./agentClient";
import { describeAgentError } from "./agentErrors";
import type { ActionResult } from "./agentSettingsSlice";
import type { AgentState } from "./agentStore";
import { storyTurnRequest } from "./storyTurn";

/** What the Story workspace asks of the agent: one story-mode turn per action. */
export interface AgentStoryActionSlice {
  /**
   * Runs Review with AI / Build Story / Rebuild affected as a story-mode turn of the open chat (a new chat when
   * none is open), with the user's choices for a build or rebuild.
   */
  runStoryAction(action: StoryAction, options?: StoryActionOptions): Promise<ActionResult>;
}

export interface AgentStoryActionSliceDeps {
  client: AgentClient;
  set: StoreApi<AgentState>["setState"];
  get: StoreApi<AgentState>["getState"];
  captureContext: () => EditorContext | undefined;
  /** Adds or replaces a chat in the list (a chat the action just created). */
  applySummary: (summary: ChatSummary) => void;
  /** Reads the chat again from the server: the stream that would have carried the new turn is not up. */
  resync: (chatId: string) => Promise<void>;
  /** Shows a failed action, first repairing whatever stale view of the world caused it. */
  onActionError: (error: unknown, chatId: string, message?: string) => Promise<void>;
  /** Shows a failure that has no chat to repair (the chat could not be created). */
  fail: (error: unknown, message?: string) => void;
}

export function createAgentStoryActionSlice({
  client,
  set,
  get,
  captureContext,
  applySummary,
  resync,
  onActionError,
  fail,
}: AgentStoryActionSliceDeps): AgentStoryActionSlice {
  return {
    async runStoryAction(action, options) {
      if (get().pending) return { ok: false, message: t("agent.chat.busyOther") };
      let chatId = get().chatId;
      set({ pending: "send", notice: null });
      try {
        if (!chatId) {
          const created = await client.createChat({});
          applySummary(created);
          await get().openChat(created.id);
          chatId = created.id;
        }
        await client.startTurn(
          chatId,
          storyTurnRequest(action, options, captureContext(), i18n.language),
        );
        if (get().streamStatus !== "open") await resync(chatId);
        return { ok: true };
      } catch (error) {
        if (chatId) await onActionError(error, chatId);
        else fail(error);
        return { ok: false, message: describeAgentError(error) };
      } finally {
        set({ pending: null });
      }
    },
  };
}
