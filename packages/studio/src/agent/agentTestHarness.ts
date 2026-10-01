import { vi, type Mock } from "vitest";
import { DEFAULT_EXECUTION_QUALITY, qaCounts } from "@hyperframes/agent-protocol";
import type {
  ActiveTurnInfo,
  AgentIntake,
  AgentRun,
  AgentSettings,
  ChatEvent,
  ChatEventPayload,
  AssistantMessage,
  UserMessage,
  ChatState,
  ChatSummary,
  ListChatsResponse,
  AgentModelCatalog,
  RevertTurnResponse,
  QaIssue,
  QaPassState,
  QaReport,
  SpecialistDefaults,
  TaskMessage,
  TestJevResponse,
  TurnSummary,
} from "@hyperframes/agent-protocol";
import { AgentApiError, type AgentClient } from "./agentClient";
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
  return { chat: summary(), messages: [], turns: [], runs: [], lastSeq: 0, ...overrides };
}

/** A delegated run the Director started in turn t1; its task and reply ids derive from its id. */
export function agentRun(overrides: Partial<AgentRun> = {}): AgentRun {
  const id = overrides.id ?? "r1";
  return {
    id,
    turnId: "t1",
    agent: "editor",
    parentRunId: null,
    title: "Trim the intro",
    status: "running",
    model: null,
    thinking: null,
    routedByDirector: false,
    taskMessageId: `${id}-task`,
    assistantMessageId: `${id}-reply`,
    startedAt: 3100,
    summary: null,
    ...overrides,
  };
}

export function taskMessage(run: AgentRun, text: string, steering = false): TaskMessage {
  return {
    id: steering ? `${run.id}-follow-up` : run.taskMessageId,
    chatId: "c1",
    turnId: run.turnId,
    createdAt: run.startedAt,
    runId: run.id,
    role: "task",
    agent: run.agent,
    from: "director",
    steering,
    parts: [{ type: "text", id: `${run.id}-task-p`, text }],
  };
}

