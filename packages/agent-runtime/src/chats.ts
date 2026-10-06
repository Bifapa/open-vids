import { randomUUID } from "node:crypto";
import type {
  ChatEvent,
  ChatEventPayload,
  ChatState,
  ChatSummary,
  CreateChatRequest,
  ProjectEvent,
  SpecialistId,
  UpdateChatRequest,
} from "@hyperframes/agent-protocol";
import {
  SPECIALIST_IDS,
  applyChatEvent,
  emptyChatState,
  foldChatEvents,
  isTurnTerminalEvent,
} from "@hyperframes/agent-protocol";
import type { ProjectScope } from "./checkpointHost.js";
import { chatLinkedSites } from "./research/linkedSites.js";
import { compactEvents, sameValue } from "./store/compact.js";
import { FileChatStore } from "./store/index.js";

export interface ChatServiceOptions {
  now?: () => number;
  ids?: () => string;
  /**
   * Called after a turn's terminal event is applied (completed, failed, aborted — also when crash recovery closes a
   * turn), with the chat as it stands. A failure never fails the event.
   */
  onTurnEnded?: (state: ChatState, turnId: string) => Promise<void>;
}

interface StoredChat {
  /** The chat's log as stored: compacted once a turn has ended, so it is replaced as a whole then. */
  events: ChatEvent[];
  state: ChatState;
}

export interface ChatEventSubscription {
  replay: ChatEvent[];
  unsubscribe: () => void;
}

/** Owns one project's durable chats, event sequencing and project notifications. */
export class ChatService {
  /** Chats whose log has been read (everything that was opened, created or used since start). */
  private readonly chats = new Map<string, StoredChat>();
  /** Chats nothing has touched yet: only their summary is known; the log is read when one is first needed. */
  private readonly summaries = new Map<string, ChatSummary>();
  private readonly eventTails = new Map<string, Promise<void>>();
  private readonly chatListeners = new Map<string, Set<(event: ChatEvent) => void>>();
  private readonly projectListeners = new Set<(event: ProjectEvent) => void>();
  private readonly now: () => number;
  private readonly ids: () => string;
  private readonly onTurnEnded: ChatServiceOptions["onTurnEnded"];
  private readonly turnHooks = new Set<Promise<void>>();

  private constructor(
    readonly scope: ProjectScope,
    readonly store: FileChatStore,
    options: ChatServiceOptions,
  ) {
    this.now = options.now ?? Date.now;
    this.ids = options.ids ?? randomUUID;
    this.onTurnEnded = options.onTurnEnded;
  }

  static async open(
    scope: ProjectScope,
    store: FileChatStore,
    options: ChatServiceOptions = {},
  ): Promise<ChatService> {
    const service = new ChatService(scope, store, options);
    for (const chatId of await store.listChatIds()) {
      const summary = await store.readSummary(chatId);
      if (summary && !summary.recoverable) {
        service.summaries.set(chatId, summary.chat);
        continue;
      }
      const { events, state } = await store.load(chatId);
      if (state) service.chats.set(chatId, { events, state });
    }
    return service;
  }

  /** `enabledAgents`: the specialists a new chat starts with (the global defaults). */
  async create(input: CreateChatRequest, enabledAgents: SpecialistId[] = []): Promise<ChatSummary> {
    const createdAt = this.now();
    const chat: ChatSummary = {
      id: this.ids(),
      projectId: this.scope.projectId,
      title: input.title ?? "New chat",
      createdAt,
      updatedAt: createdAt,
      status: "idle",
      lastTaskSummary: null,
      activeMode: "normal",
      mainAgentModel: input.model ?? null,
      thinking: input.thinking ?? null,
      enabledAgents: [...enabledAgents],
      agentOverrides: {},
    };
    this.chats.set(chat.id, { events: [], state: emptyChatState(chat) });
    try {
      await this.emit(chat.id, { type: "chat.created", chat });
      return chat;
    } catch (error) {
      this.chats.delete(chat.id);
      throw error;
    }
  }

  list(): ChatSummary[] {
    return [
      ...[...this.chats.values()].map((entry) => entry.state.chat),
      ...this.summaries.values(),
    ].sort((left, right) => right.updatedAt - left.updatedAt);
  }

