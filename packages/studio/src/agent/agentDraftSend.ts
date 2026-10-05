import type { StoreApi } from "zustand/vanilla";
import type {
  ChatMode,
  ChatSummary,
  EditorContext,
  MessageReference,
} from "@hyperframes/agent-protocol";
import { i18n } from "../i18n";
import type { AgentClient } from "./agentClient";
import { NEW_CHAT_DRAFT, draftCreation } from "./agentDraftChat";
import type { AgentState } from "./agentStore";
import { unsentOf, type SentDraft } from "./sentDraft";

export interface DraftSenderDeps {
  client: AgentClient;
  set: StoreApi<AgentState>["setState"];
  get: StoreApi<AgentState>["getState"];
  isDisposed: () => boolean;
  applySummary: (summary: ChatSummary) => void;
  /** The editor at this moment; a failed capture sends the prompt without context. */
  captureContext: () => EditorContext | undefined;
  /** Shows a failure of a chat's action, first repairing whatever stale view of the world caused it. */
  onActionError: (error: unknown, chatId: string) => Promise<void>;
  /** Shows a failure that has no chat to repair. */
  fail: (error: unknown) => void;
}

/** The draft's first message: the chat is created now, the turn started, then the chat opened. */
export function createDraftSender({
  client,
  set,
  get,
  isDisposed,
  applySummary,
  captureContext,
  onActionError,
  fail,
}: DraftSenderDeps) {
  return async (
    sent: SentDraft,
    references: MessageReference[],
    options?: { mode?: ChatMode },
  ): Promise<boolean> => {
    set({ pending: "send", notice: null });
    let created: ChatSummary | null = null;
    let failure: unknown = null;
    try {
      const { create, update } = draftCreation(get().draftChoices);
      created = await client.createChat(create);
      // The chips' other choices land before the first turn, so it already runs with them.
      if (update) created = await client.updateChat(created.id, update);
      applySummary(created);
      await client.startTurn(created.id, {
        prompt: sent.text.trim(),
        ...(references.length > 0 && { references }),
        editorContext: captureContext(),
        userLanguage: i18n.language,
        ...options,
      });
    } catch (error) {
      failure = error;
    }
    const chatId = created?.id ?? null;
    set((state) => {
      if (!chatId) return { pending: null };
      // The box follows the draft into its chat: all of it when the message did not go out, else only what was
      // typed after Send (the box stays editable while the server answers).
      const left =
        failure === null
          ? unsentOf(state, NEW_CHAT_DRAFT, sent)
          : {
              text: state.drafts[NEW_CHAT_DRAFT] ?? "",
              attachments: state.attachments[NEW_CHAT_DRAFT] ?? [],
            };
      return {
        pending: null,
        draftChoices: {},
        drafts: { ...state.drafts, [NEW_CHAT_DRAFT]: "", [chatId]: left.text },
        attachments: { ...state.attachments, [NEW_CHAT_DRAFT]: [], [chatId]: left.attachments },
      };
    });
    if (chatId && !isDisposed() && get().view === "chat" && get().chatId === null) {
      await get().openChat(chatId);
    }
    if (failure === null) return true;
    if (chatId) await onActionError(failure, chatId);
    else fail(failure);
    return false;
  };
}
