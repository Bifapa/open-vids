import type { StoreApi } from "zustand/vanilla";
import type { UpdateChatRequest } from "@hyperframes/agent-protocol";
import { t } from "../i18n";
import { AgentApiError, type AgentClient } from "./agentClient";
import { describeAgentError } from "./agentErrors";
import type { ActionResult } from "./agentSettingsSlice";
import type { AgentState } from "./agentStore";

/** Managing the project's chats from the history list and the chat's options: delete, linked sites, model list. */
export interface AgentChatListSlice {
  /**
   * Deletes a chat and its stored events. A chat that runs a turn cannot be deleted (said in plain language); a
   * chat the user has open closes to the history list. Never rejects.
   */
  deleteChat(chatId: string): Promise<ActionResult>;
  /** Drops a chat that is gone (deleted here or elsewhere): its list entry, its draft and its files. */
  forgetChat(chatId: string): void;
  /**
   * Replaces the open chat's list of linked sites the agents may not use (the user removed them, or allows them
   * again by leaving them out). Never rejects.
   */
  setExcludedSites(sites: string[]): Promise<ActionResult>;
  /** Reads the model catalog again after a failed load; true when it loaded. */
  reloadModels(): Promise<boolean>;
}

export interface AgentChatListSliceDeps {
  client: AgentClient;
  set: StoreApi<AgentState>["setState"];
  get: StoreApi<AgentState>["getState"];
  isDisposed: () => boolean;
  updateOpenChat: (request: UpdateChatRequest) => Promise<ActionResult>;
}

function withoutKey<T>(record: Record<string, T>, key: string): Record<string, T> {
  const rest = { ...record };
  delete rest[key];
  return rest;
}

export function createAgentChatListSlice({
  client,
  set,
  get,
  isDisposed,
  updateOpenChat,
}: AgentChatListSliceDeps): AgentChatListSlice {
  const forgetChat = (chatId: string) => {
    set((state) => ({
      chats: state.chats.filter((chat) => chat.id !== chatId),
      drafts: withoutKey(state.drafts, chatId),
      attachments: withoutKey(state.attachments, chatId),
      threads: withoutKey(state.threads, chatId),
    }));
    if (get().chatId === chatId) get().closeChat();
  };

  return {
    forgetChat,

    async deleteChat(chatId) {
      try {
        await client.deleteChat(chatId);
      } catch (error) {
        if (error instanceof AgentApiError && error.code === "chat_busy") {
          return { ok: false, message: t("agent.chat.deleteBusy") };
        }
        // A chat the runtime no longer has is as good as deleted: drop it from the list.
        if (error instanceof AgentApiError && error.code === "chat_not_found") forgetChat(chatId);
        return { ok: false, message: describeAgentError(error) };
      }
      if (!isDisposed()) forgetChat(chatId);
      return { ok: true };
    },

    async setExcludedSites(sites) {
      if (!get().chatId) return { ok: false, message: t("agent.chat.openFirst") };
      return updateOpenChat({ excludedSites: sites });
    },

    async reloadModels() {
      try {
        const models = await client.listModels();
        if (isDisposed()) return false;
        set({ models, modelsFailed: false });
        return true;
      } catch {
        return false;
      }
    },
  };
}
