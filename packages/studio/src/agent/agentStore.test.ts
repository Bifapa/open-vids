// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatState, EditorContext } from "@hyperframes/agent-protocol";
import { AgentApiError } from "./agentClient";
import { createAgentStore, type AgentStore } from "./agentStore";
import {
  ACTIVE,
  assistantMessage,
  chatEvent,
  chatState,
  createFakeClient,
  createSourceLog,
  flush,
  runningChatState,
  summary,
  turn,
  userMessage,
  type FakeClient,
  type SourceLog,
} from "./agentTestHarness";

const CONTEXT: EditorContext = {
  schemaVersion: 1,
  capturedAt: 1,
  project: { id: "p1" },
  activeComposition: null,
  timeline: { duration: 0, elementCount: 0, elements: [] },
  playhead: { time: 0, playing: false },
  selection: { clips: [], assetPath: null, previewElement: null, range: null },
  renderSettings: null,
  storyGraph: null,
};

let log: SourceLog;
let store: AgentStore | null = null;

function setup(client: FakeClient, capture?: () => EditorContext | null) {
  log = createSourceLog();
  store = createAgentStore({
    client,
    openEventSource: log.open,
    captureEditorContext: capture,
  });
  return store;
}

async function openChat(client: FakeClient, chatId = "c1") {
  const created = setup(client);
  await created.getState().init();
  await created.getState().openChat(chatId);
  log.latest("/chats/").open();
  return created;
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  store?.getState().dispose();
  store = null;
  vi.useRealTimers();
});

describe("availability", () => {
  it("shows a calm unavailable state, opens no streams, and recovers on retry", async () => {
    const client = createFakeClient();
    client.listChats.mockRejectedValueOnce(new AgentApiError("network", "offline"));
    const created = setup(client);

    await created.getState().init();
    expect(created.getState().availability).toBe("unavailable");
    expect(created.getState().unavailableMessage).toContain("Your project is untouched");
    expect(log.sources).toHaveLength(0);

    await created.getState().retry();
    expect(created.getState().availability).toBe("ready");
    expect(log.latest("/events").url).toBe("/agent/events");
  });

  it("treats a missing gateway (404) like an unavailable runtime, not a crash", async () => {
    const client = createFakeClient();
    client.listChats.mockRejectedValue(new AgentApiError("internal", "nope", 404));
    const created = setup(client);
    await expect(created.getState().init()).resolves.toBeUndefined();
    expect(created.getState().availability).toBe("unavailable");
  });

  it("keeps the model catalog failure separate from availability", async () => {
    const client = createFakeClient();
    client.listModels.mockRejectedValue(new AgentApiError("internal", "boom", 500));
    const created = setup(client);
    await created.getState().init();
    expect(created.getState().availability).toBe("ready");
    expect(created.getState().modelsFailed).toBe(true);
  });
});

describe("project stream", () => {
  it("folds list upserts and active-turn notices, and refetches the list after a reconnect", async () => {
    const client = createFakeClient({ list: { chats: [summary()], activeTurn: null } });
    const created = setup(client);
    await created.getState().init();
    const source = log.latest("/events");
    source.open();

    source.emit("project", {
      type: "chat.upserted",
      chat: summary({ id: "c2", title: "Second", updatedAt: 9000 }),
    });
    source.emit("project", { type: "project.activeTurn", activeTurn: ACTIVE });
    expect(created.getState().chats.map((chat) => chat.id)).toEqual(["c2", "c1"]);
    expect(created.getState().activeTurn).toEqual(ACTIVE);

    source.fail();
    vi.advanceTimersByTime(500);
    log.latest("/events").open();
    await flush();
    expect(client.listChats).toHaveBeenCalledTimes(2);
  });
});