  /**
   * Chats with a turn the log still calls running, or a checkpoint nobody closed: what crash recovery must look at.
   * A chat opened only from its summary has neither (a summary that says otherwise makes `open` read the log in full),
   * so asking this never loads a log.
   */
  recoverableChatIds(): string[] {
    return [...this.chats.entries()]
      .filter(([, record]) => needsRecovery(record.state))
      .map(([chatId]) => chatId);
  }

  get(chatId: string): ChatState | null {
    return this.record(chatId)?.state ?? null;
  }

  events(chatId: string): readonly ChatEvent[] {
    return this.record(chatId)?.events ?? [];
  }

  async update(chatId: string, input: UpdateChatRequest): Promise<ChatSummary | null> {
    const record = this.record(chatId);
    if (!record) return null;
    const current = record.state.chat;
    let agentOverrides = current.agentOverrides ?? {};
    if (input.agentOverrides) {
      agentOverrides = { ...agentOverrides };
      for (const id of SPECIALIST_IDS) {
        const override = input.agentOverrides[id];
        if (override === null) delete agentOverrides[id];
        else if (override) agentOverrides[id] = override;
      }
    }
    const excludedSites =
      input.excludedSites !== undefined ? uniqueSites(input.excludedSites) : current.excludedSites;
    const chat: ChatSummary = {
      ...current,
      ...(input.title !== undefined && { title: input.title }),
      ...(input.model !== undefined && { mainAgentModel: input.model }),
      ...(input.thinking !== undefined && { thinking: input.thinking }),
      ...(input.enabledAgents !== undefined && { enabledAgents: [...input.enabledAgents] }),
      ...(input.activeMode !== undefined && { activeMode: input.activeMode }),
      ...(input.intent !== undefined && { intent: input.intent }),
      ...(input.executionQuality !== undefined && {
        executionQuality: input.executionQuality && structuredClone(input.executionQuality),
      }),
      agentOverrides,
      updatedAt: this.now(),
    };
    if (input.excludedSites !== undefined) {
      if (excludedSites && excludedSites.length > 0) chat.excludedSites = excludedSites;
      else delete chat.excludedSites;
      const linked = linkedSitesOf(record.state, excludedSites ?? []);
      if (linked.length > 0) chat.linkedSites = linked;
      else delete chat.linkedSites;
    }
    await this.emit(chatId, { type: "chat.updated", chat });
    return chat;
  }

  /**
   * Sets or clears the chat's "frame format still to be decided" flag (a start-from-chat project the agent must
   * pick the canvas for). Durable: it rides `chat.updated`, so a later turn of the same chat — plan now, edit
   * after the user approves the plan — still knows the format is open.
   */
  async setCanvasAuto(chatId: string, auto: boolean): Promise<void> {
    const record = this.record(chatId);
    if (!record) return;
    const current = record.state.chat;
    if ((current.canvasAuto ?? false) === auto) return;
    const chat: ChatSummary = { ...current, updatedAt: this.now() };
    if (auto) chat.canvasAuto = true;
    else delete chat.canvasAuto;
    await this.emit(chatId, { type: "chat.updated", chat });
  }

  /**
   * Recomputes the sites the chat counts as linked (from what the user wrote, minus the ones they removed) and
   * publishes the summary when the list changed. Called when a user message is added.
   */
  async refreshLinkedSites(chatId: string): Promise<void> {
    const record = this.record(chatId);
    if (!record) return;
    const current = record.state.chat;
    const linked = linkedSitesOf(record.state, current.excludedSites ?? []);
    if (sameList(linked, current.linkedSites ?? [])) return;
    const chat: ChatSummary = { ...current, updatedAt: this.now() };
    if (linked.length > 0) chat.linkedSites = linked;
    else delete chat.linkedSites;
    await this.emit(chatId, { type: "chat.updated", chat });
  }

