import { describe, expect, it } from "vitest";
import {
  SseParser,
  applyChatEvent,
  emptyChatState,
  encodeSseMessage,
  foldChatEvents,
  isNextEvent,
  parseReference,
  parseRevertTurn,
  parseStartTurn,
  parseSteerTurn,
  type AssistantMessage,
  type ChatEvent,
  type ChatSummary,
  type TurnSummary,
} from "./index.js";

const chat: ChatSummary = {
  id: "c1",
  projectId: "p",
  title: "New chat",
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

function log(): ChatEvent[] {
  const events: Omit<ChatEvent, "seq" | "chatId" | "ts">[] = [
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
    { type: "thinking.updated", messageId: "m2", partId: "th", delta: "hm", done: false },
    { type: "thinking.updated", messageId: "m2", partId: "th", delta: "m", done: true },
    { type: "assistant.text.delta", messageId: "m2", partId: "tx", delta: "Hel" },
    { type: "assistant.text.delta", messageId: "m2", partId: "tx", delta: "lo" },
    {
      type: "activity.updated",
      messageId: "m2",
      activity: {
        id: "a1",
        category: "inspect",
        status: "running",
        label: "Reading 1 file",
        count: 1,
        targets: ["index.html"],
        startedAt: 3,
      },
    },
    { type: "turn.completed", turn: { ...turn, status: "completed", endedAt: 9 } },
  ];
  return events.map((event, index) => ({ ...event, seq: index + 1, chatId: "c1", ts: 10 + index }));
}

describe("applyChatEvent", () => {
  it("folds a streamed turn into messages, keeping part order and settling open parts", () => {
    const state = foldChatEvents(log());
    expect(state?.lastSeq).toBe(8);
    const message = state?.messages[1];
    expect(message?.role).toBe("assistant");
    if (message?.role !== "assistant") return;
    expect(message.status).toBe("complete");
    expect(message.parts.map((part) => part.type)).toEqual(["thinking", "text", "activity"]);
    const [thinking, text, activity] = message.parts;
    expect(thinking).toMatchObject({ text: "hmm", done: true, startedAt: 12, endedAt: 13 });
    expect(text).toMatchObject({ text: "Hello" });
    // a still-running activity is settled when the turn ends
    expect(activity).toMatchObject({ activity: { status: "done" } });
    expect(state?.turns[0]?.status).toBe("completed");
  });

  it("ignores replayed events and reports gaps", () => {
    const events = log();
    let state = emptyChatState(chat);
    state = applyChatEvent(state, events[0]!);
    const again = applyChatEvent(state, events[0]!);
    expect(again).toBe(state);
    expect(isNextEvent(state, events[1]!)).toBe(true);
    expect(isNextEvent(state, events[3]!)).toBe(false);
  });

  it("marks a failed turn's streaming message failed", () => {
    const events = log().slice(0, 5);
    const failed: ChatEvent = {
      type: "turn.failed",
      turn: { ...turn, status: "failed" },
      error: { code: "agent_failed", message: "boom" },
      seq: 6,
      chatId: "c1",
      ts: 20,
    };
    const state = foldChatEvents([...events, failed]);
    const message = state?.messages[1];
    expect(message?.role === "assistant" && message.status).toBe("failed");
  });
});

describe("validators", () => {
  const context = {
    schemaVersion: 1,
    capturedAt: 5,
    project: { id: "p" },
    activeComposition: { path: "index.html", fps: 30 },
    timeline: {
      duration: 10,
      elementCount: 1,
      elements: [{ id: "a", tag: "div", start: 0, duration: 2, track: 0 }, { bad: true }],
    },
    playhead: { time: 1.5, playing: false },
    selection: {
      clips: [],
      assetPath: null,
      previewElement: { hfId: "x" },
      range: { start: 1, end: 2 },
    },
    renderSettings: null,
    storyGraph: null,
  };

  it("parses a start-turn request and drops malformed context clips", () => {
    const parsed = parseStartTurn({ prompt: "make it shorter", editorContext: context });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.editorContext?.timeline.elements).toHaveLength(1);
    expect(parsed.value.editorContext?.selection.range).toEqual({ start: 1, end: 2 });
  });

  it("rejects empty prompts and steering text", () => {
    expect(parseStartTurn({ prompt: "  " }).ok).toBe(false);
    expect(parseSteerTurn({ text: "" }).ok).toBe(false);
    expect(parseStartTurn({ prompt: "x", editorContext: { schemaVersion: 2 } }).ok).toBe(false);
  });

  it("accepts every reference kind and rejects malformed ones", () => {
    const ok = [
      { id: "1", kind: "image", source: { type: "project-path", path: "a.png" } },
      { id: "2", kind: "video", source: { type: "url", url: "https://x/y.mp4" } },
      { id: "3", kind: "audio", source: { type: "upload", uploadId: "u" } },
      { id: "4", kind: "file", source: { type: "project-path", path: "a.txt" } },
      { id: "5", kind: "url", url: "https://example.com" },
      { id: "6", kind: "asset", path: "assets/a.mp4" },
      { id: "7", kind: "timeline-range", start: 1, end: 2 },
      { id: "8", kind: "editor-selection", context },
    ];
    for (const reference of ok) expect(parseReference(reference).ok).toBe(true);
    expect(parseReference({ id: "x", kind: "timeline-range", start: 3, end: 1 }).ok).toBe(false);
    expect(parseReference({ id: "x", kind: "video", source: { type: "nope" } }).ok).toBe(false);
    expect(parseReference({ id: "x", kind: "hologram" }).ok).toBe(false);
  });

  it("validates revert modes", () => {
    expect(parseRevertTurn(undefined)).toEqual({ ok: true, value: {} });
    expect(parseRevertTurn({ mode: "just-this" })).toEqual({
      ok: true,
      value: { mode: "just-this" },
    });
    expect(parseRevertTurn({ mode: "back-to-before" }).ok).toBe(false);
  });
});

describe("SSE codec", () => {
  it("round-trips multi-line data across arbitrary chunk boundaries", () => {
    const wire =
      encodeSseMessage({ id: "3", event: "chat", data: "a\nb" }) +
      ": keepalive\n\n" +
      encodeSseMessage({ data: "{}" });
    const parser = new SseParser();
    const out = [];
    for (let i = 0; i < wire.length; i += 3) out.push(...parser.push(wire.slice(i, i + 3)));
    expect(out).toEqual([{ id: "3", event: "chat", data: "a\nb" }, { data: "{}" }]);
  });
});