describe("chat stream", () => {
  it("folds a streamed turn into the chat state", async () => {
    const client = createFakeClient({ chat: chatState({ lastSeq: 1 }) });
    const created = await openChat(client);
    const source = log.latest("/chats/");
    expect(source.url).toBe("/agent/chats/c1/events?after=1");

    const running = turn();
    source.emit(
      "chat",
      chatEvent(2, {
        type: "turn.started",
        turn: running,
        promptMessage: userMessage(),
        assistantMessage: assistantMessage(),
      }),
    );
    source.emit(
      "chat",
      chatEvent(3, {
        type: "thinking.updated",
        messageId: "m2",
        partId: "th",
        delta: "Looking at the intro. ",
        done: false,
      }),
    );
    source.emit(
      "chat",
      chatEvent(4, {
        type: "activity.updated",
        messageId: "m2",
        activity: {
          id: "a1",
          category: "inspect",
          status: "running",
          label: "Reading 3 files",
          count: 3,
          targets: ["index.html"],
          startedAt: 1,
        },
      }),
    );
    source.emit(
      "chat",
      chatEvent(5, {
        type: "assistant.text.delta",
        messageId: "m2",
        partId: "tx",
        delta: "Trimmed ",
      }),
    );
    source.emit(
      "chat",
      chatEvent(6, {
        type: "assistant.text.delta",
        messageId: "m2",
        partId: "tx",
        delta: "the intro.",
      }),
    );
    source.emit(
      "chat",
      chatEvent(7, { type: "turn.completed", turn: turn({ status: "completed", endedAt: 9 }) }),
    );

    const state = created.getState().chat;
    expect(state?.lastSeq).toBe(7);
    const assistant = state?.messages.find((message) => message.role === "assistant");
    expect(assistant?.status).toBe("complete");
    const text = assistant?.parts.find((part) => part.type === "text");
    expect(text).toMatchObject({ text: "Trimmed the intro." });
    expect(assistant?.parts.map((part) => part.type)).toEqual(["thinking", "activity", "text"]);
  });

  it("reports each ended turn once, and nothing for events inside a turn", async () => {
    const onTurnEnded = vi.fn();
    log = createSourceLog();
    store = createAgentStore({
      client: createFakeClient({ chat: chatState({ lastSeq: 1 }) }),
      openEventSource: log.open,
      onTurnEnded,
    });
    await store.getState().init();
    await store.getState().openChat("c1");
    const source = log.latest("/chats/");
    source.open();
    source.emit("chat", chatEvent(2, { type: "chat.updated", chat: summary({ title: "Two" }) }));
    expect(onTurnEnded).not.toHaveBeenCalled();
    source.emit(
      "chat",
      chatEvent(3, { type: "turn.aborted", turn: turn({ status: "aborted", endedAt: 9 }) }),
    );
    // A replayed terminal event is not a second ending.
    source.emit(
      "chat",
      chatEvent(3, { type: "turn.aborted", turn: turn({ status: "aborted", endedAt: 9 }) }),
    );
    expect(onTurnEnded).toHaveBeenCalledTimes(1);
  });

  it("ignores replayed events and events for another chat", async () => {
    const created = await openChat(createFakeClient({ chat: chatState({ lastSeq: 4 }) }));
    const source = log.latest("/chats/");
    source.emit("chat", chatEvent(4, { type: "chat.updated", chat: summary({ title: "Replay" }) }));
    source.emit(
      "chat",
      chatEvent(5, { type: "chat.updated", chat: summary({ title: "Other" }) }, "c9"),
    );
    expect(created.getState().chat?.lastSeq).toBe(4);
    expect(created.getState().chat?.chat.title).toBe("Tighten the intro");
  });

  it("resumes after the last folded seq when the stream reconnects", async () => {
    const created = await openChat(createFakeClient({ chat: chatState({ lastSeq: 1 }) }));
    const first = log.latest("/chats/");
    first.emit("chat", chatEvent(2, { type: "chat.updated", chat: summary({ title: "Two" }) }));
    first.emit("chat", chatEvent(3, { type: "chat.updated", chat: summary({ title: "Three" }) }));

    first.fail();
    expect(created.getState().streamStatus).toBe("reconnecting");
    expect(first.closed).toBe(true);
    vi.advanceTimersByTime(500);

    const second = log.latest("/chats/");
    expect(second).not.toBe(first);
    expect(second.url).toBe("/agent/chats/c1/events?after=3");
    second.open();
    expect(created.getState().streamStatus).toBe("open");
  });

  it("treats a seq gap as 'refetch the snapshot', then resumes from the snapshot's seq", async () => {
    const client = createFakeClient({ chat: chatState({ lastSeq: 1 }) });
    const created = await openChat(client);
    const source = log.latest("/chats/");
    client.getChat.mockResolvedValue(chatState({ chat: summary({ title: "Fresh" }), lastSeq: 10 }));

    source.emit(
      "chat",
      chatEvent(5, { type: "chat.updated", chat: summary({ title: "Skipped ahead" }) }),
    );
    await flush();

    expect(client.getChat).toHaveBeenCalledTimes(2);
    expect(created.getState().chat?.chat.title).toBe("Fresh");
    expect(created.getState().chat?.lastSeq).toBe(10);
    expect(source.closed).toBe(true);
    expect(log.latest("/chats/").url).toBe("/agent/chats/c1/events?after=10");
  });

  it("drops a slow snapshot for a chat the user already left", async () => {
    const client = createFakeClient();
    const created = setup(client);
    await created.getState().init();
    const snapshot = Promise.withResolvers<ChatState>();
    client.getChat.mockReturnValueOnce(snapshot.promise);
    const opening = created.getState().openChat("c1");
    created.getState().closeChat();
    snapshot.resolve(chatState());
    await opening;
    expect(created.getState().view).toBe("history");
    expect(created.getState().chat).toBeNull();
    expect(log.sources.filter((source) => source.url.includes("/chats/"))).toHaveLength(0);
  });
});

