import { createStore, type StoreApi } from "zustand/vanilla";
import {
  applyChatEvent,
  isNextEvent,
  type ActiveTurnInfo,
  type AgentModelCatalog,
  type ChatMode,
  type ChatState,
  type ChatSummary,
  type EditorContext,
  type StoryAction,
  type StoryActionOptions,
  type UpdateChatRequest,
} from "@hyperframes/agent-protocol";
import { AgentApiError, isActiveTurn, type AgentClient } from "./agentClient";
import { i18n, t } from "../i18n";
import { createDraftSender } from "./agentDraftSend";
import { createAgentAttachmentSlice, type AgentAttachmentSlice } from "./agentAttachmentSlice";
import {
  attachmentReferences,
  attachmentsMentionedIn,
  isUploading,
  skippedFilesNotice,
  type ComposerAttachment,
} from "./composerAttachments";
import { isChatEvent, isProjectEvent, parseJson, upsertChat } from "./agentStoreParsing";
import { describeAgentError } from "./agentErrors";
import { runningTurn } from "./agentSelectors";
import { NEW_CHAT_DRAFT, mergeDraftChoices } from "./agentDraftChat";
import { createAgentComposerSlice, type AgentComposerSlice } from "./agentComposerSlice";
import { createAgentQaSlice, type AgentQaSlice } from "./agentQaSlice";
import { createAgentChatListSlice, type AgentChatListSlice } from "./agentChatListSlice";
import { createAgentRunSlice, type AgentRunSlice } from "./agentRunSlice";
import { createAgentPermissionSlice, type AgentPermissionSlice } from "./agentPermissionSlice";
import { createAgentStoryOfferSlice, type AgentStoryOfferSlice } from "./agentStoryOfferSlice";
import { createAgentRevertSlice, type AgentRevertSlice } from "./agentRevertSlice";
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
import { unsentOf, type SentDraft } from "./sentDraft";

export type AgentAvailability = "loading" | "ready" | "unavailable";
/** `chat` with no `chatId` is the new-chat draft: the chat is created when its first message is sent. */
export type AgentView = "history" | "chat";
export type PendingAction = "create" | "send" | "steer" | "abort" | null;

/** A plain-language message the UI shows inline; dismissed by the user or the next action. */
export interface AgentNotice {
  message: string;
}

export interface AgentState
  extends
    AgentSettingsSlice,
    AgentQaSlice,
    AgentRevertSlice,
    AgentComposerSlice,
    AgentPermissionSlice,
    AgentStoryOfferSlice,
    AgentChatListSlice,
    AgentRunSlice,
    AgentAttachmentSlice {
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

  init(): Promise<void>;
  retry(): Promise<void>;
  refreshChats(): Promise<void>;
  openChat(chatId: string): Promise<void>;
  /** Creates a chat and opens it (Story's Plan with AI). The chat panel's New chat is `startDraft`. */
  newChat(): Promise<void>;
  /** Shows the new-chat draft; its first sent message creates the chat (prototype "New chat"). */
  startDraft(): void;
  closeChat(): void;
  renameChat(title: string): Promise<void>;
  setDraft(text: string): void;
  /**
   * Runs Review with AI / Build Story / Rebuild affected as a story-mode turn of the open chat (a new chat when
   * none is open), with the user's choices for a build or rebuild.
   */
  runStoryAction(action: StoryAction, options?: StoryActionOptions): Promise<ActionResult>;
  /**
   * Starts a turn, or steers the live one when the chat is running; from the draft, creates the chat first and
   * opens it. `mode` is the new turn's mode (story while the Story workspace is shown); true once the server
   * took the message.
   */
  send(options?: { mode?: ChatMode }): Promise<boolean>;
  abort(): Promise<void>;
  dismissNotice(): void;
  dispose(): void;
}

export interface AgentStoreDeps {
  client: AgentClient;
  openEventSource: EventSourceFactory;
  /** Read at send/steer time only. May throw or return null; the prompt then goes without context. */
  captureEditorContext?: () => EditorContext | null;
  /** Called once a revert or Undo revert returned `{ok:true}`: the project files were rewritten, refresh the editor. */
  onTurnReverted?: () => void | Promise<void>;
  /** Called when a turn of the open chat ends (completed, failed or aborted): pick up renders it produced. */
  onTurnEnded?: () => void;
  /** The project has pictures, video or audio: read when a Story offer is accepted. */
  projectHasMedia?: () => boolean;
}

export type AgentStore = StoreApi<AgentState>;

