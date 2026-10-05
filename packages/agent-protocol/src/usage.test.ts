import { describe, expect, it } from "vitest";
import {
  addUsage,
  foldChatEvents,
  isQuestionRequest,
  parseAnswerQuestion,
  parseCancelRun,
  parseDeleteChat,
  parseUpdateChat,
  sumUsage,
  type AgentRun,
  type AssistantMessage,
  type ChatEvent,
  type ChatState,
  type ChatSummary,
  type QuestionRequest,
  type TurnSummary,
  type UsageTotals,
} from "./index.js";

const chat: ChatSummary = {
  id: "c1",
  projectId: "p",
  title: "Chat",
  createdAt: 1,
  updatedAt: 1,
  status: "idle",
  lastTaskSummary: null,
  activeMode: "normal",
  mainAgentModel: null,
  thinking: null,
  enabledAgents: [],
};

const turn: TurnSummary = {
  id: "t1",
  chatId: "c1",
  status: "running",
  startedAt: 2,
  promptMessageId: "m1",
  assistantMessageId: "m2",
  model: null,
  thinking: null,
  checkpoint: null,
};

const assistant: AssistantMessage = {
  id: "m2",
  chatId: "c1",
  turnId: "t1",
  createdAt: 2,
  role: "assistant",
  parts: [],
  status: "streaming",
  model: null,
};

const run: AgentRun = {
  id: "r1",
  turnId: "t1",
  agent: "editor",
  parentRunId: null,
  title: "Trim",
  status: "running",
  model: null,
  thinking: null,
  routedByDirector: false,
  taskMessageId: "k1",
  assistantMessageId: "e1",
  startedAt: 4,
  summary: null,
};

function usage(input: number, output: number, cost: number | null): UsageTotals {
  return { input, output, cacheRead: 0, cacheWrite: 0, totalTokens: input + output, cost };
}

type Payload = Omit<ChatEvent, "seq" | "chatId" | "ts">;

function sequence(events: Payload[]): ChatEvent[] {
  return events.map((event, index) => ({ ...event, seq: index + 1, chatId: "c1", ts: 10 + index }));
}

const opening: Payload[] = [
  { type: "chat.created", chat },
  {
    type: "turn.started",
    turn,
    promptMessage: {
      id: "m1",
      chatId: "c1",
      turnId: "t1",
      createdAt: 2,
      role: "user",
      steering: false,
      parts: [{ type: "text", id: "p1", text: "hi" }],
    },
    assistantMessage: assistant,
  },
  {
    type: "agent.started",
    run,
    parentMessageId: "m2",
    taskMessage: {
      id: "k1",
      chatId: "c1",
      turnId: "t1",
      createdAt: 4,
      role: "task",
      runId: "r1",
      agent: "editor",
      from: "director",
      parts: [{ type: "text", id: "kt", text: "Trim" }],
      steering: false,
    },
    assistantMessage: { ...assistant, id: "e1", runId: "r1", agent: "editor", createdAt: 4 },
  },
];

describe("usage helpers", () => {
  it("keeps a known cost when the other side has none and returns undefined for nothing", () => {
    expect(addUsage(usage(1, 2, null), usage(3, 4, 0.5))).toEqual(usage(4, 6, 0.5));
    expect(addUsage(usage(1, 2, null), usage(3, 4, null)).cost).toBeNull();
    expect(sumUsage([undefined, undefined])).toBeUndefined();
  });
});

describe("usage.updated folding", () => {
  it("sums the Director bucket and every run into the turn and the chat, replacing repeated reports", () => {
    const state = foldChatEvents(
      sequence([
        ...opening,
        { type: "usage.updated", turnId: "t1", runId: null, usage: usage(100, 10, 0.1) },
        { type: "usage.updated", turnId: "t1", runId: "r1", usage: usage(50, 5, null) },
        {
          type: "usage.updated",
          turnId: "t1",
          runId: "r1",
          usage: usage(80, 8, 0.2),
          context: { tokens: 1_000, window: 200_000 },
        },
        { type: "usage.updated", turnId: "t1", runId: null, usage: usage(120, 12, 0.3) },
      ]),
    );
    expect(state?.runs[0]?.usage).toEqual(usage(80, 8, 0.2));
    expect(state?.runs[0]?.context).toEqual({ tokens: 1_000, window: 200_000 });
    expect(state?.turns[0]?.directorUsage).toEqual(usage(120, 12, 0.3));
    expect(state?.turns[0]?.usage).toEqual(usage(200, 20, 0.5));
    expect(state?.chat.usage).toEqual(usage(200, 20, 0.5));
  });

  it("keeps usage through run and turn lifecycle events that do not repeat it, and sums turns into the chat", () => {
    const state = foldChatEvents(
      sequence([
        ...opening,
        { type: "usage.updated", turnId: "t1", runId: null, usage: usage(10, 1, 0.01) },
        { type: "usage.updated", turnId: "t1", runId: "r1", usage: usage(20, 2, 0.02) },
        { type: "agent.completed", run: { ...run, status: "completed", endedAt: 6 } },
        { type: "turn.completed", turn: { ...turn, status: "completed", endedAt: 9 } },
        { type: "chat.updated", chat: { ...chat, updatedAt: 12 } },
        {
          type: "turn.started",
          turn: { ...turn, id: "t2", promptMessageId: "m3", assistantMessageId: "m4" },
          promptMessage: {
            id: "m3",
            chatId: "c1",
            turnId: "t2",
            createdAt: 20,
            role: "user",
            steering: false,
            parts: [{ type: "text", id: "p2", text: "again" }],
          },
          assistantMessage: { ...assistant, id: "m4", turnId: "t2", createdAt: 20 },
        },
        { type: "usage.updated", turnId: "t2", runId: null, usage: usage(5, 5, null) },
      ]),
    );
    expect(state?.runs[0]).toMatchObject({ status: "completed", usage: usage(20, 2, 0.02) });
    expect(state?.turns[0]?.usage).toEqual(usage(30, 3, 0.03));
    expect(state?.turns[1]?.usage).toEqual(usage(5, 5, null));
    expect(state?.chat.usage).toEqual(usage(35, 8, 0.03));
  });

  it("ignores reports for an unknown turn or run and logs from before usage stay usage-free", () => {
    const state = foldChatEvents(
      sequence([
        ...opening,
        { type: "usage.updated", turnId: "nope", runId: null, usage: usage(1, 1, null) },
        { type: "usage.updated", turnId: "t1", runId: "ghost", usage: usage(1, 1, null) },
      ]),
    );
    expect(state?.turns[0]?.usage).toBeUndefined();
    expect(state?.chat.usage).toBeUndefined();
    expect(state?.runs[0]?.usage).toBeUndefined();
  });
});

