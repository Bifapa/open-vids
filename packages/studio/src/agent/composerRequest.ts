import { useEffect } from "react";
import { create } from "zustand";
import { NEW_CHAT_DRAFT, type AgentStore } from "./agentStore";

/**
 * Something outside the chat panel (the inspector, the canvas menu, the Checks dialog) asks the chat to take some
 * text. The agent store is owned by the right-hand panels and outlives the Chat tab, so the request waits here until
 * that store exists; the composer then claims the focus once it shows the new draft.
 */
interface ComposerRequestState {
  /** Text waiting to join the open chat's draft; `send` asks for it to go out as the next message. */
  request: { id: number; text: string; send: boolean } | null;
  /** The draft was filled: the composer takes the focus, caret at the end, as soon as it is on screen. */
  focusPending: boolean;
  ask(text: string, options?: { send?: boolean }): void;
  delivered(id: number): void;
  focused(): void;
}

let nextRequestId = 0;

export const useComposerRequestStore = create<ComposerRequestState>((set) => ({
  request: null,
  focusPending: false,
  ask: (text, options) =>
    set({ request: { id: (nextRequestId += 1), text, send: options?.send === true } }),
  delivered: (id) =>
    set((state) => (state.request?.id === id ? { request: null, focusPending: true } : state)),
  focused: () => set({ focusPending: false }),
}));

/**
 * Adds `text` to the draft of the open chat, or of the new-chat draft; on its own line when something is
 * already typed. Never sends. The composer only exists in the chat view, so history first turns to the draft.
 */
export function appendToDraft(store: AgentStore, text: string): void {
  if (store.getState().view === "history") store.getState().startDraft();
  const { chatId, drafts, setDraft } = store.getState();
  const current = drafts[chatId ?? NEW_CHAT_DRAFT] ?? "";
  if (current.trim().length === 0) setDraft(text);
  else setDraft(current.endsWith("\n") ? `${current}${text}` : `${current}\n${text}`);
}

/**
 * Sends `text` as the next message when nothing stands in the way: no turn running in the project (a message
 * then would steer it) and nothing the user typed in the composer (it would go out with it). Otherwise the text
 * only joins the draft and the user decides. True when it was sent.
 */
export async function sendOrDraft(store: AgentStore, text: string): Promise<boolean> {
  if (store.getState().view === "history") store.getState().startDraft();
  const { chatId, drafts, activeTurn } = store.getState();
  const current = drafts[chatId ?? NEW_CHAT_DRAFT] ?? "";
  if (activeTurn !== null || current.trim().length > 0) {
    appendToDraft(store, text);
    return false;
  }
  store.getState().setDraft(text);
  return store.getState().send();
}

/** Delivers pending composer requests into the project's agent store (mounted once, with the store). */
export function useComposerRequestBridge(store: AgentStore | null): void {
  const request = useComposerRequestStore((state) => state.request);
  useEffect(() => {
    if (!store || !request) return;
    if (request.send) void sendOrDraft(store, request.text);
    else appendToDraft(store, request.text);
    useComposerRequestStore.getState().delivered(request.id);
  }, [store, request]);
}