export function createAgentStore(deps: AgentStoreDeps): AgentStore {
  const { client, openEventSource, projectHasMedia = () => false } = deps;
  let projectStream: StreamHandle | null = null;
  let chatStream: StreamHandle | null = null;
  let disposed = false;
  const isDisposed = () => disposed;
  /** Bumped whenever the open chat changes, so a slow response for a chat we left is dropped. */
  let chatEpoch = 0;
  let resyncing = false;

  const store = createStore<AgentState>()((set, get) => {
    const closeChatStream = () => {
      chatStream?.close();
      chatStream = null;
    };

    const applySummary = (summary: ChatSummary) => {
      set((state) => ({
        chats: upsertChat(state.chats, summary),
        chat: state.chat?.chat.id === summary.id ? { ...state.chat, chat: summary } : state.chat,
      }));
    };

    /**
     * The runtime cannot be reached: the screen says so and offers Retry. The streams stay up on purpose — they
     * reconnect on their own, and the project stream's reopen refreshes the list and brings the agent back.
     */
    const markUnavailable = (error: unknown) => {
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
          else if (event.type === "chat.deleted") get().forgetChat(event.chatId);
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

    /** Files that failed to import are not sent: say so, so a missing reference is never a surprise. */
    const noteSkippedFiles = (attachments: readonly ComposerAttachment[]) => {
      const notice = skippedFilesNotice(attachments);
      if (notice && !disposed) set({ notice });
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

    /**
     * A config edit from a settings surface (the surface shows a failure itself, not the composer). In the new-chat
     * draft it only changes the draft's choices, which the chat is created with.
     */
    const updateOpenChat = async (request: UpdateChatRequest): Promise<ActionResult> => {
      const chatId = get().chatId;
      if (!chatId && get().view === "chat") {
        set((state) => ({ draftChoices: mergeDraftChoices(state.draftChoices, request) }));
        return { ok: true };
      }
      if (!chatId) return { ok: false, message: t("agent.chat.openFirst") };
      try {
        applySummary(await client.updateChat(chatId, request));
        return { ok: true };
      } catch (error) {
        if (error instanceof AgentApiError && error.code === "chat_busy") {
          await resync(chatId);
          return { ok: false, message: t("agent.chat.busyAgents") };
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

    const sendFromDraft = createDraftSender({
      client,
      set,
      get,
      isDisposed,
      applySummary,
      captureContext,
      onActionError,
      fail,
    });

    return {
      ...createAgentSettingsSlice({
        client,
        set,
        get,
        isDisposed,
        updateOpenChat,
      }),
      ...createAgentQaSlice({ client }),
      ...createAgentPermissionSlice({ client, get }),
      ...createAgentStoryOfferSlice({ client, set, get, isDisposed, projectHasMedia }),
      ...createAgentAttachmentSlice({ set, get }),
      ...createAgentRevertSlice({ client, set, get, onTurnReverted: deps.onTurnReverted }),
      ...createAgentChatListSlice({ client, set, get, isDisposed, updateOpenChat }),
      ...createAgentRunSlice({ client, set, get, isDisposed, captureContext, onActionError }),
      ...createAgentComposerSlice({
        client,
        set,
        get,
        isDisposed,
        updateOpenChat,
      }),
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
        // With no chat yet, the panel opens on the new-chat draft rather than an empty list.
        if (list.value.chats.length === 0 && get().chatId === null) set({ view: "chat" });
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

      startDraft() {
        chatEpoch += 1;
        closeChatStream();
        set({
          view: "chat",
          chatId: null,
          chat: null,
          chatLoading: false,
          chatError: null,
          notice: null,
          draftChoices: {},
        });
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

      setDraft(text) {
        const key = get().chatId ?? NEW_CHAT_DRAFT;
        set((state) => {
          const current = state.attachments[key] ?? [];
          const kept = attachmentsMentionedIn(current, text);
          return {
            drafts: { ...state.drafts, [key]: text },
            ...(kept !== current && { attachments: { ...state.attachments, [key]: [...kept] } }),
          };
        });
      },

      async send(options) {
        const { chatId, chat, drafts, pending, view, attachments } = get();
        const draftKey = chatId ?? NEW_CHAT_DRAFT;
        const sent: SentDraft = {
          text: drafts[draftKey] ?? "",
          attachments: attachments[draftKey] ?? [],
        };
        const text = sent.text.trim();
        // The message waits for its uploads: a reference to a file that is not in the project yet is no reference.
        if (!text || pending || isUploading(sent.attachments)) return false;
        const references = attachmentReferences(sent.attachments);
        if (!chatId) {
          if (view !== "chat") return false;
          const created = await sendFromDraft(sent, references, options);
          if (created) noteSkippedFiles(sent.attachments);
          return created;
        }
        if (!chat) return false;
        const running = runningTurn(chat);
        set({ pending: running ? "steer" : "send", notice: null });
        const editorContext = captureContext();
        try {
          const userLanguage = i18n.language;
          if (running)
            await client.steerTurn(chatId, running.id, {
              text,
              ...(references.length > 0 && { references }),
              editorContext,
              userLanguage,
            });
          else
            await client.startTurn(chatId, {
              prompt: text,
              ...(references.length > 0 && { references }),
              editorContext,
              userLanguage,
              ...options,
            });
          // The box stays editable while the server answers: only what went out is cleared.
          set((state) => {
            const left = unsentOf(state, chatId, sent);
            return {
              drafts: { ...state.drafts, [chatId]: left.text },
              attachments: { ...state.attachments, [chatId]: left.attachments },
            };
          });
          // Server-authoritative: the turn arrives on the stream. If the stream is down, ask.
          if (get().streamStatus !== "open") await resync(chatId);
          noteSkippedFiles(sent.attachments);
          return true;
        } catch (error) {
          const finishedFirst = error instanceof AgentApiError && error.code === "turn_not_active";
          await onActionError(
            error,
            chatId,
            finishedFirst ? t("agent.chat.justFinished") : undefined,
          );
          return false;
        } finally {
          set({ pending: null });
        }
      },

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
