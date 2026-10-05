import { appendFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ChatService } from "./chats.js";
import { renderPromptContext } from "./promptContext.js";
import { createRuntimeFixture } from "./testing/runtimeFixture.js";

describe("runtime persistence and prompt rendering", () => {
  it("round-trips events and ignores a torn final JSONL record", async () => {
    const fixture = await createRuntimeFixture();
    try {
      const chat = await fixture.chats.create({ title: "Persisted chat" });
      const eventFile = join(
        fixture.scope.projectDir,
        ".hyperframes",
        "agent",
        "chats",
        chat.id,
        "events.jsonl",
      );
      await appendFile(eventFile, '{"seq":2,"type":"chat.updated"', "utf8");

      const loaded = await fixture.store.load(chat.id);
      expect(loaded.events).toHaveLength(1);
      expect(loaded.state?.chat.title).toBe("Persisted chat");
      const reopened = await ChatService.open(fixture.scope, fixture.store, { now: fixture.now });
      expect(reopened.get(chat.id)).toEqual(loaded.state);
      await reopened.update(chat.id, { title: "Appended after recovery" });
      const afterAppend = await fixture.store.load(chat.id);
      expect(afterAppend.events).toHaveLength(2);
      expect(afterAppend.state?.chat.title).toBe("Appended after recovery");
      const stateDir = await fixture.store.stateDir(chat.id);
      expect(stateDir).toBe(
        join(fixture.scope.projectDir, ".hyperframes", "agent", "chats", chat.id, "backend"),
      );
    } finally {
      await fixture.cleanup();
    }
  });

  it("skips damaged and unknown records with a log line instead of failing every chat", async () => {
    const fixture = await createRuntimeFixture();
    const logged: string[] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => {
      logged.push(args.join(" "));
    };
    try {
      const chat = await fixture.chats.create({ title: "Survivor" });
      const eventFile = join(
        fixture.scope.projectDir,
        ".hyperframes",
        "agent",
        "chats",
        chat.id,
        "events.jsonl",
      );
      await appendFile(
        eventFile,
        [
          "this is not json",
          JSON.stringify({ seq: 2, chatId: chat.id, ts: 1, type: "from.the.future" }),
          JSON.stringify({
            seq: 3,
            chatId: chat.id,
            ts: 1,
            type: "storyOffer.updated",
            messageId: "m1",
            offer: { id: "o1", state: "mystery", chapters: [], requestedAt: 1 },
          }),
          "",
        ].join("\n"),
        "utf8",
      );

      const loaded = await fixture.store.load(chat.id);
      expect(loaded.events).toHaveLength(1);
      expect(loaded.state?.chat.title).toBe("Survivor");
      expect(logged.filter((line) => line.includes("skipping invalid chat event"))).toHaveLength(3);
      const reopened = await ChatService.open(fixture.scope, fixture.store, { now: fixture.now });
      expect(reopened.get(chat.id)?.chat.title).toBe("Survivor");
    } finally {
      console.error = original;
      await fixture.cleanup();
    }
  });

  it("drain waits for fire-and-forget emits so teardown can remove the directory", async () => {
    const fixture = await createRuntimeFixture();
    try {
      const chat = await fixture.chats.create({ title: "Drain" });
      // Hold the store write so the emit is provably still in flight when drain starts.
      const entered = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      const append = fixture.store.append.bind(fixture.store);
      fixture.store.append = async (event) => {
        entered.resolve();
        await release.promise;
        return append(event);
      };
      // The orchestrator's `onModel` path emits without awaiting: the write may still be in flight when the turn ends.
      const pending = fixture.chats.emit(chat.id, {
        type: "chat.updated",
        chat: { ...chat, title: "Late update" },
      });
      await entered.promise;
      const drained = fixture.chats.drain().then(() => "drained" as const);
      const beforeRelease = await Promise.race([
        drained,
        new Promise<"pending">((resolve) => setImmediate(() => resolve("pending"))),
      ]);
      expect(beforeRelease).toBe("pending");

      release.resolve();
      expect(await drained).toBe("drained");
      // Once drain resolves the event is on disk, before the caller awaits the emit itself.
      const loaded = await fixture.store.load(chat.id);
      expect(loaded.state?.chat.title).toBe("Late update");
      await pending;
    } finally {
      await fixture.cleanup();
    }
  });

  it("renders editor context and references as explicit prompt blocks", () => {
    const rendered = renderPromptContext(
      "Make the intro shorter",
      {
        schemaVersion: 1,
        capturedAt: 4,
        project: { id: "project-one", title: "Launch video" },
        activeComposition: { path: "compositions/intro.html" },
        timeline: { duration: 20, elementCount: 0, elements: [] },
        playhead: { time: 3, playing: false },
        selection: { clips: [], assetPath: null, previewElement: null, range: null },
        renderSettings: null,
        storyGraph: null,
      },
      [{ kind: "asset", id: "asset-ref", path: "media/logo.svg" }],
    );
    expect(rendered).toContain("Make the intro shorter");
    expect(rendered).toContain("<editor-context>");
    expect(rendered).toContain("compositions/intro.html");
    expect(rendered).toContain("<references>");
    expect(rendered).toContain('"path":"media/logo.svg"');
  });
});