describe("send, steer and abort", () => {
  it("starts a turn with the draft and the editor context captured at send time", async () => {
    const client = createFakeClient({ chat: chatState() });
    const capture = vi.fn(() => CONTEXT);
    const created = setup(client, capture);
    await created.getState().init();
    await created.getState().openChat("c1");
    log.latest("/chats/").open();
    expect(capture).not.toHaveBeenCalled();

    created.getState().setDraft("  Trim the intro  ");
    await created.getState().send();

    expect(client.startTurn).toHaveBeenCalledWith("c1", {
      prompt: "Trim the intro",
      editorContext: CONTEXT,
    });
    expect(client.steerTurn).not.toHaveBeenCalled();
    expect(created.getState().drafts.c1).toBe("");
    expect(created.getState().pending).toBeNull();
  });

  it("steers the live turn instead of starting a new one", async () => {
    const client = createFakeClient({ chat: runningChatState() });
    const created = await openChat(client);
    created.getState().setDraft("Make it shorter");
    await created.getState().send();

    expect(client.steerTurn).toHaveBeenCalledWith("c1", "t1", {
      text: "Make it shorter",
      editorContext: undefined,
    });
    expect(client.startTurn).not.toHaveBeenCalled();
  });

  it("still sends the prompt when capturing the editor context throws", async () => {
    const client = createFakeClient();
    const created = setup(client, () => {
      throw new Error("no iframe");
    });
    await created.getState().init();
    await created.getState().openChat("c1");
    log.latest("/chats/").open();
    created.getState().setDraft("Go");
    await created.getState().send();
    expect(client.startTurn).toHaveBeenCalledWith("c1", { prompt: "Go", editorContext: undefined });
  });

  it("refetches the snapshot after a send when the stream is not connected", async () => {
    const client = createFakeClient();
    const created = setup(client);
    await created.getState().init();
    await created.getState().openChat("c1"); // stream never opened: still connecting
    created.getState().setDraft("Go");
    await created.getState().send();
    await flush();
    expect(client.getChat).toHaveBeenCalledTimes(2);
  });

  it("keeps the draft and explains a busy project in plain language", async () => {
    const other = { chatId: "c2", turnId: "t7", startedAt: 5 };
    const client = createFakeClient();
    client.startTurn.mockRejectedValue(
      new AgentApiError("project_busy", "busy", 409, { activeTurn: other }),
    );
    const created = await openChat(client);
    // By the time the app asks again, the list tells the same story as the error.
    client.listChats.mockResolvedValue({ chats: [], activeTurn: other });
    created.getState().setDraft("Go");
    await created.getState().send();

    expect(created.getState().drafts.c1).toBe("Go");
    expect(created.getState().notice?.message).toContain("Another chat is working");
    expect(created.getState().notice?.message).not.toContain("project_busy");
    expect(created.getState().activeTurn).toEqual({ chatId: "c2", turnId: "t7", startedAt: 5 });
  });

  it("explains an unavailable checkpoint and leaves the chat as it was", async () => {
    const client = createFakeClient();
    client.startTurn.mockRejectedValue(new AgentApiError("checkpoint_unavailable", "x", 409));
    const created = await openChat(client);
    created.getState().setDraft("Go");
    await created.getState().send();
    expect(created.getState().notice?.message).toContain("undo point");
    expect(created.getState().chat?.turns).toEqual([]);
  });

  it("recovers when the run ended just before the steering message arrived", async () => {
    const client = createFakeClient({ chat: runningChatState() });
    client.steerTurn.mockRejectedValue(new AgentApiError("turn_not_active", "done", 409));
    const created = await openChat(client);
    client.getChat.mockResolvedValue(
      chatState({ turns: [turn({ status: "completed" })], lastSeq: 9 }),
    );
    created.getState().setDraft("Also this");
    await created.getState().send();

    expect(created.getState().chat?.lastSeq).toBe(9);
    expect(created.getState().drafts.c1).toBe("Also this");
    expect(created.getState().notice?.message).toContain("Your message is still in the box");
  });

  it("aborts the running turn", async () => {
    const client = createFakeClient({ chat: runningChatState() });
    const created = await openChat(client);
    await created.getState().abort();
    expect(client.abortTurn).toHaveBeenCalledWith("c1", "t1");
  });
});

