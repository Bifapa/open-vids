import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type {
  ChatEvent,
  ChatEventPayload,
  TurnCheckpoint,
  TurnSummary,
} from "@hyperframes/agent-protocol";
import { foldChatEvents } from "@hyperframes/agent-protocol";
import { ChatService } from "../chats.js";
import { createRuntimeFixture } from "../testing/runtimeFixture.js";
import { readForkedAt, retireCheckpointsBefore } from "./forkMarker.js";

const CHAT = "chat-1";

function turn(id: string, startedAt: number, checkpoint: TurnCheckpoint | null): TurnSummary {
  return {
    id,
    chatId: CHAT,
    status: "completed",
    startedAt,
    promptMessageId: `user-${id}`,
    assistantMessageId: `assistant-${id}`,
    model: null,
    thinking: null,
    checkpoint,
  };
}

const ready: TurnCheckpoint = {
  status: "ready",
  entryIds: ["e1", "e2"],
  files: ["index.html"],
  createdAt: 1,
  closedAt: 2,
};

/** A chat with `turns`: each starts, closes its checkpoint, and completes carrying it. */
function chatLog(turns: TurnSummary[]): ChatEvent[] {
  const events: ChatEvent[] = [];
  const add = (payload: ChatEventPayload) =>
    events.push({ ...payload, chatId: CHAT, seq: events.length + 1, ts: events.length + 1 });
  add({
    type: "chat.created",
    chat: {
      id: CHAT,
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
  });
  for (const item of turns) {
    const open = { ...item, status: "running" as const, checkpoint: null };
    add({
      type: "turn.started",
      turn: open,
      promptMessage: {
        id: item.promptMessageId,
        chatId: CHAT,
        role: "user",
        turnId: item.id,
        createdAt: item.startedAt,
        steering: false,
        parts: [{ type: "text", id: "u", text: "go" }],
      },
      assistantMessage: {
        id: item.assistantMessageId,
        chatId: CHAT,
        role: "assistant",
        turnId: item.id,
        createdAt: item.startedAt,
        status: "streaming",
        model: null,
        parts: [],
      },
    });
    if (item.checkpoint)
      add({ type: "checkpoint.updated", turnId: item.id, checkpoint: item.checkpoint });
    add({ type: "turn.completed", turn: item });
  }
  return events;
}

const checkpointOf = (events: ChatEvent[], id: string) =>
  foldChatEvents(events)?.turns.find((entry) => entry.id === id)?.checkpoint;

describe("retireCheckpointsBefore", () => {
  const reverted: TurnCheckpoint = {
    ...ready,
    status: "reverted",
    revertedAt: 5,
    revertEntryIds: ["u1"],
    revertedEntryIds: ["e1", "e2"],
    keptFiles: ["later.html"],
  };

  it("takes Revert away from turns older than the fork and leaves later turns alone", () => {
    const events = chatLog([turn("old", 10, ready), turn("new", 200, ready)]);
    const shown = retireCheckpointsBefore(events, 100);
    expect(checkpointOf(shown, "old")).toBeNull();
    expect(checkpointOf(shown, "new")).toEqual(ready);
    // Nothing else changes: the same messages, and the stored events are not modified.
    expect(foldChatEvents(shown)?.messages).toEqual(foldChatEvents(events)?.messages);
    expect(checkpointOf(events, "old")).toEqual(ready);
  });

  it("keeps the fact that an old turn was reverted, but not its entries, so it cannot be undone", () => {
    const shown = retireCheckpointsBefore(chatLog([turn("old", 10, reverted)]), 100);
    expect(checkpointOf(shown, "old")).toEqual({
      status: "reverted",
      entryIds: [],
      files: ["index.html"],
      createdAt: 1,
      closedAt: 2,
      revertedAt: 5,
      keptFiles: ["later.html"],
    });
  });

  it("returns the same events when no turn is older than the marker", () => {
    const events = chatLog([turn("new", 200, ready)]);
    expect(retireCheckpointsBefore(events, 100)).toBe(events);
  });
});

describe("readForkedAt", () => {
  it("reads the marker and ignores anything that is not a time", async () => {
    const fixture = await createRuntimeFixture();
    const dir = fixture.scope.projectDir;
    expect(readForkedAt(dir)).toBeNull();
    mkdirSync(join(dir, ".hyperframes", "agent"), { recursive: true });
    const marker = join(dir, ".hyperframes", "agent", "fork.json");
    writeFileSync(marker, JSON.stringify({ forkedAt: 1234 }));
    expect(readForkedAt(dir)).toBe(1234);
    for (const bad of ['{"forkedAt":"soon"}', "[]", "null", "{ nope"]) {
      writeFileSync(marker, bad);
      expect(readForkedAt(dir)).toBeNull();
    }
  });
});

describe("a forked project's chats", () => {
  it("offer no revert for turns made before the fork, and still for the ones made after", async () => {
    const fixture = await createRuntimeFixture();
    const dir = fixture.scope.projectDir;
    // The chats as the original left them (copied by the fork), then the marker the copy gets.
    const log = chatLog([turn("old", 10, ready), turn("new", 200, ready)]);
    for (const event of log) await fixture.store.append(event);
    mkdirSync(join(dir, ".hyperframes", "agent"), { recursive: true });
    writeFileSync(
      join(dir, ".hyperframes", "agent", "fork.json"),
      JSON.stringify({ forkedAt: 100 }),
    );

    const service = await ChatService.open(fixture.scope, fixture.store, { now: fixture.now });
    const state = service.get(CHAT);
    expect(state?.turns.map((entry) => [entry.id, entry.checkpoint?.status ?? null])).toEqual([
      ["old", null],
      ["new", "ready"],
    ]);
    // What a client replaying the chat folds is the same.
    expect(checkpointOf([...service.events(CHAT)], "old")).toBeNull();
  });

  it("keeps numbering after the highest event on disk when a dropped event was the last one", async () => {
    const fixture = await createRuntimeFixture();
    const dir = fixture.scope.projectDir;
    // "Undo revert" on an old turn ended the original's log with a checkpoint update.
    const log = chatLog([turn("old", 10, ready)]);
    log.push({
      type: "checkpoint.updated",
      turnId: "old",
      checkpoint: ready,
      chatId: CHAT,
      seq: log.length + 1,
      ts: 99,
    });
    const highest = log.length;
    for (const event of log) await fixture.store.append(event);
    mkdirSync(join(dir, ".hyperframes", "agent"), { recursive: true });
    writeFileSync(
      join(dir, ".hyperframes", "agent", "fork.json"),
      JSON.stringify({ forkedAt: 100 }),
    );

    const loaded = await fixture.store.load(CHAT);
    expect(loaded.events.at(-1)?.seq).toBeLessThan(highest);
    expect(loaded.state?.lastSeq).toBe(highest);
    const peeked = await fixture.store.peek(CHAT);
    expect(peeked.state?.lastSeq).toBe(highest);

    const service = await ChatService.open(fixture.scope, fixture.store, { now: fixture.now });
    const next = await service.update(CHAT, { title: "renamed" });
    expect(next?.title).toBe("renamed");
    expect(service.get(CHAT)?.lastSeq).toBe(highest + 1);
    expect(service.events(CHAT).at(-1)?.seq).toBe(highest + 1);
  });
});
