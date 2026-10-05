import { describe, expect, it } from "vitest";
import type { BackendPromptOutcome } from "./backend.js";
import { directorScript, qaChat, quality, script, settled } from "./qa/harness.js";
import { createRuntimeFixture, waitUntil, type RuntimeFixture } from "./testing/runtimeFixture.js";

function deferred<T>() {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

async function finishTurn(fixture: RuntimeFixture, chatId: string): Promise<void> {
  await waitUntil(() => {
    const last = fixture.chats.get(chatId)?.turns.at(-1);
    return last !== undefined && last.status !== "running";
  }, "turn completion");
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
        labelCode: "reading_files",
        labelParams: { count: 2 },
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

  it("reserves the project before its first await, so two concurrent starts cannot both run", async () => {
    const fixture = await createRuntimeFixture();
    const gate = deferred<BackendPromptOutcome>();
    try {
      const first = await fixture.chats.create({});
      const second = await fixture.chats.create({});
      fixture.backend.promptScript = () => gate.promise;
      // `canvas: "auto"` writes to the chat log before anything else: the window the second start used to slip through.
      const results = await Promise.allSettled([
        fixture.turns.start(first.id, { prompt: "One", canvas: "auto" }),
        fixture.turns.start(second.id, { prompt: "Two", canvas: "auto" }),
      ]);
      expect(results.map((result) => result.status)).toEqual(["fulfilled", "rejected"]);
      expect(results[1]).toMatchObject({ reason: { code: "project_busy", status: 409 } });
      expect(fixture.checkpoints.windows).toHaveLength(1);
      expect(fixture.turns.activeTurn?.chatId).toBe(first.id);
      expect(fixture.chats.get(second.id)?.chat.status).not.toBe("working");

      // A refused start never wrote a turn, and the same chat is refused as busy, not as a second turn.
      await expect(
        fixture.turns.start(first.id, { prompt: "Again", canvas: "auto" }),
      ).rejects.toMatchObject({ code: "chat_busy" });
    } finally {
      gate.resolve("completed");
      await fixture.cleanup();
    }
  });

  it("releases the reservation when the start fails before the turn begins", async () => {
    const fixture = await createRuntimeFixture();
    try {
      const chat = await fixture.chats.create({});
      const setCanvasAuto = fixture.chats.setCanvasAuto.bind(fixture.chats);
      fixture.chats.setCanvasAuto = async () => {
        throw new Error("disk full");
      };
      await expect(
        fixture.turns.start(chat.id, { prompt: "Fails", canvas: "auto" }),
      ).rejects.toThrow("disk full");
      expect(fixture.turns.activeTurn).toBeNull();

      fixture.chats.setCanvasAuto = setCanvasAuto;
      await fixture.turns.start(chat.id, { prompt: "Works now" });
      await finishTurn(fixture, chat.id);
      expect(fixture.chats.get(chat.id)?.turns).toHaveLength(1);
    } finally {
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

  it("records the files attached to a steering message and tells the live session about them", async () => {
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
        text: "Use this logo",
        references: [
          {
            id: "r1",
            kind: "image",
            label: "logo.png",
            source: { type: "project-path", path: "assets/logo.png" },
            sizeBytes: 2048,
          },
        ],
      });
      expect(fixture.backend.sessions[0]?.steering[0]).toContain(
        "- picture assets/logo.png (2 KB)",
      );
      const message = fixture.chats.get(chat.id)?.messages.find((item) => item.id === messageId);
      expect(message?.role === "user" && message.parts.map((part) => part.type)).toEqual([
        "text",
        "reference",
      ]);
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

  it("handles revert success, conflict and partial completion, then undoes the revert", async () => {
    const fixture = await createRuntimeFixture();
    try {
      const chat = await fixture.chats.create({});
      fixture.checkpoints.nextEntryIds = ["older", "newer"];
      fixture.checkpoints.entryFiles = {
        older: ["index.html"],
        newer: ["captions.html", "index.html"],
        "undo-older": ["index.html"],
      };
      fixture.backend.promptScript = async () => "completed";
      const turn = await fixture.turns.start(chat.id, { prompt: "Change two files" });
      await finishTurn(fixture, chat.id);
      expect(fixture.chats.get(chat.id)?.turns[0]?.checkpoint?.files).toEqual([
        "captions.html",
        "index.html",
      ]);

      fixture.checkpoints.nextRevertOutcome = { ok: false, conflict: { files: ["index.html"] } };
      const conflict = await fixture.turns.revert(chat.id, turn.id, "just-this");
      expect(conflict).toEqual({ ok: false, conflict: { files: ["index.html"] } });
      expect(fixture.checkpoints.revertCalls[0]?.mode).toBe("just-this");
      fixture.checkpoints.nextRevertError = new Error("Studio history unavailable");
      await expect(fixture.turns.revert(chat.id, turn.id)).rejects.toMatchObject({
        code: "runtime_unavailable",
        status: 503,
      });

      // The newer entry was undone before the older one hit a conflict: only the older one remains.
      fixture.checkpoints.nextRevertOutcome = {
        ok: false,
        conflict: { files: ["scene.html"] },
        remainingEntryIds: ["older"],
        undoEntryIds: ["undo-newer"],
      };
      const partial = await fixture.turns.revert(chat.id, turn.id);
      expect(partial).toEqual({ ok: false, conflict: { files: ["scene.html"] } });
      expect(fixture.chats.get(chat.id)?.turns[0]?.checkpoint).toMatchObject({
        entryIds: ["older"],
        revertedEntryIds: ["newer"],
        revertEntryIds: ["undo-newer"],
      });

      // Without a mode the host is asked to stop at conflicts; the user's choice is passed through.
      const success = await fixture.turns.revert(chat.id, turn.id, "keep-later-edits");
      expect(success).toMatchObject({ ok: true, turn: { checkpoint: { status: "reverted" } } });
      expect(fixture.checkpoints.revertCalls[2]).toEqual({
        entryIds: ["older", "newer"],
        mode: undefined,
      });
      expect(fixture.checkpoints.revertCalls[3]).toEqual({
        entryIds: ["older"],
        mode: "keep-later-edits",
      });
      // undo-newer touched nothing the fake knows; undo-older restored index.html: captions.html was kept.
      expect(fixture.chats.get(chat.id)?.turns[0]?.checkpoint).toMatchObject({
        status: "reverted",
        revertedEntryIds: ["older", "newer"],
        revertEntryIds: ["undo-newer", "undo-older"],
        keptFiles: ["captions.html"],
      });

      const undone = await fixture.turns.unrevert(chat.id, turn.id);
      expect(fixture.checkpoints.revertCalls[4]).toEqual({
        entryIds: ["undo-newer", "undo-older"],
        mode: undefined,
      });
      expect(undone).toMatchObject({ ok: true });
      const restored = fixture.chats.get(chat.id)?.turns[0]?.checkpoint;
      expect(restored).toMatchObject({ status: "ready", entryIds: ["older", "newer"] });
      expect(restored?.revertEntryIds).toBeUndefined();
      await expect(fixture.turns.unrevert(chat.id, turn.id)).rejects.toMatchObject({
        code: "revert_unavailable",
      });
    } finally {
      await fixture.cleanup();
    }
  });
  it("refuses the harness's own edit and write in a story turn that does not build, and in the QA final prompt", async () => {
    const fixture = await createRuntimeFixture();
    try {
      const chat = await fixture.chats.create({}, []);
      const seen: Array<{ edit: string | null; write: string | null; read: string | null }> = [];
      fixture.backend.promptScript = async (_input, session) => {
        const ask = session.input.fileWriteRefusal;
        seen.push({
          edit: ask?.("edit") ?? null,
          write: ask?.("write") ?? null,
          read: ask?.("read") ?? null,
        });
        return "completed";
      };
      for (const storyAction of ["review", "resolve", "rebuild", "build"] as const) {
        await fixture.turns.start(chat.id, { prompt: `Story ${storyAction}`, storyAction });
        await finishTurn(fixture, chat.id);
      }
      expect(seen.map((entry) => [entry.edit !== null, entry.write !== null, entry.read])).toEqual([
        [true, true, null],
        [true, true, null],
        [true, true, null],
        [false, false, null],
      ]);
      expect(seen[0]?.edit).toContain("Story Mode turn");
    } finally {
      await fixture.cleanup();
    }
  });

  it("refuses the harness's own edit and write once Render QA is over", async () => {
    const fixture = await createRuntimeFixture();
    try {
      const chatId = await qaChat(fixture, quality(1));
      const refusals: Array<{ edit: string | null; write: string | null }> = [];
      const websiteSaves: string[] = [];
      const director = directorScript(fixture, {
        final: async (session) => {
          websiteSaves.push(
            (await session.callTool("read_website", { url: "https://linear.app", save: true }))
              .text,
          );
          refusals.push({
            edit: session.input.fileWriteRefusal?.("edit") ?? null,
            write: session.input.fileWriteRefusal?.("write") ?? null,
          });
        },
      });
      script(fixture, { director: director.run });
      await fixture.turns.start(chatId, { prompt: "Tighten the intro" });
      await settled(fixture, chatId);
      expect(director.seen.finals).toHaveLength(1);
      expect(refusals).toHaveLength(1);
      expect(refusals[0]?.edit).toContain("Render QA is over");
      expect(refusals[0]?.write).toContain("Render QA is over");
      // The call's arguments reach the refusal: a saving website call is closed too.
      expect(websiteSaves).toHaveLength(1);
      expect(websiteSaves[0]).toContain("Render QA is over");
    } finally {
      await fixture.cleanup();
    }
  });

  it("records the entries already undone when a later undo request fails", async () => {
    const fixture = await createRuntimeFixture();
    try {
      const chat = await fixture.chats.create({});
      fixture.checkpoints.nextEntryIds = ["older", "newer"];
      fixture.backend.promptScript = async () => "completed";
      const turn = await fixture.turns.start(chat.id, { prompt: "Change two files" });
      await finishTurn(fixture, chat.id);

      fixture.checkpoints.nextRevertOutcome = {
        ok: false,
        failure: "That change is no longer kept in this project's history",
        remainingEntryIds: ["older"],
        undoEntryIds: ["undo-newer"],
      };
      await expect(fixture.turns.revert(chat.id, turn.id)).rejects.toMatchObject({
        code: "runtime_unavailable",
        status: 503,
        message: "That change is no longer kept in this project's history",
      });
      // The newer entry is undone on disk, so the chat must say so and keep the ids "Undo revert" needs.
      expect(fixture.chats.get(chat.id)?.turns[0]?.checkpoint).toMatchObject({
        status: "ready",
        entryIds: ["older"],
        revertedEntryIds: ["newer"],
        revertEntryIds: ["undo-newer"],
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

  describe("reverted turns notice", () => {
    async function runTurnWithEntries(
      fixture: RuntimeFixture,
      chatId: string,
      prompt: string,
      mode?: "story",
    ) {
      fixture.checkpoints.nextEntryIds = [`entry-for-${prompt}`];
      const turn = await fixture.turns.start(chatId, { prompt, ...(mode && { mode }) });
      await finishTurn(fixture, chatId);
      return turn;
    }
    const lastPrompt = (fixture: RuntimeFixture): string =>
      fixture.backend.sessions.at(-1)?.prompts.at(-1)?.text ?? "";

    it("tells the Director once which earlier turns were reverted, before the interim instruction", async () => {
      const fixture = await createRuntimeFixture({ sessionIdleMs: 60_000 });
      try {
        const chat = await fixture.chats.create({});
        fixture.backend.promptScript = async () => "completed";
        const first = await runTurnWithEntries(
          fixture,
          chat.id,
          "Render the final video\nwith captions",
        );
        // No reverted predecessor, no block.
        expect(lastPrompt(fixture)).not.toContain("<reverted-turns>");

        expect(await fixture.turns.revert(chat.id, first.id)).toMatchObject({ ok: true });
        await runTurnWithEntries(fixture, chat.id, "Tighten the intro");
        const second = lastPrompt(fixture);
        expect(second).toContain("<reverted-turns>");
        expect(second).toContain(
          '- "Render the final video with captions" (less than a minute ago)',
        );
        expect(second).toContain("renders/");
        expect(second.indexOf("<reverted-turns>")).toBeGreaterThan(
          second.indexOf("Tighten the intro"),
        );
        // The interim instruction stays the last block.
        expect(second.indexOf("<reverted-turns>")).toBeLessThan(
          second.indexOf("<render-qa-pending>"),
        );
        expect(second.trimEnd().endsWith("</render-qa-pending>")).toBe(true);

        // Already announced: the next turn does not repeat it.
        await runTurnWithEntries(fixture, chat.id, "Add music");
        expect(lastPrompt(fixture)).not.toContain("<reverted-turns>");
      } finally {
        await fixture.cleanup();
      }
    });

    it("lists only turns reverted since the previous turn started, and truncates long prompts", async () => {
      const fixture = await createRuntimeFixture({ sessionIdleMs: 60_000 });
      try {
        const chat = await fixture.chats.create({});
        fixture.backend.promptScript = async () => "completed";
        const first = await runTurnWithEntries(fixture, chat.id, "First change");
        const second = await runTurnWithEntries(fixture, chat.id, `Second ${"x".repeat(200)}`);
        await fixture.turns.revert(chat.id, first.id);
        await fixture.turns.revert(chat.id, second.id);
        await runTurnWithEntries(fixture, chat.id, "Third change");
        const third = lastPrompt(fixture);
        expect(third).toContain('"First change"');
        expect(third).toContain(`"Second ${"x".repeat(113)}…"`);
        expect(third).not.toContain("x".repeat(114));

        const fourth = await runTurnWithEntries(fixture, chat.id, "Fourth change");
        expect(lastPrompt(fixture)).not.toContain("<reverted-turns>");
        await fixture.turns.revert(chat.id, fourth.id);
        await runTurnWithEntries(fixture, chat.id, "Fifth change");
        const fifth = lastPrompt(fixture);
        expect(fifth).toContain('"Fourth change"');
        expect(fifth).not.toContain('"First change"');
        expect(fifth).not.toContain('"Second');
      } finally {
        await fixture.cleanup();
      }
    });

    it("also announces reverted turns in a story-mode turn", async () => {
      const fixture = await createRuntimeFixture({ sessionIdleMs: 60_000 });
      try {
        const chat = await fixture.chats.create({});
        fixture.backend.promptScript = async () => "completed";
        const first = await runTurnWithEntries(fixture, chat.id, "Outline the story");
        await fixture.turns.revert(chat.id, first.id);
        await runTurnWithEntries(fixture, chat.id, "Review the chapters", "story");
        const prompt = lastPrompt(fixture);
        expect(prompt).toContain('- "Outline the story"');
        expect(prompt).toContain("<reverted-turns>");
      } finally {
        await fixture.cleanup();
      }
    });
  });

  it("shows a running tool's progress on its activity and drops it once the tool ends", async () => {
    const fixture = await createRuntimeFixture();
    try {
      const chat = await fixture.chats.create({});
      fixture.backend.promptScript = async (input) => {
        const call = { toolCallId: "render-1" };
        input.onEvent({
          type: "tool.start",
          ...call,
          kind: "other",
          targets: [],
          label: "Rendering video",
        });
        input.onEvent({ type: "tool.progress", ...call, progress: 41.6 });
        input.onEvent({ type: "tool.progress", ...call, progress: 41.9 });
        input.onEvent({ type: "tool.progress", ...call, progress: 140 });
        input.onEvent({ type: "tool.end", ...call, ok: true });
        return "completed";
      };
      await fixture.turns.start(chat.id, { prompt: "Render it" });
      await finishTurn(fixture, chat.id);
      const published = fixture.chats
        .events(chat.id)
        .flatMap((event) => (event.type === "activity.updated" ? [event.activity] : []));
      // 41.6 and 41.9 round to the same percent: published once; past 100 is clamped.
      expect(published.map((activity) => activity.progress)).toEqual([
        undefined,
        42,
        100,
        undefined,
      ]);
      expect(published.at(-1)).toMatchObject({ status: "done", label: "Rendering video" });
    } finally {
      await fixture.cleanup();
    }
  });
});
