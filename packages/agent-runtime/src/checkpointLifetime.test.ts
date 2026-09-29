import { describe, expect, it } from "vitest";
import type { ChatMessage, TurnSummary } from "@hyperframes/agent-protocol";
import type { BackendPromptOutcome } from "./backend.js";
import { ChatService } from "./chats.js";
import { TurnRunner } from "./turns.js";
import { HeartbeatClock, RENEW_MS } from "./testing/heartbeatClock.js";
import { createRuntimeFixture, waitUntil, type RuntimeFixture } from "./testing/runtimeFixture.js";

function deferred<T>() {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

async function settledTurn(fixture: RuntimeFixture, chatId: string): Promise<TurnSummary> {
  await waitUntil(
    () => fixture.chats.get(chatId)?.turns.some((turn) => turn.status !== "running") === true,
    "turn end",
  );
  const turn = fixture.chats.get(chatId)?.turns.at(-1);
  if (!turn) throw new Error("no turn");
  return turn;
}

/** A turn whose agent works until `release` resolves, like a long model run with pauses between writes. */
async function longTurn(clock: HeartbeatClock) {
  const fixture = await createRuntimeFixture({ timers: clock, renewIntervalMs: RENEW_MS });
  const release = deferred<BackendPromptOutcome>();
  // Like the OMP adapter: an already-aborted signal ends the prompt at once.
  fixture.backend.promptScript = (input) =>
    Promise.race([
      release.promise,
      new Promise<BackendPromptOutcome>((settle) => {
        if (input.signal.aborted) settle("aborted");
        input.signal.addEventListener("abort", () => settle("aborted"));
      }),
    ]);
  const chat = await fixture.chats.create({});
  await fixture.turns.start(chat.id, { prompt: "Rebuild the intro" });
  const window = fixture.checkpoints.windows.at(-1);
  if (!window) throw new Error("no transaction was opened");
  return { fixture, chat, release, window };
}

describe("a turn's project transaction", () => {
  it("is renewed for the whole turn, through an hour-long pause, and closed only when the turn ends", async () => {
    const clock = new HeartbeatClock();
    const { fixture, chat, release, window } = await longTurn(clock);
    try {
      expect(fixture.chats.get(chat.id)?.turns[0]?.checkpoint).toMatchObject({
        status: "active",
        transactionId: window.id,
      });
      for (let beat = 0; beat < (60 * 60_000) / RENEW_MS; beat += 1) await clock.beat();
      expect(window).toMatchObject({ renewals: 180, ended: false });

      fixture.checkpoints.nextEntryIds = ["first-write", "write-an-hour-later"];
      release.resolve("completed");
      const turn = await settledTurn(fixture, chat.id);

      expect(turn.status).toBe("completed");
      expect(turn.checkpoint).toMatchObject({
        status: "ready",
        entryIds: ["first-write", "write-an-hour-later"],
      });
      expect(window.ended).toBe(true);
      expect(clock.pending).toBe(0);
    } finally {
      await fixture.cleanup();
    }
  });

  it("survives a heartbeat Studio did not answer", async () => {
    const clock = new HeartbeatClock();
    const { fixture, chat, release, window } = await longTurn(clock);
    try {
      fixture.checkpoints.nextRenewError = new Error("connect ECONNREFUSED");
      await clock.beat();
      await clock.beat();
      expect(window.renewals).toBe(1);
      expect(fixture.chats.get(chat.id)?.turns[0]?.status).toBe("running");
      release.resolve("completed");
      expect((await settledTurn(fixture, chat.id)).status).toBe("completed");
    } finally {
      await fixture.cleanup();
    }
  });

  it("stops the agent when the transaction ended under it, since later writes could not be reverted", async () => {
    const clock = new HeartbeatClock();
    const { fixture, chat, window } = await longTurn(clock);
    try {
      fixture.checkpoints.nextEntryIds = ["written-before-the-loss"];
      fixture.checkpoints.expire(window.id);
      await clock.beat(() => fixture.chats.get(chat.id)?.turns[0]?.status !== "running");
      const turn = await settledTurn(fixture, chat.id);

      expect(turn.status).toBe("failed");
      expect(turn.error?.message).toMatch(/checkpoint for this turn ended unexpectedly/);
      expect(turn.checkpoint).toMatchObject({
        status: "ready",
        entryIds: ["written-before-the-loss"],
      });
    } finally {
      await fixture.cleanup();
    }
  });

  it("stays pending when it cannot be closed, and is closed with its entries before the next turn", async () => {
    const clock = new HeartbeatClock();
    const { fixture, chat, release, window } = await longTurn(clock);
    try {
      fixture.checkpoints.nextEndError = new Error("Studio is shutting down");
      release.resolve("completed");
      const turn = await settledTurn(fixture, chat.id);
      expect(turn.status).toBe("completed");
      expect(turn.checkpoint).toMatchObject({ status: "active", transactionId: window.id });

      fixture.checkpoints.nextEntryIds = ["late-closed-entry"];
      fixture.backend.promptScript = async () => "completed";
      await fixture.turns.start(chat.id, { prompt: "Next" });
      await waitUntil(
        () =>
          fixture.chats.get(chat.id)?.turns.filter((t) => t.status === "completed").length === 2,
        "second turn",
      );

      expect(fixture.checkpoints.recoveryCalls).toEqual([
        {
          label: "Director: Rebuild the intro",
          startedAt: window.startedAt,
          transactionId: window.id,
        },
      ]);
      expect(fixture.chats.get(chat.id)?.turns[0]?.checkpoint).toMatchObject({
        status: "ready",
        entryIds: ["late-closed-entry"],
      });
    } finally {
      await fixture.cleanup();
    }
  });
});

describe("crash recovery of a turn's transaction", () => {
  it("closes the still-open transaction a crashed turn left behind and keeps every entry it produced", async () => {
    const fixture = await createRuntimeFixture();
    let restarted: TurnRunner | null = null;
    try {
      const chat = await fixture.chats.create({});
      // The crashed runtime's transaction is still open on the host: nothing ended it.
      const orphan = await fixture.checkpoints.begin(fixture.scope, "Director: Cut the pauses");
      const turn: TurnSummary = {
        id: "crashed",
        chatId: chat.id,
        status: "running",
        startedAt: orphan.startedAt,
        promptMessageId: "p",
        assistantMessageId: "a",
        model: null,
        thinking: null,
        checkpoint: {
          status: "active",
          entryIds: [],
          createdAt: orphan.startedAt,
          transactionId: orphan.transactionId,
        },
      };
      const prompt: ChatMessage = {
        id: "p",
        chatId: chat.id,
        turnId: turn.id,
        createdAt: turn.startedAt,
        role: "user",
        steering: false,
        parts: [{ type: "text", id: "t", text: "Cut the pauses" }],
      };
      const assistant: ChatMessage = {
        id: "a",
        chatId: chat.id,
        turnId: turn.id,
        createdAt: turn.startedAt,
        role: "assistant",
        parts: [],
        status: "streaming",
        model: null,
      };
      await fixture.chats.emit(chat.id, {
        type: "turn.started",
        turn,
        promptMessage: prompt,
        assistantMessage: assistant,
      });

      fixture.checkpoints.nextEntryIds = ["before-crash-1", "before-crash-2"];
      const reloaded = await ChatService.open(fixture.scope, fixture.store, { now: fixture.now });
      restarted = new TurnRunner(reloaded, fixture.backend, fixture.checkpoints, fixture.store, {
        now: fixture.now,
      });
      await restarted.recoverCheckpoints();

      const window = fixture.checkpoints.windows.find((w) => w.id === orphan.transactionId);
      expect(window?.ended).toBe(true);
      expect(reloaded.get(chat.id)?.turns[0]).toMatchObject({
        status: "interrupted",
        checkpoint: { status: "ready", entryIds: ["before-crash-1", "before-crash-2"] },
      });
      expect(reloaded.get(chat.id)?.chat.status).toBe("interrupted");
    } finally {
      await restarted?.dispose();
      await fixture.cleanup();
    }
  });
});