  /**
   * Removes a chat for good: its log and every state directory. The caller has made sure it runs no turn. Listeners
   * of the chat's stream just stop receiving; the project hears `chat.deleted`.
   */
  async delete(chatId: string): Promise<boolean> {
    if (!this.record(chatId)) return false;
    // Whatever is still being appended finishes first, so no write recreates the directory afterwards.
    await (this.eventTails.get(chatId) ?? Promise.resolve()).catch(() => undefined);
    await this.store.deleteChat(chatId);
    this.chats.delete(chatId);
    this.summaries.delete(chatId);
    this.eventTails.delete(chatId);
    this.chatListeners.delete(chatId);
    this.publishProject({ type: "chat.deleted", chatId });
    return true;
  }

  /**
   * Records that the user declined Story Mode in this chat: the runtime never offers it here again and tells the
   * Director so. Durable on the chat, like the offer cards themselves.
   */
  async setStoryDeclined(chatId: string): Promise<void> {
    const record = this.record(chatId);
    if (!record) return;
    const current = record.state.chat;
    if (current.storyDeclined === true) return;
    await this.emit(chatId, {
      type: "chat.updated",
      chat: { ...current, storyDeclined: true, updatedAt: this.now() },
    });
  }

  async markWorking(chatId: string, prompt: string): Promise<ChatSummary> {
    const record = this.record(chatId);
    if (!record) throw new Error("Chat does not exist");
    const current = record.state.chat;
    const chat: ChatSummary = {
      ...current,
      title: current.title === "New chat" ? truncate(prompt.trim(), 60) : current.title,
      updatedAt: this.now(),
      status: "working",
      lastTaskSummary: truncate(prompt.trim(), 120),
    };
    await this.emit(chatId, { type: "chat.updated", chat });
    return chat;
  }

  async markStatus(chatId: string, status: ChatSummary["status"]): Promise<ChatSummary> {
    const record = this.record(chatId);
    if (!record) throw new Error("Chat does not exist");
    const chat: ChatSummary = { ...record.state.chat, status, updatedAt: this.now() };
    await this.emit(chatId, { type: "chat.updated", chat });
    return chat;
  }

  async emit(chatId: string, payload: ChatEventPayload): Promise<ChatEvent> {
    const previous = this.eventTails.get(chatId) ?? Promise.resolve();
    const operation = previous
      .catch(() => undefined)
      .then(async () => {
        const record = this.record(chatId);
        if (!record) throw new Error("Chat does not exist");
        const event: ChatEvent = {
          ...payload,
          chatId,
          seq: record.state.lastSeq + 1,
          ts: this.now(),
        };
        await this.store.append(event);
        record.events.push(event);
        record.state = applyChatEvent(record.state, event);
        if (event.type === "chat.created" || event.type === "chat.updated") {
          this.publishProject({ type: "chat.upserted", chat: event.chat });
          this.saveSummary(record);
        }
        for (const listener of this.chatListeners.get(chatId) ?? []) {
          try {
            listener(event);
          } catch {}
        }
        return event;
      });
    const settled = operation.then(
      () => undefined,
      () => undefined,
    );
    this.eventTails.set(chatId, settled);
    let emitted: ChatEvent;
    try {
      emitted = await operation;
    } finally {
      if (this.eventTails.get(chatId) === settled) this.eventTails.delete(chatId);
    }
    if (isTurnTerminalEvent(emitted)) this.queueCompaction(chatId);
    if (isTurnTerminalEvent(emitted) && this.onTurnEnded) {
      // Not awaited: the turn's end must not wait on the journal's disk. `settleTurnHooks` and `drain` do.
      const state = this.chats.get(chatId)?.state;
      if (state) {
        const hook = this.onTurnEnded(state, emitted.turn.id).catch(() => undefined);
        this.turnHooks.add(hook);
        void hook.finally(() => this.turnHooks.delete(hook));
      }
    }
    return emitted;
  }

  /** The chat's log, read now if this is the first time anything needs it. Null when there is no such chat. */
  private record(chatId: string): StoredChat | null {
    const loaded = this.chats.get(chatId);
    if (loaded) return loaded;
    if (!this.summaries.has(chatId)) return null;
    this.summaries.delete(chatId);
    const { events, state } = this.store.loadSync(chatId);
    if (!state) return null;
    const record: StoredChat = { events, state };
    this.chats.set(chatId, record);
    return record;
  }

