import { existsSync } from "node:fs";
import { appendFile, readFile, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { AssistantMessage, ChatEvent, TurnSummary } from "@hyperframes/agent-protocol";
import { foldChatEvents } from "@hyperframes/agent-protocol";
import { ChatService } from "../chats.js";
import { createRuntimeFixture, type RuntimeFixture } from "../testing/runtimeFixture.js";
import { compactEvents, sameValue } from "./compact.js";
import { FileChatStore, takeProjectOwnership } from "./index.js";

function chatDir(fixture: RuntimeFixture, chatId: string): string {
  return join(fixture.scope.projectDir, ".hyperframes", "agent", "chats", chatId);
}

/** Plays one finished turn into a chat: streamed text and thinking, an activity that updates, usage, a run. */
async function playTurn(fixture: RuntimeFixture, chatId: string): Promise<void> {
  const turn: TurnSummary = {
    id: "turn-1",
    chatId,
    status: "running",
    startedAt: 1,
    promptMessageId: "user-1",
    assistantMessageId: "assistant-1",
    model: null,
    thinking: null,
    checkpoint: null,
  };
  const assistant: AssistantMessage = {
    id: "assistant-1",
    chatId,
    role: "assistant",
    turnId: turn.id,
    createdAt: 1,
    status: "streaming",
    model: null,
    parts: [],
  };
  const emit = (payload: Parameters<typeof fixture.chats.emit>[1]) =>
    fixture.chats.emit(chatId, payload);
  await emit({
    type: "turn.started",
    turn,
    promptMessage: {
      id: "user-1",
      chatId,
      role: "user",
      turnId: turn.id,
      createdAt: 1,
      steering: false,
      parts: [{ type: "text", id: "u", text: "make it" }],
    },
    assistantMessage: assistant,
  });
  await emit({
    type: "thinking.updated",
    messageId: "assistant-1",
    partId: "t1",
    delta: "hm",
    done: false,
  });
  await emit({
    type: "thinking.updated",
    messageId: "assistant-1",
    partId: "t1",
    delta: "m",
    done: false,
  });
  await emit({
    type: "thinking.updated",
    messageId: "assistant-1",
    partId: "t1",
    delta: "",
    done: true,
  });
  const activity = (status: "running" | "done", count: number) => ({
    id: "act-1",
    category: "inspect" as const,
    status,
    label: `Reading ${count} files`,
    count,
    targets: [],
    startedAt: 2,
  });
  await emit({
    type: "activity.updated",
    messageId: "assistant-1",
    activity: activity("running", 1),
  });
  await emit({
    type: "activity.updated",
    messageId: "assistant-1",
    activity: activity("running", 2),
  });
  await emit({ type: "activity.updated", messageId: "assistant-1", activity: activity("done", 2) });
  for (const word of ["Hel", "lo ", "there"]) {
    await emit({
      type: "assistant.text.delta",
      messageId: "assistant-1",
      partId: "x1",
      delta: word,
    });
  }
  const usage = (input: number) => ({
    input,
    output: 1,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: input + 1,
    cost: null,
  });
  await emit({ type: "usage.updated", turnId: turn.id, runId: null, usage: usage(10) });
  await emit({ type: "usage.updated", turnId: turn.id, runId: null, usage: usage(30) });
  await emit({ type: "message.completed", messageId: "assistant-1", status: "complete" });
  await emit({ type: "turn.completed", turn: { ...turn, status: "completed", endedAt: 9 } });
  await fixture.chats.drain();
}

describe("chat log compaction", () => {
  it("collapses a finished turn's deltas and updates, keeping the folded state exactly", async () => {
    const fixture = await createRuntimeFixture();
    try {
      const chat = await fixture.chats.create({ title: "compact" });
      await playTurn(fixture, chat.id);

      const before = fixture.chats.get(chat.id);
      const stored = await fixture.store.load(chat.id);
      // created, turn.started, thinking (+ its closing event), activity, text, usage, message and turn completed
      expect(stored.events).toHaveLength(9);
      expect(stored.state).toEqual(before);
      expect(fixture.chats.events(chat.id)).toHaveLength(9);
      const text = before?.messages.flatMap((message) =>
        message.role === "assistant"
          ? message.parts.flatMap((part) => (part.type === "text" ? [part.text] : []))
          : [],
      );
      expect(text).toEqual(["Hello there"]);

      const reopened = await ChatService.open(fixture.scope, fixture.store, { now: fixture.now });
      expect(reopened.get(chat.id)).toEqual(before);
      // New events carry on from the last seq, and clients can still replay from the middle of the old range.
      await reopened.update(chat.id, { title: "after" });
      expect(reopened.get(chat.id)?.lastSeq).toBe((before?.lastSeq ?? 0) + 1);
      expect(reopened.events(chat.id).filter((event) => event.seq > 3).length).toBeGreaterThan(0);
    } finally {
      await fixture.cleanup();
    }
  });

  it("leaves the log alone when the compacted form would not fold to the same state", () => {
    const fold = (events: ChatEvent[]) => foldChatEvents(events);
    const created: ChatEvent = {
      type: "chat.created",
      chatId: "c",
      seq: 1,
      ts: 1,
      chat: {
        id: "c",
        projectId: "p",
        title: "t",
        createdAt: 1,
        updatedAt: 1,
        status: "idle",
        lastTaskSummary: null,
        activeMode: "normal",
        mainAgentModel: null,
        thinking: null,
        enabledAgents: [],
        agentOverrides: {},
      },
    };
    expect(compactEvents([created])).toEqual([created]);
    // Only a log with a finished turn is touched at all.
    expect(sameValue(fold([created]), fold(compactEvents([created])))).toBe(true);
    expect(sameValue({ a: 1, b: [1, { c: 2 }] }, { b: [1, { c: 2 }], a: 1 })).toBe(true);
    expect(sameValue({ a: 1 }, { a: 2 })).toBe(false);
    expect(sameValue({ a: undefined }, {})).toBe(true);
  });

  it("does not touch the events of a turn that is still running", async () => {
    const fixture = await createRuntimeFixture();
    try {
      const chat = await fixture.chats.create({ title: "running" });
      await playTurn(fixture, chat.id);
      // A second turn streams after the first ended: its deltas stay as they are until it ends.
      const emit = (payload: Parameters<typeof fixture.chats.emit>[1]) =>
        fixture.chats.emit(chat.id, payload);
      for (const word of ["a", "b", "c"]) {
        await emit({
          type: "assistant.text.delta",
          messageId: "assistant-1",
          partId: "x2",
          delta: word,
        });
      }
      await fixture.chats.drain();
      const lines = (await readFile(join(chatDir(fixture, chat.id), "events.jsonl"), "utf8"))
        .trim()
        .split("\n");
      expect(lines.filter((line) => line.includes('"partId":"x2"'))).toHaveLength(3);
    } finally {
      await fixture.cleanup();
    }
  });
});

describe("lazy chat loading", () => {
  it("lists chats from their summaries and reads a log only when something first needs it", async () => {
    const fixture = await createRuntimeFixture();
    try {
      const first = await fixture.chats.create({ title: "first" });
      const second = await fixture.chats.create({ title: "second" });
      await playTurn(fixture, first.id);
      await fixture.chats.update(second.id, { title: "second renamed" });
      await fixture.chats.drain();

      const loads: string[] = [];
      const store = new FileChatStore(fixture.scope.projectDir);
      const original = store.loadSync.bind(store);
      store.loadSync = (chatId) => {
        loads.push(chatId);
        return original(chatId);
      };
      const reopened = await ChatService.open(fixture.scope, store, { now: fixture.now });
      expect(
        reopened
          .list()
          .map((chat) => chat.title)
          .sort(),
      ).toEqual(["first", "second renamed"]);
      expect(loads).toEqual([]);

      expect(reopened.get(second.id)?.chat.title).toBe("second renamed");
      expect(loads).toEqual([second.id]);
      expect(reopened.get(second.id)?.chat.title).toBe("second renamed");
      expect(loads).toEqual([second.id]);
      expect(reopened.get("missing")).toBeNull();
    } finally {
      await fixture.cleanup();
    }
  });

  it("ignores a summary that no longer describes the log (events written after it, a crash)", async () => {
    const fixture = await createRuntimeFixture();
    try {
      const chat = await fixture.chats.create({ title: "stale" });
      await playTurn(fixture, chat.id);
      // A later event reached the log but the summary was never rewritten.
      const last = fixture.chats.events(chat.id).at(-1);
      if (!last) throw new Error("expected events");
      await appendFile(
        join(chatDir(fixture, chat.id), "events.jsonl"),
        `${JSON.stringify({
          type: "chat.updated",
          chatId: chat.id,
          seq: last.seq + 1,
          ts: 99,
          chat: { ...(fixture.chats.get(chat.id)?.chat ?? {}), title: "renamed behind its back" },
        })}\n`,
      );
      expect(await fixture.store.readSummary(chat.id)).toBeNull();

      const reopened = await ChatService.open(fixture.scope, fixture.store, { now: fixture.now });
      expect(reopened.list().map((entry) => entry.title)).toEqual(["renamed behind its back"]);
    } finally {
      await fixture.cleanup();
    }
  });

  it("reads a chat without a summary file in full", async () => {
    const fixture = await createRuntimeFixture();
    try {
      const chat = await fixture.chats.create({ title: "legacy" });
      await fixture.chats.drain();
      await rm(join(chatDir(fixture, chat.id), "summary.json"), { force: true });
      const reopened = await ChatService.open(fixture.scope, fixture.store, { now: fixture.now });
      expect(reopened.list()).toHaveLength(1);
      expect(reopened.get(chat.id)?.chat.title).toBe("legacy");
    } finally {
      await fixture.cleanup();
    }
  });
});

describe("recoverableChatIds", () => {
  it("names the chats with a running turn without reading the others", async () => {
    const fixture = await createRuntimeFixture();
    try {
      const finished = await fixture.chats.create({ title: "finished" });
      const crashed = await fixture.chats.create({ title: "crashed" });
      await playTurn(fixture, finished.id);
      const turn: TurnSummary = {
        id: "turn-x",
        chatId: crashed.id,
        status: "running",
        startedAt: 1,
        promptMessageId: "ux",
        assistantMessageId: "ax",
        model: null,
        thinking: null,
        checkpoint: { status: "active", entryIds: [], createdAt: 1 },
      };
      await fixture.chats.emit(crashed.id, {
        type: "turn.started",
        turn,
        promptMessage: {
          id: "ux",
          chatId: crashed.id,
          role: "user",
          turnId: turn.id,
          createdAt: 1,
          steering: false,
          parts: [],
        },
        assistantMessage: {
          id: "ax",
          chatId: crashed.id,
          role: "assistant",
          turnId: turn.id,
          createdAt: 1,
          status: "streaming",
          model: null,
          parts: [],
        },
      });
      await fixture.chats.drain();

      const loads: string[] = [];
      const store = new FileChatStore(fixture.scope.projectDir);
      const original = store.loadSync.bind(store);
      store.loadSync = (chatId) => {
        loads.push(chatId);
        return original(chatId);
      };
      const reopened = await ChatService.open(fixture.scope, store, { now: fixture.now });
      expect(reopened.recoverableChatIds()).toEqual([crashed.id]);
      expect(loads).toEqual([]);
    } finally {
      await fixture.cleanup();
    }
  });
});

describe("FileChatStore.deleteChat and replace", () => {
  it("removes the chat's log and private state, and is harmless twice", async () => {
    const fixture = await createRuntimeFixture();
    try {
      const chat = await fixture.chats.create({ title: "doomed" });
      await fixture.store.stateDir(chat.id);
      await fixture.store.agentStateDir(chat.id, "editor");
      await fixture.chats.drain();
      expect(existsSync(chatDir(fixture, chat.id))).toBe(true);
      await fixture.store.deleteChat(chat.id);
      await fixture.store.deleteChat(chat.id);
      expect(existsSync(chatDir(fixture, chat.id))).toBe(false);
      await expect(fixture.store.deleteChat("../escape")).rejects.toThrow("Invalid chat id");
    } finally {
      await fixture.cleanup();
    }
  });

  it("replaces a log whole, leaving no temporary file behind", async () => {
    const fixture = await createRuntimeFixture();
    try {
      const chat = await fixture.chats.create({ title: "replace" });
      await fixture.chats.drain();
      const events = fixture.chats.events(chat.id);
      await fixture.store.replace(chat.id, events);
      const text = await readFile(join(chatDir(fixture, chat.id), "events.jsonl"), "utf8");
      expect(text.trim().split("\n")).toHaveLength(events.length);
      expect(
        (await readdir(chatDir(fixture, chat.id))).filter((name) => name.endsWith(".tmp")),
      ).toEqual([]);
    } finally {
      await fixture.cleanup();
    }
  });
});

describe("project ownership", () => {
  it("refuses a second holder with a 409 project_served_elsewhere until the first lets go", async () => {
    const fixture = await createRuntimeFixture();
    try {
      const release = await takeProjectOwnership(fixture.scope.projectDir, 0);
      // The lock names this very process (alive), so a second claim in it is a live holder too.
      await expect(takeProjectOwnership(fixture.scope.projectDir, 0)).rejects.toMatchObject({
        code: "project_served_elsewhere",
        status: 409,
      });
      release();
      const again = await takeProjectOwnership(fixture.scope.projectDir, 0);
      again();
    } finally {
      await fixture.cleanup();
    }
  });
});
