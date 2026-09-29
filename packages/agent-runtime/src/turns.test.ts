import { describe, expect, it } from "vitest";
import type { BackendPromptOutcome } from "./backend.js";
import { createRuntimeFixture, waitUntil, type RuntimeFixture } from "./testing/runtimeFixture.js";

function deferred<T>() {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

async function finishTurn(fixture: RuntimeFixture, chatId: string): Promise<void> {
  await waitUntil(
    () => fixture.chats.get(chatId)?.turns.some((turn) => turn.status !== "running") === true,
    "turn completion",
  );
}

describe("TurnRunner", () => {
  it("folds streamed text, thinking and consecutive tool activity into durable state", async () => {
    const fixture = await createRuntimeFixture();
    try {
      const chat = await fixture.chats.create({});
      fixture.checkpoints.nextEntryIds = ["history-entry-1"];
      fixture.backend.promptScript = async (input) => {
        input.onEvent({
          type: "model.resolved",
          model: { provider: "demo", modelId: "resolved" },
          thinking: "high",
        });
        input.onEvent({ type: "text.delta", delta: "hello " });
        input.onEvent({ type: "text.delta", delta: "world" });
        input.onEvent({ type: "thinking.delta", delta: "private thought" });
        input.onEvent({ type: "thinking.end" });
        input.onEvent({ type: "text.delta", delta: "bridge" });
        input.onEvent({
          type: "tool.start",
          toolCallId: "private-call-a",
          kind: "inspect",
          targets: ["index.html"],
        });
        input.onEvent({ type: "tool.end", toolCallId: "private-call-a", ok: true });
        input.onEvent({
          type: "tool.start",
          toolCallId: "private-call-b",
          kind: "inspect",
          targets: ["scene.html"],
        });
        input.onEvent({ type: "tool.end", toolCallId: "private-call-b", ok: true });
        input.onEvent({ type: "text.delta", delta: "after " });
        input.onEvent({ type: "text.delta", delta: "activity" });
        return "completed";
      };

      const turn = await fixture.turns.start(chat.id, {
        prompt: "Create a scene",
        references: [{ kind: "asset", id: "ref-1", path: "assets/cover.png" }],
      });
      await finishTurn(fixture, chat.id);

      const state = fixture.chats.get(chat.id);
      expect(state?.chat.status).toBe("completed");
      expect(state?.chat.title).toBe("Create a scene");
      expect(state?.turns[0]?.status).toBe("completed");
      expect(state?.turns[0]?.model).toEqual({ provider: "demo", modelId: "resolved" });
      const assistant = state?.messages.find((message) => message.role === "assistant");
      expect(assistant?.role).toBe("assistant");
      if (assistant?.role !== "assistant") throw new Error("Expected an assistant message");
      expect(
        assistant.parts
          .filter((part) => part.type === "text")
          .map((part) => (part.type === "text" ? part.text : "")),
      ).toEqual(["hello world", "bridge", "after activity"]);
      const textParts = assistant.parts.filter((part) => part.type === "text");
      expect(textParts).toHaveLength(3);
      expect(new Set(textParts.map((part) => part.id)).size).toBe(3);
      expect(assistant.parts.filter((part) => part.type === "thinking")).toMatchObject([
        { text: "private thought", done: true },
      ]);
      const activity = assistant.parts.find((part) => part.type === "activity");
      expect(activity?.type === "activity" ? activity.activity : null).toMatchObject({
        category: "inspect",
        status: "done",
        label: "Reading 2 files",
        count: 2,
        targets: ["index.html", "scene.html"],
      });
      const events = fixture.chats.events(chat.id);
      const startedEvent = events.find((event) => event.type === "turn.started");
      expect(
        startedEvent?.type === "turn.started" ? startedEvent.promptMessage.parts : [],
      ).toMatchObject([
        { type: "text", text: "Create a scene" },
        { type: "reference", reference: { kind: "asset", id: "ref-1", path: "assets/cover.png" } },
      ]);
      const firstDelta = events.find((event) => event.type === "assistant.text.delta");
      expect(firstDelta?.type === "assistant.text.delta" ? firstDelta.delta : "").toBe(
        "hello world",
      );
      expect(events.at(-1)?.seq).toBe(events.length);
      expect(JSON.stringify(events)).not.toContain("private-call");
      expect(fixture.checkpoints.windows[0]?.ended).toBe(true);
      expect(fixture.checkpoints.windows[0]?.label).toBe("Director: Create a scene");
      expect(turn.checkpoint?.createdAt).toBe(fixture.checkpoints.windows[0]?.startedAt);
      expect(turn.status).toBe("running");
    } finally {
      await fixture.cleanup();
    }
  });

  it("enforces chat_busy and project_busy until the single project turn finishes", async () => {
    const fixture = await createRuntimeFixture();
    const gate = deferred<BackendPromptOutcome>();
    try {
      const first = await fixture.chats.create({});
      const second = await fixture.chats.create({});
      fixture.backend.promptScript = () => gate.promise;
      const running = await fixture.turns.start(first.id, { prompt: "Update the title" });
      await waitUntil(
        () => fixture.backend.sessions[0]?.prompts.length === 1,
        "backend prompt start",
      );

      await expect(
        fixture.turns.start(first.id, { prompt: "Second instruction" }),
      ).rejects.toMatchObject({ code: "chat_busy", status: 409 });
      await expect(fixture.turns.start(second.id, { prompt: "Other chat" })).rejects.toMatchObject({
        code: "project_busy",
        status: 409,
      });
      expect(fixture.checkpoints.windows).toHaveLength(1);

      gate.resolve("completed");
      await finishTurn(fixture, first.id);
      expect(fixture.chats.get(first.id)?.turns[0]?.id).toBe(running.id);
    } finally {
      gate.resolve("completed");
      await fixture.cleanup();
    }
  });

  it("appends steering before forwarding editor context to the live session", async () => {
    const fixture = await createRuntimeFixture();
    const gate = deferred<BackendPromptOutcome>();
    try {
      const chat = await fixture.chats.create({});
      fixture.backend.promptScript = () => gate.promise;
      const turn = await fixture.turns.start(chat.id, { prompt: "Build a caption" });
      await waitUntil(
        () => fixture.backend.sessions[0]?.prompts.length === 1,
        "backend prompt start",
      );
      const messageId = await fixture.turns.steer(chat.id, turn.id, {
        text: "Use a warmer tone",
        editorContext: {
          schemaVersion: 1,
          capturedAt: 8,
          project: { id: "project-one" },
          activeComposition: { path: "composition.html" },
          timeline: { duration: 12, elementCount: 0, elements: [] },
          playhead: { time: 4, playing: false },
          selection: { clips: [], assetPath: null, previewElement: null, range: null },
          renderSettings: null,
          storyGraph: null,
        },
      });
      const session = fixture.backend.sessions[0];
      expect(session?.steering[0]).toContain("<editor-context>");
      expect(session?.steering[0]).toContain("composition.html");
      expect(
        fixture.chats.get(chat.id)?.messages.find((message) => message.id === messageId),
      ).toMatchObject({ role: "user", steering: true });
      gate.resolve("completed");
      await finishTurn(fixture, chat.id);
    } finally {
      gate.resolve("completed");
      await fixture.cleanup();
    }
  });

  it("aborts cleanly and always closes the checkpoint", async () => {
    const fixture = await createRuntimeFixture();
    try {
      const chat = await fixture.chats.create({});
      fixture.backend.promptScript = (input) =>
        new Promise<BackendPromptOutcome>((resolve) => {
          input.signal.addEventListener("abort", () => resolve("aborted"), { once: true });
        });
      const turn = await fixture.turns.start(chat.id, { prompt: "Start a render" });
      await waitUntil(
        () => fixture.backend.sessions[0]?.prompts.length === 1,
        "backend prompt start",
      );
      fixture.turns.abort(chat.id, turn.id);
      await finishTurn(fixture, chat.id);
      expect(fixture.chats.get(chat.id)?.turns[0]?.status).toBe("aborted");
      expect(fixture.chats.get(chat.id)?.chat.status).toBe("idle");
      expect(fixture.chats.events(chat.id).some((event) => event.type === "turn.aborted")).toBe(
        true,
      );
      expect(fixture.checkpoints.windows[0]?.ended).toBe(true);
    } finally {
      await fixture.cleanup();
    }
  });

  it("records a readable failure and closes the checkpoint", async () => {
    const fixture = await createRuntimeFixture();
    try {
      const chat = await fixture.chats.create({});
      fixture.backend.promptScript = async () => {
        throw new Error("provider disconnected");
      };
      await fixture.turns.start(chat.id, { prompt: "Write a title card" });
      await finishTurn(fixture, chat.id);
      expect(fixture.chats.get(chat.id)?.chat.status).toBe("failed");
      expect(fixture.chats.get(chat.id)?.turns[0]).toMatchObject({
        status: "failed",
        error: { code: "agent_failed", message: "provider disconnected" },
        checkpoint: { status: "ready", entryIds: [] },
      });
      expect(fixture.checkpoints.windows[0]?.ended).toBe(true);
    } finally {
      await fixture.cleanup();
    }
  });

  it("does not emit a turn when checkpoint begin fails", async () => {
    const fixture = await createRuntimeFixture();
    try {
      const chat = await fixture.chats.create({});
      fixture.checkpoints.nextBeginError = new Error("History is unavailable");
      await expect(fixture.turns.start(chat.id, { prompt: "Make a change" })).rejects.toMatchObject(
        { code: "checkpoint_unavailable", status: 409 },
      );
      expect(fixture.chats.events(chat.id).map((event) => event.type)).toEqual(["chat.created"]);
      expect(fixture.chats.get(chat.id)?.chat.status).toBe("idle");
      expect(fixture.backend.sessions).toHaveLength(0);
    } finally {
      await fixture.cleanup();
    }
  });

  it("handles revert success, conflict and partial completion", async () => {
    const fixture = await createRuntimeFixture();
    try {
      const chat = await fixture.chats.create({});
      fixture.checkpoints.nextEntryIds = ["older", "newer"];
      fixture.backend.promptScript = async () => "completed";
      const turn = await fixture.turns.start(chat.id, { prompt: "Change two files" });
      await finishTurn(fixture, chat.id);

      fixture.checkpoints.nextRevertOutcome = { ok: false, conflict: { files: ["index.html"] } };
      const conflict = await fixture.turns.revert(chat.id, turn.id, "just-this");
      expect(conflict).toEqual({ ok: false, conflict: { files: ["index.html"] } });
      expect(fixture.checkpoints.revertCalls[0]?.mode).toBe("just-this");
      fixture.checkpoints.nextRevertError = new Error("Studio history unavailable");
      await expect(fixture.turns.revert(chat.id, turn.id)).rejects.toMatchObject({
        code: "runtime_unavailable",
        status: 503,
      });

      fixture.checkpoints.nextRevertOutcome = {
        ok: false,
        conflict: { files: ["scene.html"] },
        remainingEntryIds: ["older"],
      };
      const partial = await fixture.turns.revert(chat.id, turn.id);
      expect(partial).toEqual({ ok: false, conflict: { files: ["scene.html"] } });
      expect(fixture.chats.get(chat.id)?.turns[0]?.checkpoint?.entryIds).toEqual(["older"]);

      const success = await fixture.turns.revert(chat.id, turn.id);
      expect(success).toMatchObject({ ok: true, turn: { checkpoint: { status: "reverted" } } });
      expect(fixture.checkpoints.revertCalls[2]).toEqual({
        entryIds: ["older", "newer"],
        mode: "keep-later-edits",
      });
      expect(fixture.checkpoints.revertCalls[3]).toEqual({
        entryIds: ["older"],
        mode: "keep-later-edits",
      });
    } finally {
      await fixture.cleanup();
    }
  });
  it("reuses one session for a chat and disposes it on shutdown", async () => {
    const fixture = await createRuntimeFixture({ sessionIdleMs: 60_000 });
    try {
      const chat = await fixture.chats.create({});
      fixture.backend.promptScript = async () => "completed";
      await fixture.turns.start(chat.id, { prompt: "First pass" });
      await finishTurn(fixture, chat.id);
      await fixture.turns.start(chat.id, { prompt: "Second pass" });
      await finishTurn(fixture, chat.id);
      expect(fixture.backend.sessions).toHaveLength(1);
      expect(fixture.backend.sessions[0]?.prompts).toHaveLength(2);
      await fixture.turns.dispose();
      expect(fixture.backend.sessions[0]?.disposed).toBe(true);
    } finally {
      await fixture.cleanup();
    }
  });

  it("disposes an idle session after the configured timeout", async () => {
    const fixture = await createRuntimeFixture({ sessionIdleMs: 1 });
    try {
      const chat = await fixture.chats.create({});
      fixture.backend.promptScript = async () => "completed";
      await fixture.turns.start(chat.id, { prompt: "Idle timeout" });
      await finishTurn(fixture, chat.id);
      await waitUntil(
        () => fixture.backend.sessions[0]?.disposed === true,
        "idle session disposal",
      );
    } finally {
      await fixture.cleanup();
    }
  });
});