/** The reply that streams under a run's task, in the run's own thread. */
export function runReply(run: AgentRun, overrides: Partial<AssistantMessage> = {}) {
  return assistantMessage({
    id: run.assistantMessageId,
    turnId: run.turnId,
    createdAt: run.startedAt + 1,
    runId: run.id,
    agent: run.agent,
    ...overrides,
  });
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

// ── Render QA fixtures ───────────────────────────────────────────────────────

export function qaIssue(overrides: Partial<QaIssue> = {}): QaIssue {
  return {
    id: "p1-1",
    kind: "black_frames",
    severity: "error",
    source: "render",
    check: "blackdetect",
    start: 12.3,
    end: 13.1,
    clipIds: [],
    subject: null,
    message: "The picture is black for 0.8 s.",
    fixable: true,
    owner: "editor",
    suggestion: null,
    status: "new",
    firstSeenPass: 1,
    ...overrides,
  };
}

/** A stored pass; `counts` follow its issues. */
export function qaReport(overrides: Partial<QaReport> = {}): QaReport {
  const issues = overrides.issues ?? [qaIssue()];
  const resolved = overrides.resolved ?? [];
  return {
    id: "qa-1",
    schemaVersion: 1,
    createdAt: 7000,
    sessionId: "t1",
    turnId: "t1",
    chatId: "c1",
    pass: 1,
    passLimit: 2,
    preset: "balanced",
    composition: "index.html",
    fingerprint: "fp-1",
    timelineVersion: "tv-1",
    render: {
      path: "renders/qa-t1-1.mp4",
      duration: 30,
      width: 1920,
      height: 1080,
      hasAudio: true,
      quality: "draft",
      origin: "qa",
    },
    renderError: null,
    checks: [],
    vision: { status: "ran", reason: null, frames: 12, rounds: 1, model: "anthropic/sonnet" },
    previousReportId: null,
    current: true,
    ...overrides,
    issues,
    resolved,
    counts: qaCounts(issues, resolved),
  };
}

export function qaPass(overrides: Partial<QaPassState> = {}): QaPassState {
  return {
    pass: 1,
    phase: "done",
    reportId: "qa-1",
    renderPath: "renders/qa-t1-1.mp4",
    counts: null,
    vision: "ran",
    error: null,
    startedAt: 6000,
    endedAt: 7000,
    ...overrides,
  };
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
  settings?: AgentSettings;
  /** Stored QA reports by id; an unknown id answers 404. */
  qaReports?: Record<string, QaReport>;
  /** What the intake claim hands out (once); none when absent. */
  intake?: AgentIntake;
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

function specialistDefaults(enabledByDefault: boolean): SpecialistDefaults {
  return { model: null, thinking: null, allowedModels: [], enabledByDefault };
}

export const SETTINGS: AgentSettings = {
  director: { model: null, thinking: null },
  specialists: {
    editor: specialistDefaults(true),
    vision: specialistDefaults(true),
    motion: specialistDefaults(false),
    research: specialistDefaults(false),
    audio: specialistDefaults(false),
  },
  jev: {
    enabled: false,
    provider: null,
    modelId: null,
    thinking: null,
    credentials: "provider-login",
    apiKeyConfigured: false,
  },
  executionQuality: DEFAULT_EXECUTION_QUALITY,
};

export function createFakeClient(data: FakeClientData = {}): FakeClient {
  const state = data.chat ?? chatState();
  const client: FakeClient = {
    listChats: vi.fn(async () => data.list ?? EMPTY_LIST),
    listModels: vi.fn(async () => data.models ?? CATALOG),
    createChat: vi.fn(async () => summary({ id: "new" })),
    getChat: vi.fn(async () => state),
    updateChat: vi.fn(async (chatId, request) => ({
      ...state.chat,
      id: chatId,
      ...(request.title !== undefined ? { title: request.title } : {}),
      ...(request.model !== undefined ? { mainAgentModel: request.model } : {}),
      ...(request.thinking !== undefined ? { thinking: request.thinking } : {}),
      ...(request.enabledAgents !== undefined ? { enabledAgents: request.enabledAgents } : {}),
      ...(request.activeMode !== undefined ? { activeMode: request.activeMode } : {}),
      ...(request.intent !== undefined ? { intent: request.intent } : {}),
      ...(request.executionQuality !== undefined
        ? { executionQuality: request.executionQuality }
        : {}),
    })),
    startTurn: vi.fn(async () => ({ turn: turn() })),
    steerTurn: vi.fn(async () => ({ messageId: "m9" })),
    abortTurn: vi.fn(async () => undefined),
    revertTurn: vi.fn(async () => data.revert ?? { ok: true, turn: turn({ status: "completed" }) }),
    unrevertTurn: vi.fn(async () => ({ ok: true, turn: turn({ status: "completed" }) })),
    chatEventsUrl: vi.fn((chatId, after) => `/agent/chats/${chatId}/events?after=${after}`),
    projectEventsUrl: vi.fn(() => "/agent/events"),
    getSettings: vi.fn(async () => data.settings ?? SETTINGS),
    updateSettings: vi.fn(async () => data.settings ?? SETTINGS),
    setJevApiKey: vi.fn(async () => data.settings ?? SETTINGS),
    testJev: vi.fn(async (): Promise<TestJevResponse> => ({ ok: false, message: "Jev is off." })),
    listProviders: vi.fn(async () => ({ providers: [] })),
    listProviderModels: vi.fn(async () => ({ models: [] })),
    getQaReport: vi.fn(async (reportId) => {
      const report = data.qaReports?.[reportId];
      if (!report) throw new AgentApiError("internal", "report not found", 404);
      return report;
    }),
    renderFileUrl: vi.fn(
      (renderPath) => `/api/projects/p1/renders/file/${renderPath.replace(/^renders\//, "")}`,
    ),
    claimIntake: vi.fn(async () => {
      const intake = data.intake ?? null;
      data.intake = undefined;
      return intake;
    }),
  };
  return client;
}

export const ACTIVE: ActiveTurnInfo = { chatId: "c1", turnId: "t1", startedAt: 3000 };

/** Lets promises settle (and timers, when faked) without knowing how deep the chain is. */
export async function flush() {
  for (let index = 0; index < 8; index += 1) await Promise.resolve();
}
