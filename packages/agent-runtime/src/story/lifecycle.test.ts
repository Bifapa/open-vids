import { describe, expect, it } from "vitest";
import type { HostToolResult } from "../backend.js";
import type { ScriptedSession } from "../testing/backend.js";
import { createRuntimeFixture, waitUntil, type RuntimeFixture } from "../testing/runtimeFixture.js";

function untilAborted(signal: AbortSignal): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  if (signal.aborted) resolve();
  else signal.addEventListener("abort", () => resolve(), { once: true });
  return promise;
}

async function settled(fixture: RuntimeFixture, chatId: string): Promise<void> {
  await waitUntil(
    () =>
      fixture.chats.get(chatId)?.turns.at(-1)?.status !== "running" &&
      fixture.turns.activeTurn === null,
    "the turn to end",
  );
}

/** Calls a host tool without the scripted session's activity events, which would write to a finished turn. */
async function callDirect(
  session: ScriptedSession | undefined,
  name: string,
  args: unknown,
): Promise<HostToolResult> {
  const tool = session?.input.hostTools.find((candidate) => candidate.name === name);
  if (!tool) throw new Error(`no ${name} tool`);
  return tool.execute(args, new AbortController().signal);
}

const ADD_CHAPTER = { operations: [{ op: "add_node", node: { kind: "chapter", title: "Intro" } }] };

describe("story writes inside the turn", () => {
  it("waits for a story edit that is in flight when the turn ends, refuses later calls, and only then closes the checkpoint", async () => {
    const fixture = await createRuntimeFixture();
    try {
      const chat = await fixture.chats.create({}, []);
      const gate = Promise.withResolvers<void>();
      let edit: Promise<HostToolResult> | null = null;
      const director: { session?: ScriptedSession } = {};
      fixture.backend.promptScript = async (_input, session) => {
        director.session = session;
        fixture.story.editGate = gate.promise;
        edit = session.callTool("edit_story", ADD_CHAPTER);
        await waitUntil(() => fixture.story.editRequests.length === 1, "the edit to reach Studio");
        return "completed";
      };

      await fixture.turns.start(chat.id, { prompt: "Plan the story", mode: "story" });
      // The Director is done; the turn closes its story tools (aborting what can be aborted) but cannot end while
      // the write is on its way.
      await waitUntil(
        () => fixture.story.editSignals[0]?.aborted === true,
        "the turn to close its story tools",
      );
      expect(fixture.turns.activeTurn).not.toBeNull();
      expect(fixture.checkpoints.windows[0]?.ended).toBe(false);
      expect(fixture.story.editFinished).toEqual([]);
      // While the turn is closing, its story tools are already refused.
      const closing = await callDirect(director.session, "read_story", {});
      expect(closing.text).toContain("no running turn");

      gate.resolve();
      await settled(fixture, chat.id);
      expect(fixture.story.editFinished).toHaveLength(1);
      expect(fixture.checkpoints.windows[0]?.ended).toBe(true);
      expect(await edit).toMatchObject({ text: expect.stringContaining("Applied 1 operation") });
      // The request carried the turn, so the service can attribute the review to it.
      expect(fixture.story.editRequests[0]?.turnId).toBe(fixture.chats.get(chat.id)?.turns[0]?.id);
    } finally {
      await fixture.cleanup();
    }
  });

  it("waits for a build in flight the same way", async () => {
    const fixture = await createRuntimeFixture();
    try {
      const chat = await fixture.chats.create({}, []);
      const gate = Promise.withResolvers<void>();
      let build: Promise<HostToolResult> | null = null;
      fixture.backend.promptScript = async (_input, session) => {
        fixture.story.buildGate = gate.promise;
        build = session.callTool("build_story", {});
        await waitUntil(
          () => fixture.story.buildRequests.length === 1,
          "the build to reach Studio",
        );
        return "completed";
      };

      await fixture.turns.start(chat.id, { prompt: "Build the story", storyAction: "build" });
      await waitUntil(() => fixture.story.buildRequests.length === 1, "the build to start");
      expect(fixture.checkpoints.windows[0]?.ended).toBe(false);

      gate.resolve();
      await settled(fixture, chat.id);
      expect(fixture.story.buildFinished).toHaveLength(1);
      expect(fixture.checkpoints.windows[0]?.ended).toBe(true);
      expect(await build).toMatchObject({ text: expect.stringContaining("Built the story") });
    } finally {
      await fixture.cleanup();
    }
  });

  it("does not send a story edit once the turn is stopping", async () => {
    const fixture = await createRuntimeFixture();
    try {
      const chat = await fixture.chats.create({}, []);
      let edit: Promise<HostToolResult> | null = null;
      fixture.backend.promptScript = async (input, session) => {
        await untilAborted(input.signal);
        edit = session.callTool("edit_story", ADD_CHAPTER);
        return "aborted";
      };
      const turn = await fixture.turns.start(chat.id, { prompt: "Plan the story", mode: "story" });
      await waitUntil(
        () => fixture.backend.sessionsOf("director")[0]?.prompts.length === 1,
        "prompt",
      );
      fixture.turns.abort(chat.id, turn.id);
      await settled(fixture, chat.id);

      expect(await edit).toMatchObject({ isError: true });
      expect(fixture.story.editRequests).toEqual([]);
    } finally {
      await fixture.cleanup();
    }
  });
});