describe("question parts", () => {
  const question: QuestionRequest = {
    id: "q1",
    agent: "editor",
    text: "Which intro?",
    options: ["Short", "Long"],
    state: "pending",
    requestedAt: 5,
  };

  it("adds, updates in place and expires an unanswered question when the turn ends", () => {
    const events: Payload[] = [...opening, { type: "question.updated", messageId: "m2", question }];
    const pending = foldChatEvents(sequence(events));
    const part = (state: ChatState | null) => {
      const message = state?.messages.find((candidate) => candidate.id === "m2");
      return message?.role === "assistant" ? message.parts : [];
    };
    expect(part(pending).filter((p) => p.type === "question")).toHaveLength(1);

    const answered = foldChatEvents(
      sequence([
        ...events,
        {
          type: "question.updated",
          messageId: "m2",
          question: { ...question, state: "answered", answer: "Short", answeredAt: 6 },
        },
      ]),
    );
    const parts = part(answered).filter((p) => p.type === "question");
    expect(parts).toHaveLength(1);
    expect(parts[0]).toMatchObject({ question: { state: "answered", answer: "Short" } });

    const expired = foldChatEvents(
      sequence([
        ...events,
        { type: "turn.completed", turn: { ...turn, status: "completed", endedAt: 9 } },
      ]),
    );
    expect(part(expired).find((p) => p.type === "question")).toMatchObject({
      question: { state: "expired" },
    });
  });

  it("validates stored questions", () => {
    expect(isQuestionRequest(question)).toBe(true);
    expect(isQuestionRequest({ ...question, options: Array(7).fill("x") })).toBe(false);
    expect(isQuestionRequest({ ...question, options: ["x".repeat(81)] })).toBe(false);
    expect(isQuestionRequest({ ...question, state: "maybe" })).toBe(false);
    expect(isQuestionRequest({ ...question, agent: "robot" })).toBe(false);
  });
});

describe("new request validators", () => {
  it("parses a question answer", () => {
    expect(parseAnswerQuestion({ answer: "  Short " })).toEqual({
      ok: true,
      value: { answer: "Short" },
    });
    expect(parseAnswerQuestion({ answer: "   " }).ok).toBe(false);
    expect(parseAnswerQuestion({ answer: 3 }).ok).toBe(false);
    expect(parseAnswerQuestion({ answer: "x".repeat(2_001) }).ok).toBe(false);
    expect(parseAnswerQuestion(undefined).ok).toBe(false);
  });

  it("parses a run cancellation with an optional reason", () => {
    expect(parseCancelRun(undefined)).toEqual({ ok: true, value: {} });
    expect(parseCancelRun({})).toEqual({ ok: true, value: {} });
    expect(parseCancelRun({ reason: " stop " })).toEqual({ ok: true, value: { reason: "stop" } });
    expect(parseCancelRun({ reason: 1 }).ok).toBe(false);
    expect(parseCancelRun("stop").ok).toBe(false);
  });

  it("accepts only an empty body for a chat delete", () => {
    expect(parseDeleteChat(undefined).ok).toBe(true);
    expect(parseDeleteChat({}).ok).toBe(true);
    expect(parseDeleteChat({ force: true }).ok).toBe(false);
  });

  it("parses excludedSites on a chat update", () => {
    expect(parseUpdateChat({ excludedSites: ["Example.com", "example.com", "a.b.co"] })).toEqual({
      ok: true,
      value: { excludedSites: ["example.com", "a.b.co"] },
    });
    expect(parseUpdateChat({ excludedSites: [] })).toEqual({
      ok: true,
      value: { excludedSites: [] },
    });
    expect(parseUpdateChat({ excludedSites: "example.com" }).ok).toBe(false);
    expect(parseUpdateChat({ excludedSites: ["not a domain"] }).ok).toBe(false);
    expect(parseUpdateChat({ excludedSites: ["https://example.com/x"] }).ok).toBe(false);
    expect(parseUpdateChat({ excludedSites: [42] }).ok).toBe(false);
    expect(parseUpdateChat({ excludedSites: Array(65).fill("a.com") }).ok).toBe(false);
  });
});
