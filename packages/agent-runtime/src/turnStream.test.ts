import { describe, expect, it } from "vitest";
import type { ChatEvent, TurnSummary } from "@hyperframes/agent-protocol";
import { TurnEventWriter } from "./turnStream.js";
import { createRuntimeFixture } from "./testing/runtimeFixture.js";

const TURN: TurnSummary = {
  id: "turn-1",
  chatId: "chat",
  status: "running",
  startedAt: 1,
  promptMessageId: "p",
  assistantMessageId: "a",
  model: null,
  thinking: null,
  checkpoint: null,
};

async function writerFor(runId: string | null) {
  const fixture = await createRuntimeFixture();
  const chat = await fixture.chats.create({ title: "stream" });
  const events: ChatEvent[] = [];
  fixture.chats.subscribeChat(chat.id, 0, (event) => events.push(event));
  let id = 0;
  const writer = new TurnEventWriter({
    chats: fixture.chats,
    chatId: chat.id,
    messageId: "a",
    turn: { ...TURN, chatId: chat.id },
    runId,
    now: fixture.now,
    ids: () => `part-${++id}`,
    timers: { setTimeout: (callback, ms) => setTimeout(callback, ms), clearTimeout },
    onModel: () => undefined,
  });
  return { fixture, writer, events };
}

describe("TurnEventWriter usage", () => {
  it("reports a cumulative usage per agent with the latest context fill", async () => {
    const { fixture, writer, events } = await writerFor("run-7");
    try {
      const call = (input: number, cost: number | null) => ({
        input,
        output: 10,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: input + 10,
        cost,
      });
      writer.accept({
        type: "usage",
        usage: call(100, 0.5),
        context: { tokens: 110, window: 1000 },
      });
      writer.accept({
        type: "usage",
        usage: call(200, null),
        context: { tokens: 320, window: 1000 },
      });
      await writer.finish("complete");

      const reports = events.flatMap((event) => (event.type === "usage.updated" ? [event] : []));
      expect(reports).toHaveLength(2);
      expect(reports[0]).toMatchObject({ turnId: "turn-1", runId: "run-7" });
      expect(reports[1]?.usage).toEqual({
        input: 300,
        output: 20,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 320,
        cost: 0.5,
      });
      expect(reports[1]?.context).toEqual({ tokens: 320, window: 1000 });
    } finally {
      await fixture.cleanup();
    }
  });

  it("reports the Director with a null run id", async () => {
    const { fixture, writer, events } = await writerFor(null);
    try {
      writer.accept({
        type: "usage",
        usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: null },
      });
      await writer.finish("complete");
      expect(events.find((event) => event.type === "usage.updated")).toMatchObject({ runId: null });
    } finally {
      await fixture.cleanup();
    }
  });
});

describe("TurnEventWriter failed calls", () => {
  it("puts the failed tool's reason on its activity row", async () => {
    const { fixture, writer, events } = await writerFor(null);
    try {
      writer.accept({
        type: "tool.start",
        toolCallId: "c1",
        kind: "edit",
        targets: ["index.html"],
      });
      writer.accept({
        type: "tool.end",
        toolCallId: "c1",
        ok: false,
        error: "Render QA is over: edit is refused now.",
      });
      writer.accept({ type: "text.delta", delta: "done" });
      await writer.finish("complete");
      const rows = events.flatMap((event) =>
        event.type === "activity.updated" ? [event.activity] : [],
      );
      const last = rows.at(-1);
      expect(last?.status).toBe("failed");
      expect(last?.error).toEqual({
        code: "tool_failed",
        message: "Render QA is over: edit is refused now.",
      });
      expect(rows.some((row) => row.status === "running" && row.error !== undefined)).toBe(false);
    } finally {
      await fixture.cleanup();
    }
  });

  it("fails a labelled row (a provider retry) with the reason it ended on", async () => {
    const { fixture, writer, events } = await writerFor(null);
    try {
      writer.accept({
        type: "tool.start",
        toolCallId: "retry-1",
        kind: "other",
        targets: [],
        label: "The model provider failed; retrying",
        labelCode: "provider_retry",
        labelParams: { attempt: 1, maxAttempts: 3, delaySeconds: 2 },
      });
      writer.accept({
        type: "tool.end",
        toolCallId: "retry-1",
        ok: false,
        error: "529 overloaded",
      });
      await writer.finish("failed");
      const last = events
        .flatMap((event) => (event.type === "activity.updated" ? [event.activity] : []))
        .at(-1);
      expect(last).toMatchObject({
        status: "failed",
        labelCode: "provider_retry",
        error: { code: "tool_failed", message: "529 overloaded" },
      });
    } finally {
      await fixture.cleanup();
    }
  });
});
