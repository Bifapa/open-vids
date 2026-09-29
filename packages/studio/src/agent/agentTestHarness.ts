import { vi, type Mock } from "vitest";
import type {
  ActiveTurnInfo,
  ChatEvent,
  ChatEventPayload,
  AssistantMessage,
  UserMessage,
  ChatState,
  ChatSummary,
  ListChatsResponse,
  AgentModelCatalog,
  RevertTurnResponse,
  TurnSummary,
} from "@hyperframes/agent-protocol";
import type { AgentClient } from "./agentClient";
import type { EventSourceLike } from "./agentStream";

/** A scriptable `EventSource`: tests decide when it opens, what it says and when it fails. */
export class FakeEventSource implements EventSourceLike {
  onopen: ((event: Event) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  closed = false;
  private listeners = new Map<string, ((event: Event) => void)[]>();

  constructor(readonly url: string) {}

  addEventListener(type: string, listener: (event: Event) => void) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }

  close() {
    this.closed = true;
  }

  open() {
    this.onopen?.(new Event("open"));
  }

  fail() {
    this.onerror?.(new Event("error"));
  }

  emit(type: string, payload: unknown) {
    const event = new MessageEvent(type, { data: JSON.stringify(payload) });
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
}

export interface SourceLog {
  sources: FakeEventSource[];
  open: (url: string) => FakeEventSource;
  /** The newest source whose URL contains `fragment`. */
  latest: (fragment: string) => FakeEventSource;
}

export function createSourceLog(): SourceLog {
  const sources: FakeEventSource[] = [];
  return {
    sources,
    open(url) {
      const source = new FakeEventSource(url);
      sources.push(source);
      return source;
    },
    latest(fragment) {
      const match = [...sources].reverse().find((source) => source.url.includes(fragment));
      if (!match) throw new Error(`no event source for ${fragment}`);
      return match;
    },
  };
}

// ── Fixtures ─────────────────────────────────────────────────────────────────

export function summary(overrides: Partial<ChatSummary> = {}): ChatSummary {
  return {
    id: "c1",
    projectId: "p1",
    title: "Tighten the intro",
    createdAt: 1000,
    updatedAt: 2000,
    status: "idle",
    lastTaskSummary: null,
    activeMode: "normal",
    mainAgentModel: null,
    thinking: null,
    enabledAgents: [],
    ...overrides,
  };
}

export function turn(overrides: Partial<TurnSummary> = {}): TurnSummary {
  return {
    id: "t1",
    chatId: "c1",
    status: "running",
    startedAt: 3000,
    promptMessageId: "m1",
    assistantMessageId: "m2",
    model: null,
    thinking: null,
    checkpoint: { status: "active", entryIds: [], createdAt: 3000 },
    ...overrides,
  };
}

export function userMessage(id = "m1", text = "Trim the intro", turnId = "t1"): UserMessage {
  return {
    id,
    chatId: "c1",
    turnId,
    createdAt: 3000,
    role: "user",
    steering: false,
    parts: [{ type: "text", id: `${id}-p`, text }],
  };
}

export function assistantMessage(overrides: Partial<AssistantMessage> = {}): AssistantMessage {
  return {
    id: "m2",
    chatId: "c1",
    turnId: "t1",
    createdAt: 3001,
    role: "assistant",
    status: "streaming",
    model: null,
    parts: [],
    ...overrides,
  };
}

export function chatState(overrides: Partial<ChatState> = {}): ChatState {
  return { chat: summary(), messages: [], turns: [], lastSeq: 0, ...overrides };
}

/** A chat with a live turn: prompt sent, assistant message streaming. */
export function runningChatState(assistant: Partial<AssistantMessage> = {}) {
  return chatState({
    chat: summary({ status: "working" }),
    messages: [userMessage(), assistantMessage(assistant)],
    turns: [turn()],
    lastSeq: 2,
  });
}

export function chatEvent(seq: number, payload: ChatEventPayload, chatId = "c1"): ChatEvent {
  return { ...payload, seq, chatId, ts: 5000 + seq };
}

// ── Fake client ──────────────────────────────────────────────────────────────

type ClientMocks = { [K in keyof AgentClient]: Mock<AgentClient[K]> };

export type FakeClient = ClientMocks;

export interface FakeClientData {
  list?: ListChatsResponse;
  models?: AgentModelCatalog;
  chat?: ChatState;
  revert?: RevertTurnResponse;
}

export const EMPTY_LIST: ListChatsResponse = { chats: [], activeTurn: null };
export const CATALOG: AgentModelCatalog = {
  models: [
    {
      provider: "anthropic",
      modelId: "sonnet",
      name: "Sonnet",
      reasoning: true,
      efforts: ["low", "high"],
    },
    { provider: "openai", modelId: "mini", name: "Mini", reasoning: false, efforts: [] },
  ],
  defaultModel: { provider: "anthropic", modelId: "sonnet" },
  defaultThinking: "low",
};

export function createFakeClient(data: FakeClientData = {}): FakeClient {
  const state = data.chat ?? chatState();
  const client: FakeClient = {
    listChats: vi.fn(async () => data.list ?? EMPTY_LIST),
    listModels: vi.fn(async () => data.models ?? CATALOG),
    createChat: vi.fn(async () => summary({ id: "new" })),
    getChat: vi.fn(async () => state),
    updateChat: vi.fn(async (_id, request) => ({
      ...state.chat,
      ...(request.title !== undefined ? { title: request.title } : {}),
      ...(request.model !== undefined ? { mainAgentModel: request.model } : {}),
      ...(request.thinking !== undefined ? { thinking: request.thinking } : {}),
    })),
    startTurn: vi.fn(async () => ({ turn: turn() })),
    steerTurn: vi.fn(async () => ({ messageId: "m9" })),
    abortTurn: vi.fn(async () => undefined),
    revertTurn: vi.fn(async () => data.revert ?? { ok: true, turn: turn({ status: "completed" }) }),
    chatEventsUrl: vi.fn((chatId, after) => `/agent/chats/${chatId}/events?after=${after}`),
    projectEventsUrl: vi.fn(() => "/agent/events"),
  };
  return client;
}

export const ACTIVE: ActiveTurnInfo = { chatId: "c1", turnId: "t1", startedAt: 3000 };

/** Lets promises settle (and timers, when faked) without knowing how deep the chain is. */
export async function flush() {
  for (let index = 0; index < 8; index += 1) await Promise.resolve();
}
