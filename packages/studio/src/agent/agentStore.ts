import { createStore, type StoreApi } from "zustand/vanilla";
import {
  applyChatEvent,
  isNextEvent,
  isRecord,
  isThinkingEffort,
  type ActiveTurnInfo,
  type AgentModelCatalog,
  type ChatEvent,
  type ChatMode,
  type ChatState,
  type ChatSummary,
  type EditorContext,
  type ModelSelection,
  type ProjectEvent,
  type RevertMode,
  type StoryAction,
  type StoryActionOptions,
  type ThinkingEffort,
  type TurnSummary,
  type UpdateChatRequest,
} from "@hyperframes/agent-protocol";
import { AgentApiError, isActiveTurn, type AgentClient } from "./agentClient";
import { describeAgentError, describeAgentFailure } from "./agentErrors";
import { findModel, runningTurn } from "./agentSelectors";
import { createAgentQaSlice, type AgentQaSlice } from "./agentQaSlice";
import {
  createAgentSettingsSlice,
  type ActionResult,
  type AgentSettingsSlice,
} from "./agentSettingsSlice";
import {
  openStream,
  type EventSourceFactory,
  type StreamHandle,
  type StreamStatus,
} from "./agentStream";
import { storyTurnRequest } from "./storyTurn";

export type AgentAvailability = "loading" | "ready" | "unavailable";
export type AgentView = "history" | "chat";
export type PendingAction = "create" | "send" | "steer" | "abort" | null;

/** A plain-language message the UI shows inline; dismissed by the user or the next action. */
export interface AgentNotice {
  message: string;
}

export interface RevertUi {
  status: "pending" | "conflict" | "error";
  /** Files that changed after the turn, for a conflict. */
  files: string[];
  message?: string;
}

export interface AgentState extends AgentSettingsSlice, AgentQaSlice {
  availability: AgentAvailability;
  unavailableMessage: string | null;
  chats: ChatSummary[];
  activeTurn: ActiveTurnInfo | null;
  models: AgentModelCatalog | null;
  modelsFailed: boolean;

  view: AgentView;
  chatId: string | null;
  chat: ChatState | null;
  chatLoading: boolean;
  chatError: string | null;
  streamStatus: StreamStatus;

  drafts: Record<string, string>;
  pending: PendingAction;
  notice: AgentNotice | null;
  reverts: Record<string, RevertUi>;

  init(): Promise<void>;
  retry(): Promise<void>;
  refreshChats(): Promise<void>;
  openChat(chatId: string): Promise<void>;
  newChat(): Promise<void>;
  closeChat(): void;
  renameChat(title: string): Promise<void>;
  setModel(model: ModelSelection | null): Promise<void>;
  setThinking(thinking: ThinkingEffort | null): Promise<void>;
  setDraft(text: string): void;
  /** The open chat's mode for its next turns (PATCH `activeMode`). */
  setMode(mode: ChatMode): Promise<void>;
  /**
   * Runs Review with AI / Build Story / Rebuild affected as a story-mode turn of the open chat (a new chat when
   * none is open), with the user's choices for a build or rebuild.
   */
  runStoryAction(action: StoryAction, options?: StoryActionOptions): Promise<ActionResult>;
  /** Starts a turn, or steers the live one when the chat is running. */
  send(): Promise<void>;
  abort(): Promise<void>;
  revert(turnId: string, mode?: RevertMode): Promise<void>;
  dismissRevert(turnId: string): void;
  dismissNotice(): void;
  dispose(): void;
}

export interface AgentStoreDeps {
  client: AgentClient;
  openEventSource: EventSourceFactory;
  /** Read at send/steer time only. May throw or return null; the prompt then goes without context. */
  captureEditorContext?: () => EditorContext | null;
  /** Called once a revert returned `{ok:true}`: the project files were rewritten, refresh the editor. */
  onTurnReverted?: () => void | Promise<void>;
  /** Called when a turn of the open chat ends (completed, failed or aborted): pick up renders it produced. */
  onTurnEnded?: () => void;
}

export type AgentStore = StoreApi<AgentState>;

function isChatEvent(value: unknown): value is ChatEvent {
  return (
    isRecord(value) &&
    typeof value.seq === "number" &&
    typeof value.chatId === "string" &&
    typeof value.type === "string"
  );
}

function isProjectEvent(value: unknown): value is ProjectEvent {
  return isRecord(value) && (value.type === "chat.upserted" || value.type === "project.activeTurn");
}

function parseJson(data: string): unknown {
  try {
    return JSON.parse(data);
  } catch {
    return undefined;
  }
}