describe("chat settings", () => {
  it("resets an effort the newly chosen model cannot take", async () => {
    const client = createFakeClient({ chat: chatState({ chat: summary({ thinking: "high" }) }) });
    const created = await openChat(client);
    await created.getState().setModel({ provider: "openai", modelId: "mini" });
    expect(client.updateChat).toHaveBeenCalledWith("c1", {
      model: { provider: "openai", modelId: "mini" },
      thinking: null,
    });
  });

  it("does not touch the effort when the new model accepts it", async () => {
    const client = createFakeClient({ chat: chatState({ chat: summary({ thinking: "high" }) }) });
    const created = await openChat(client);
    await created.getState().setModel({ provider: "anthropic", modelId: "sonnet" });
    expect(client.updateChat).toHaveBeenCalledWith("c1", {
      model: { provider: "anthropic", modelId: "sonnet" },
    });
  });

  it("renames through the server and adopts its answer", async () => {
    const client = createFakeClient();
    const created = await openChat(client);
    await created.getState().renameChat("  Better title ");
    expect(client.updateChat).toHaveBeenCalledWith("c1", { title: "Better title" });
    expect(created.getState().chat?.chat.title).toBe("Better title");
    expect(created.getState().chats.find((chat) => chat.id === "c1")?.title).toBe("Better title");
  });
});

describe("revert", () => {
  const finished = () =>
    chatState({
      messages: [userMessage(), assistantMessage({ status: "complete" })],
      turns: [
        turn({
          status: "completed",
          checkpoint: { status: "ready", entryIds: ["e1"], createdAt: 1 },
        }),
      ],
      lastSeq: 4,
    });

  it("marks the turn reverted from the server's answer", async () => {
    const reverted = turn({
      status: "completed",
      checkpoint: { status: "reverted", entryIds: ["e1"], createdAt: 1, revertedAt: 2 },
    });
    const client = createFakeClient({ chat: finished(), revert: { ok: true, turn: reverted } });
    const created = await openChat(client);
    await created.getState().revert("t1");
    expect(client.revertTurn).toHaveBeenCalledWith("c1", "t1", {});
    expect(created.getState().chat?.turns[0]?.checkpoint?.status).toBe("reverted");
    expect(created.getState().reverts.t1).toBeUndefined();
  });

  it("surfaces conflicting files, and the chosen mode is what reaches the server", async () => {
    const client = createFakeClient({
      chat: finished(),
      revert: { ok: false, conflict: { files: ["index.html", "a.css"] } },
    });
    const created = await openChat(client);
    await created.getState().revert("t1");
    expect(created.getState().reverts.t1).toEqual({
      status: "conflict",
      files: ["index.html", "a.css"],
    });

    client.revertTurn.mockResolvedValueOnce({ ok: true, turn: turn({ status: "completed" }) });
    await created.getState().revert("t1", "keep-later-edits");
    expect(client.revertTurn).toHaveBeenLastCalledWith("c1", "t1", { mode: "keep-later-edits" });
    expect(created.getState().reverts.t1).toBeUndefined();
  });

  it("reports a failed revert on that turn without disturbing the chat", async () => {
    const client = createFakeClient({ chat: finished() });
    client.revertTurn.mockRejectedValue(new AgentApiError("revert_unavailable", "x", 409));
    const created = await openChat(client);
    await created.getState().revert("t1");
    expect(created.getState().reverts.t1?.status).toBe("error");
    expect(created.getState().reverts.t1?.message).toBe("This run can't be reverted.");
  });

  describe("editor refresh", () => {
    async function openWithRefresh(client: FakeClient, onTurnReverted: () => Promise<void> | void) {
      log = createSourceLog();
      store = createAgentStore({ client, openEventSource: log.open, onTurnReverted });
      await store.getState().init();
      await store.getState().openChat("c1");
      log.latest("/chats/").open();
      return store;
    }

    it("refreshes the editor once after a successful revert", async () => {
      const refresh = vi.fn();
      const client = createFakeClient({ chat: finished() });
      const created = await openWithRefresh(client, refresh);
      await created.getState().revert("t1");
      expect(refresh).toHaveBeenCalledTimes(1);
    });

    it("does not refresh on a conflict, a failed revert, or a rejected call", async () => {
      const refresh = vi.fn();
      const client = createFakeClient({
        chat: finished(),
        revert: { ok: false, conflict: { files: ["index.html"] } },
      });
      const created = await openWithRefresh(client, refresh);
      await created.getState().revert("t1");
      client.revertTurn.mockRejectedValueOnce(new AgentApiError("revert_unavailable", "x", 409));
      await created.getState().revert("t1");
      expect(refresh).not.toHaveBeenCalled();
    });

    it("keeps the revert successful when the refresh itself throws", async () => {
      const client = createFakeClient({ chat: finished() });
      const created = await openWithRefresh(client, () => {
        throw new Error("iframe gone");
      });
      await created.getState().revert("t1");
      expect(created.getState().reverts.t1).toBeUndefined();
    });
  });
});
