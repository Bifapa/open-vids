import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRuntimeFixture, waitUntil } from "../testing/runtimeFixture.js";
import type { StreamTimerApi } from "../turnStream.js";
import { PromptWatchdog, stallMessage } from "./watchdog.js";

const timers = {
  setTimeout: (callback: () => void, delay: number) => globalThis.setTimeout(callback, delay),
  clearTimeout: (timer: NodeJS.Timeout) => globalThis.clearTimeout(timer),
};

describe("PromptWatchdog", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("fires once when nothing happens for the whole window, and not before", () => {
    const stalls: number[] = [];
    const watchdog = new PromptWatchdog(timers, 1_000, (idle) => stalls.push(idle));
    watchdog.arm();
    vi.advanceTimersByTime(999);
    expect(stalls).toEqual([]);
    vi.advanceTimersByTime(2);
    expect(stalls).toEqual([1_000]);
    vi.advanceTimersByTime(10_000);
    expect(stalls).toEqual([1_000]);
  });

  it("counts every event as progress", () => {
    const stalls: number[] = [];
    const watchdog = new PromptWatchdog(timers, 1_000, (idle) => stalls.push(idle));
    watchdog.arm();
    for (let beat = 0; beat < 5; beat += 1) {
      vi.advanceTimersByTime(800);
      watchdog.touch();
    }
    expect(stalls).toEqual([]);
    vi.advanceTimersByTime(1_001);
    expect(stalls).toHaveLength(1);
  });

  it("does not run while one of the Director's own tools is in flight, and restarts when it ends", () => {
    const stalls: number[] = [];
    const watchdog = new PromptWatchdog(timers, 1_000, (idle) => stalls.push(idle));
    watchdog.arm();
    watchdog.hold();
    vi.advanceTimersByTime(10_000);
    expect(stalls).toEqual([]);
    watchdog.release();
    vi.advanceTimersByTime(900);
    expect(stalls).toEqual([]);
    vi.advanceTimersByTime(200);
    expect(stalls).toHaveLength(1);
  });

  it("is silent while disarmed", () => {
    const stalls: number[] = [];
    const watchdog = new PromptWatchdog(timers, 1_000, (idle) => stalls.push(idle));
    watchdog.arm();
    watchdog.disarm();
    vi.advanceTimersByTime(5_000);
    watchdog.touch();
    vi.advanceTimersByTime(5_000);
    expect(stalls).toEqual([]);
  });

  it("says how long the model was silent", () => {
    expect(stallMessage(600_000)).toContain("10 minutes");
    expect(stallMessage(60_000)).toContain("1 minute,");
  });
});

/**
 * Timers a test fires by hand: nothing runs until `fire(delay)` is called for the timers scheduled with that delay.
 */
class ManualTimers implements StreamTimerApi {
  private readonly pending = new Map<NodeJS.Timeout, { callback: () => void; delay: number }>();

  setTimeout(callback: () => void, delay: number): NodeJS.Timeout {
    // A real, far-away, unref'd timer is only the handle; the callback runs when the test fires it.
    const handle = globalThis.setTimeout(() => undefined, 2 ** 30);
    handle.unref();
    this.pending.set(handle, { callback, delay });
    return handle;
  }

  clearTimeout(handle: NodeJS.Timeout): void {
    globalThis.clearTimeout(handle);
    this.pending.delete(handle);
  }

  fire(delay: number): void {
    for (const [handle, timer] of [...this.pending]) {
      if (timer.delay !== delay) continue;
      this.pending.delete(handle);
      timer.callback();
    }
  }
}

const STALL_MS = 424_242;

describe("Director prompt watchdog in a turn", () => {
  it("fails a turn whose model goes silent, with a clear error, keeping the checkpoint closed", async () => {
    const manual = new ManualTimers();
    const fixture = await createRuntimeFixture({ promptStallMs: STALL_MS, timers: manual });
    try {
      const chat = await fixture.chats.create({}, []);
      const started = Promise.withResolvers<void>();
      fixture.backend.promptScript = async (input) => {
        const aborted = Promise.withResolvers<void>();
        input.signal.addEventListener("abort", () => aborted.resolve(), { once: true });
        started.resolve();
        await aborted.promise;
        return "aborted";
      };
      await fixture.turns.start(chat.id, { prompt: "Tighten the intro" });
      await started.promise;
      manual.fire(STALL_MS);
      await waitUntil(
        () => fixture.chats.get(chat.id)?.turns.at(-1)?.status === "failed",
        "the stalled turn to fail",
      );
      const turn = fixture.chats.get(chat.id)?.turns.at(-1);
      expect(turn?.error?.code).toBe("agent_failed");
      expect(turn?.error?.message).toContain("produced no output");
      expect(turn?.checkpoint?.status).toBe("ready");
      expect(fixture.turns.activeTurn).toBeNull();
    } finally {
      await fixture.cleanup();
    }
  });

  it("keeps waiting while the Director's own tool call (a question to the user) outlasts the window", async () => {
    const manual = new ManualTimers();
    const fixture = await createRuntimeFixture({ promptStallMs: STALL_MS, timers: manual });
    try {
      const chat = await fixture.chats.create({}, []);
      fixture.backend.promptScript = async (input, session) => {
        if (!input.text.includes("Tighten")) return "completed";
        await session.callTool("request_input", { question: "Which cut?" });
        return "completed";
      };
      const turn = await fixture.turns.start(chat.id, { prompt: "Tighten the intro" });
      const pending = () => {
        const message = fixture.chats.get(chat.id)?.messages.find((m) => m.role === "assistant");
        const part = message?.parts.find(
          (entry) => entry.type === "question" && entry.question.state === "pending",
        );
        return part?.type === "question" ? part.question : null;
      };
      await waitUntil(() => pending() !== null, "the question");
      manual.fire(STALL_MS);
      expect(fixture.chats.get(chat.id)?.turns.at(-1)?.status).toBe("running");
      await fixture.turns.answerQuestion(chat.id, turn.id, pending()?.id ?? "", "The short one");
      await waitUntil(
        () => fixture.chats.get(chat.id)?.turns.at(-1)?.status === "completed",
        "the turn to complete",
      );
    } finally {
      await fixture.cleanup();
    }
  });
});
