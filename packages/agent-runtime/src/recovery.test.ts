import { describe, expect, it } from "vitest";
import type { ChatMessage, TurnSummary } from "@hyperframes/agent-protocol";
import { ChatService } from "./chats.js";
import { TurnRunner } from "./turns.js";
import { createRuntimeFixture } from "./testing/runtimeFixture.js";

describe("runtime crash recovery", () => {
  it("closes a persisted running turn and restores its checkpoint entries", async () => {
    const fixture = await createRuntimeFixture();
    let restartedRunner: TurnRunner | null = null;
    try {
      const chat = await fixture.chats.create({});
      const startedAt = 1_700_000_111_000;
      const historyStartedAt = startedAt + 17;
      const turn: TurnSummary = {
        id: "recovered-turn",
        chatId: chat.id,
        status: "running",
        startedAt,
        promptMessageId: "recovery-prompt",
        assistantMessageId: "recovery-assistant",
        model: null,
        thinking: null,
        checkpoint: { status: "active", entryIds: [], createdAt: historyStartedAt },
      };
      const messages: ChatMessage = {
        id: turn.promptMessageId,
        chatId: chat.id,
        turnId: turn.id,
        createdAt: startedAt,
        role: "user",
        steering: false,
        parts: [{ type: "text", id: "recovery-text", text: "Repair the opening scene" }],
      };
      const assistant: ChatMessage = {
        id: turn.assistantMessageId,
        chatId: chat.id,
        turnId: turn.id,
        createdAt: startedAt,
        role: "assistant",
        parts: [],
        status: "streaming",
        model: null,
      };
      await fixture.chats.emit(chat.id, {
        type: "turn.started",
        turn,
        promptMessage: messages,
        assistantMessage: assistant,
      });

      const { state } = await fixture.store.load(chat.id);
      expect(state?.turns[0]?.status).toBe("running");
      fixture.checkpoints.addRecoveredEntry(
        fixture.scope,
        "Director: Repair the opening scene",
        historyStartedAt,
        "history-entry",
      );
      const reloaded = await ChatService.open(fixture.scope, fixture.store, { now: fixture.now });
      restartedRunner = new TurnRunner(
        reloaded,
        fixture.backend,
        fixture.checkpoints,
        fixture.store,
        fixture.settings,
        { now: fixture.now },
      );
      await restartedRunner.recoverCheckpoints();

      expect(reloaded.get(chat.id)?.chat.status).toBe("interrupted");
      expect(reloaded.get(chat.id)?.turns[0]).toMatchObject({
        status: "interrupted",
        checkpoint: { status: "ready", entryIds: ["history-entry"] },
      });
      expect(fixture.checkpoints.recoveryCalls).toEqual([
        { label: "Director: Repair the opening scene", startedAt: historyStartedAt },
      ]);
      const events = reloaded.events(chat.id);
      let checkpointEvent = -1;
      let abortedEvent = -1;
      events.forEach((event, index) => {
        if (event.type === "checkpoint.updated") checkpointEvent = index;
        if (event.type === "turn.aborted") abortedEvent = index;
      });
      expect(checkpointEvent).toBeGreaterThan(-1);
      expect(abortedEvent).toBeGreaterThan(checkpointEvent);
    } finally {
      await restartedRunner?.dispose();
      await fixture.cleanup();
    }
  });
});