function upsertChat(chats: ChatSummary[], chat: ChatSummary): ChatSummary[] {
  const rest = chats.filter((existing) => existing.id !== chat.id);
  return [chat, ...rest].sort((a, b) => b.updatedAt - a.updatedAt);
}

function replaceTurn(turns: TurnSummary[], turn: TurnSummary): TurnSummary[] {
  return turns.map((existing) => (existing.id === turn.id ? turn : existing));
}

function withoutKey<T>(record: Record<string, T>, key: string): Record<string, T> {
  const rest = { ...record };
  delete rest[key];
  return rest;
}

export function createAgentStore(deps: AgentStoreDeps): AgentStore {
  const { client, openEventSource } = deps;
  let projectStream: StreamHandle | null = null;
  let chatStream: StreamHandle | null = null;
  let disposed = false;
  /** Bumped whenever the open chat changes, so a slow response for a chat we left is dropped. */
  let chatEpoch = 0;
  let resyncing = false;

  const store = createStore<AgentState>()((set, get) => {
    const closeChatStream = () => {
      chatStream?.close();
      chatStream = null;
    };

    const patchChat = (chatId: string, update: (state: ChatState) => ChatState) => {
      const current = get().chat;
      if (current?.chat.id === chatId) set({ chat: update(current) });
    };

    const applySummary = (summary: ChatSummary) => {
      set((state) => ({
        chats: upsertChat(state.chats, summary),
        chat: state.chat?.chat.id === summary.id ? { ...state.chat, chat: summary } : state.chat,
      }));
    };

    const markUnavailable = (error: unknown) => {
      projectStream?.close();
      projectStream = null;
      closeChatStream();
      set({ availability: "unavailable", unavailableMessage: describeAgentError(error) });
    };

    const onChatData = (chatId: string, data: string) => {
      const event = parseJson(data);
      const state = get().chat;
      if (!isChatEvent(event) || !state || state.chat.id !== chatId || event.chatId !== chatId) {
        return;
      }
      if (event.seq <= state.lastSeq) return;
      if (!isNextEvent(state, event)) {
        void resync(chatId);
        return;
      }
      const next = applyChatEvent(state, event);
      set({ chat: next });
      if (event.type === "chat.created" || event.type === "chat.updated") applySummary(event.chat);
      if (
        event.type === "turn.completed" ||
        event.type === "turn.failed" ||
        event.type === "turn.aborted"
      ) {
        try {
          deps.onTurnEnded?.();
        } catch {
          // A failed editor refresh must not break the chat stream.
        }
      }
    };

    const openChatStream = (chatId: string) => {
      closeChatStream();
      chatStream = openStream({
        open: openEventSource,
        event: "chat",
        url: () => client.chatEventsUrl(chatId, get().chat?.lastSeq ?? 0),
        onData: (data) => onChatData(chatId, data),
        onStatus: (streamStatus) => set({ streamStatus }),
      });
    };

    /** A gap (or a stream that was down through a restart): the snapshot is the truth again. */
    async function resync(chatId: string): Promise<void> {
      if (resyncing || get().chatId !== chatId) return;
      resyncing = true;
      const epoch = chatEpoch;
      closeChatStream();
      try {
        const snapshot = await client.getChat(chatId);
        if (epoch !== chatEpoch || disposed) return;
        set({ chat: snapshot, chatError: null });
        applySummary(snapshot.chat);
      } catch {
        // The reopened stream keeps trying and reports its own status.
      } finally {
        resyncing = false;
      }
      if (epoch === chatEpoch && !disposed) openChatStream(chatId);
    }

    const openProjectStream = () => {
      projectStream?.close();
      projectStream = openStream({
        open: openEventSource,
        event: "project",
        url: () => client.projectEventsUrl(),
        onData: (data) => {
          const event = parseJson(data);
          if (!isProjectEvent(event)) return;
          if (event.type === "chat.upserted") applySummary(event.chat);
          else set({ activeTurn: event.activeTurn });
        },
        // Project events are not replayed: after a reconnect the list is the truth.
        onOpen: (reconnect) => {
          if (reconnect) void get().refreshChats();
        },
      });
    };

    const fail = (error: unknown, message?: string) => {
      set({ notice: { message: message ?? describeAgentError(error) } });
    };

    /** Shows the failure, first repairing whatever stale view of the world caused it. */
    const onActionError = async (error: unknown, chatId: string, message?: string) => {
      if (error instanceof AgentApiError) {
        if (error.code === "project_busy") {
          const active = error.details?.activeTurn;
          if (isActiveTurn(active)) set({ activeTurn: active });
          void get().refreshChats();
        } else if (error.code === "chat_busy" || error.code === "turn_not_active") {
          await resync(chatId);
        }
      }
      fail(error, message);
    };

    /** A config edit from a settings surface: the surface shows the failure itself, not the composer. */
    const updateOpenChat = async (request: UpdateChatRequest): Promise<ActionResult> => {
      const chatId = get().chatId;
      if (!chatId) return { ok: false, message: "Open a chat first." };
      try {
        applySummary(await client.updateChat(chatId, request));
        return { ok: true };
      } catch (error) {
        if (error instanceof AgentApiError && error.code === "chat_busy") {
          await resync(chatId);
          return { ok: false, message: "The chat is working. Change its agents once it finishes." };
        }
        return { ok: false, message: describeAgentError(error) };
      }
    };

    /** The editor at this moment; a failed capture sends the prompt without context. */
    const captureContext = (): EditorContext | undefined => {
      try {
        return deps.captureEditorContext?.() ?? undefined;
      } catch {
        return undefined;
      }
    };

    return {
      ...createAgentSettingsSlice({
        client,
        set,
        get,
        isDisposed: () => disposed,
        updateOpenChat,
      }),
      ...createAgentQaSlice({ client }),
      availability: "loading",
      unavailableMessage: null,
      chats: [],
      activeTurn: null,
      models: null,
      modelsFailed: false,
      view: "history",
      chatId: null,
      chat: null,
      chatLoading: false,
      chatError: null,
      streamStatus: "closed",
      drafts: {},
      pending: null,
      notice: null,
      reverts: {},

      async init() {
        set({ availability: "loading", unavailableMessage: null });
        const [list, models] = await Promise.allSettled([
          client.listChats(),
          client.listModels(),
          get().loadSettings(),
        ]);
        if (disposed) return;
        if (list.status === "rejected") return markUnavailable(list.reason);
        set({
          availability: "ready",
          chats: list.value.chats,
          activeTurn: list.value.activeTurn,
          models: models.status === "fulfilled" ? models.value : null,
          modelsFailed: models.status === "rejected",
        });
        openProjectStream();
      },

      retry: () => {
        projectStream?.close();
        projectStream = null;
        const { chatId } = get();
        return get()
          .init()
          .then(() => {
            if (chatId && get().availability === "ready") void get().openChat(chatId);
          });
      },

      async refreshChats() {
        try {
          const list = await client.listChats();
          if (disposed) return;
          set({ chats: list.chats, activeTurn: list.activeTurn, availability: "ready" });
        } catch (error) {
          if (!disposed && error instanceof AgentApiError && error.isUnavailable) {
            markUnavailable(error);
          }
        }
      },

      async openChat(chatId) {
        closeChatStream();
        chatEpoch += 1;
        const epoch = chatEpoch;
        const sameChat = get().chat?.chat.id === chatId;
        set({
          view: "chat",
          chatId,
          chat: sameChat ? get().chat : null,
          chatLoading: !sameChat,
          chatError: null,
          notice: null,
        });
        try {
          const snapshot = await client.getChat(chatId);
          if (epoch !== chatEpoch || disposed) return;
          set({ chat: snapshot, chatLoading: false });
          applySummary(snapshot.chat);
          openChatStream(chatId);
        } catch (error) {
          if (epoch !== chatEpoch || disposed) return;
          set({ chatLoading: false, chatError: describeAgentError(error) });
        }
      },

      async newChat() {
        if (get().pending) return;
        set({ pending: "create", notice: null });
        try {
          const created = await client.createChat({});
          if (disposed) return;
          applySummary(created);
          await get().openChat(created.id);
        } catch (error) {
          fail(error);
        } finally {
          set({ pending: null });
        }
      },

      closeChat() {
        chatEpoch += 1;
        closeChatStream();
        set({
          view: "history",
          chatId: null,
          chat: null,
          chatLoading: false,
          chatError: null,
          notice: null,
        });
        void get().refreshChats();
      },

      async renameChat(title) {
        const chatId = get().chatId;
        const trimmed = title.trim();
        if (!chatId || !trimmed || trimmed === get().chat?.chat.title) return;
        try {
          applySummary(await client.updateChat(chatId, { title: trimmed }));
        } catch (error) {
          await onActionError(error, chatId);
        }
      },

      async setModel(model) {
        const { chatId, chat, models } = get();
        if (!chatId || !chat) return;
        // A model that cannot take the chat's current effort resets it to the default.
        const info = findModel(models, model);
        const effort = chat.chat.thinking;
        const dropEffort = info && effort && effort !== "off" && !info.efforts.includes(effort);
        try {
          applySummary(
            await client.updateChat(chatId, { model, ...(dropEffort ? { thinking: null } : {}) }),
          );
        } catch (error) {
          await onActionError(error, chatId);
        }
      },

      async setThinking(thinking) {
        const chatId = get().chatId;
        if (!chatId || (thinking !== null && !isThinkingEffort(thinking))) return;
        try {
          applySummary(await client.updateChat(chatId, { thinking }));
        } catch (error) {
          await onActionError(error, chatId);
        }
      },

      setDraft(text) {
        const chatId = get().chatId;
        if (chatId) set((state) => ({ drafts: { ...state.drafts, [chatId]: text } }));
      },

      async send() {
        const { chatId, chat, drafts, pending } = get();
        const text = chatId ? (drafts[chatId] ?? "").trim() : "";
        if (!chatId || !chat || !text || pending) return;
        const running = runningTurn(chat);
        set({ pending: running ? "steer" : "send", notice: null });
        const editorContext = captureContext();
        try {
          if (running) await client.steerTurn(chatId, running.id, { text, editorContext });
          else await client.startTurn(chatId, { prompt: text, editorContext });
          set((state) => ({ drafts: { ...state.drafts, [chatId]: "" } }));
          // Server-authoritative: the turn arrives on the stream. If the stream is down, ask.
          if (get().streamStatus !== "open") await resync(chatId);
        } catch (error) {
          const finishedFirst = error instanceof AgentApiError && error.code === "turn_not_active";
          await onActionError(
            error,
            chatId,
            finishedFirst
              ? "The agent had just finished. Your message is still in the box; send it to start a new run."
              : undefined,
          );
        } finally {
          set({ pending: null });
        }
      },

      async setMode(mode) {
        const { chatId, chat } = get();
        if (!chatId || !chat || chat.chat.activeMode === mode) return;
        try {
          applySummary(await client.updateChat(chatId, { activeMode: mode }));
        } catch (error) {
          await onActionError(error, chatId);
        }
      },

      async runStoryAction(action, options) {
        if (get().pending) return { ok: false, message: "The agent is busy with another request." };
        let chatId = get().chatId;
        set({ pending: "send", notice: null });
        try {
          if (!chatId) {
            const created = await client.createChat({});
            applySummary(created);
            await get().openChat(created.id);
            chatId = created.id;
          }
          await client.startTurn(chatId, storyTurnRequest(action, options, captureContext()));
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

      async abort() {
        const { chatId, chat, pending } = get();
        const running = runningTurn(chat);
        if (!chatId || !running || pending === "abort") return;
        set({ pending: "abort" });
        try {
          await client.abortTurn(chatId, running.id);
          if (get().streamStatus !== "open") await resync(chatId);
        } catch (error) {
          await onActionError(error, chatId);
        } finally {
          set({ pending: null });
        }
      },

      async revert(turnId, mode) {
        const chatId = get().chatId;
        if (!chatId) return;
        set((state) => ({
          reverts: { ...state.reverts, [turnId]: { status: "pending", files: [] } },
        }));
        try {
          const result = await client.revertTurn(chatId, turnId, mode ? { mode } : {});
          if (result.ok) {
            patchChat(chatId, (state) => ({
              ...state,
              turns: replaceTurn(state.turns, result.turn),
            }));
            set((state) => ({ reverts: withoutKey(state.reverts, turnId) }));
            // Only a completed revert changed files on disk; a conflict or failure changed nothing.
            try {
              await deps.onTurnReverted?.();
            } catch {
              // The revert itself succeeded; a failed editor refresh must not turn it into an error.
            }
          } else {
            set((state) => ({
              reverts: {
                ...state.reverts,
                [turnId]: { status: "conflict", files: result.conflict.files },
              },
            }));
          }
        } catch (error) {
          const message =
            error instanceof AgentApiError
              ? describeAgentFailure(error.code, error.message)
              : describeAgentFailure("internal");
          set((state) => ({
            reverts: { ...state.reverts, [turnId]: { status: "error", files: [], message } },
          }));
        }
      },

      dismissRevert: (turnId) => set((state) => ({ reverts: withoutKey(state.reverts, turnId) })),
      dismissNotice: () => set({ notice: null }),

      dispose() {
        disposed = true;
        chatEpoch += 1;
        projectStream?.close();
        closeChatStream();
        projectStream = null;
      },
    };
  });

  return store;
}