  /** Keeps the chat's summary beside its log current (best effort: a stale one is detected by size and ignored). */
  private saveSummary(record: StoredChat): void {
    void this.store
      .writeSummary(
        record.state.chat,
        record.state.lastSeq,
        this.now(),
        needsRecovery(record.state),
      )
      .catch(() => undefined);
  }

  /** After a turn ended: collapses its streaming deltas and update chatter in the log, behind the events in flight. */
  private queueCompaction(chatId: string): void {
    const previous = this.eventTails.get(chatId) ?? Promise.resolve();
    const task = previous.then(() => this.compact(chatId)).catch(() => undefined);
    this.eventTails.set(chatId, task);
    void task.finally(() => {
      if (this.eventTails.get(chatId) === task) this.eventTails.delete(chatId);
    });
  }

  /**
   * Rewrites the log as {@link compactEvents} left it, but only when it folds to exactly the state in memory; any
   * difference keeps the log as it is.
   */
  private async compact(chatId: string): Promise<void> {
    const record = this.chats.get(chatId);
    if (!record) return;
    const compacted = compactEvents(record.events);
    if (compacted.length === record.events.length) return;
    const folded = foldChatEvents(compacted);
    if (!folded || !sameValue(folded, record.state)) return;
    await this.store.replace(chatId, compacted);
    record.events = compacted;
    await this.store.writeSummary(
      record.state.chat,
      record.state.lastSeq,
      this.now(),
      needsRecovery(record.state),
    );
  }

  /**
   * Waits until every queued event (including fire-and-forget `onModel` updates) reached the store. Shutdown and
   * test teardown drain before deleting directories, so no append can still be in flight when its directory goes.
   */
  async drain(): Promise<void> {
    while (this.eventTails.size > 0 || this.turnHooks.size > 0) {
      await Promise.allSettled([...this.eventTails.values(), ...this.turnHooks]);
    }
    await this.store.drain();
  }

  /** Waits for the `onTurnEnded` calls in flight (a report that follows a turn's end must include its lines). */
  async settleTurnHooks(): Promise<void> {
    await Promise.allSettled([...this.turnHooks]);
  }

  subscribeChat(
    chatId: string,
    after: number,
    listener: (event: ChatEvent) => void,
  ): ChatEventSubscription {
    const record = this.record(chatId);
    if (!record) return { replay: [], unsubscribe: () => undefined };
    const listeners = this.chatListeners.get(chatId) ?? new Set<(event: ChatEvent) => void>();
    listeners.add(listener);
    this.chatListeners.set(chatId, listeners);
    return {
      replay: record.events.filter((event) => event.seq > after),
      unsubscribe: () => {
        listeners.delete(listener);
        if (listeners.size === 0) this.chatListeners.delete(chatId);
      },
    };
  }

  subscribeProject(listener: (event: ProjectEvent) => void): () => void {
    this.projectListeners.add(listener);
    return () => this.projectListeners.delete(listener);
  }

  publishProject(event: ProjectEvent): void {
    for (const listener of this.projectListeners) {
      try {
        listener(event);
      } catch {}
    }
  }
}

function needsRecovery(state: ChatState): boolean {
  return state.turns.some(
    (turn) => turn.status === "running" || turn.checkpoint?.status === "active",
  );
}

function truncate(value: string, limit: number): string {
  if (value.length <= limit) return value;
  return `${value.slice(0, limit - 1).trimEnd()}…`;
}

function uniqueSites(sites: readonly string[]): string[] {
  return [...new Set(sites.map((site) => site.trim().toLowerCase()).filter(Boolean))];
}

function sameList(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((entry, index) => entry === right[index]);
}

/** The user's own words in a chat: every text part of every user message, and the latest turn's alone. */
function linkedSitesOf(state: ChatState, excluded: readonly string[]): string[] {
  const textsOf = (turnId?: string) =>
    state.messages.flatMap((message) =>
      message.role === "user" && (turnId === undefined || message.turnId === turnId)
        ? message.parts.flatMap((part) => (part.type === "text" ? [part.text] : []))
        : [],
    );
  const latest = state.turns.at(-1)?.id;
  return chatLinkedSites({
    chatTexts: textsOf(),
    turnTexts: latest === undefined ? [] : textsOf(latest),
    excluded,
  });
}
