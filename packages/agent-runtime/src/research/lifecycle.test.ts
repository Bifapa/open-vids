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

describe("research writes inside the turn", () => {
  it("waits for an import that is in flight when the turn ends, refuses later calls, and only then closes the checkpoint", async () => {
    const fixture = await createRuntimeFixture();
    await fixture.settings.update({ autonomy: { askBeforeDownloads: false } });
    try {
      const chat = await fixture.chats.create({}, ["research"]);
      const gate = Promise.withResolvers<void>();
      let importing: Promise<HostToolResult> | null = null;
      fixture.backend.promptScript = async (_input, session) => {
        if (session.input.agent === "director") {
          await session.callTool("delegate", {
            agent: "research",
            title: "Waves",
            task: "Get waves",
          });
          await session.callTool("wait_for_agents", {});
          return "completed";
        }
        // Research starts a download and ends its run without waiting for it.
        fixture.research.importGate = gate.promise;
        importing = session.callTool("import_asset", { candidate: "cand-1" });
        await waitUntil(() => fixture.research.importRequests.length === 1, "the import to start");
        return "completed";
      };

      await fixture.turns.start(chat.id, { prompt: "Add ocean footage" });
      // The turn closes its research tools (cancelling what can be cancelled) but cannot end while the import is on
      // its way: the asset it writes must land inside the checkpoint.
      await waitUntil(
        () => fixture.research.importSignals[0]?.aborted === true,
        "the turn to close its research tools",
      );
      expect(fixture.turns.activeTurn).not.toBeNull();
      expect(fixture.checkpoints.windows[0]?.ended).toBe(false);
      expect(fixture.research.importFinished).toEqual([]);
      const closing = await callDirect(
        fixture.backend.sessionsOf("research")[0],
        "read_sources",
        {},
      );
      expect(closing.text).toContain("no running turn");

      gate.resolve();
      await settled(fixture, chat.id);
      expect(fixture.research.importFinished).toHaveLength(1);
      expect(fixture.checkpoints.windows[0]?.ended).toBe(true);
      expect(await importing).toMatchObject({ text: expect.stringContaining("Imported ") });
      // The import carried the turn, so Studio attributes the asset (and its provenance) to this checkpoint.
      expect(fixture.research.importRequests[0]?.turnId).toBe(
        fixture.chats.get(chat.id)?.turns[0]?.id,
      );
    } finally {
      await fixture.cleanup();
    }
  });

  it("aborts an in-flight import when the user stops the turn, and still waits for it before the checkpoint closes", async () => {
    const fixture = await createRuntimeFixture();
    await fixture.settings.update({ autonomy: { askBeforeDownloads: false } });
    try {
      const chat = await fixture.chats.create({}, ["research"]);
      const gate = Promise.withResolvers<void>();
      fixture.research.importGate = gate.promise;
      let importing: Promise<HostToolResult> | null = null;
      fixture.backend.promptScript = async (input, session) => {
        if (session.input.agent === "director") {
          await session.callTool("delegate", {
            agent: "research",
            title: "Waves",
            task: "Get waves",
          });
          await session.callTool("wait_for_agents", {});
          return "completed";
        }
        importing = session.callTool("import_asset", { candidate: "cand-1" });
        await untilAborted(input.signal);
        return "aborted";
      };

      const turn = await fixture.turns.start(chat.id, { prompt: "Add ocean footage" });
      await waitUntil(() => fixture.research.importRequests.length === 1, "the import to start");
      expect(fixture.research.importSignals[0]?.aborted).toBe(false);
      fixture.turns.abort(chat.id, turn.id);
      await waitUntil(
        () => fixture.research.importSignals[0]?.aborted === true,
        "the import to be aborted",
      );
      expect(fixture.checkpoints.windows[0]?.ended).toBe(false);
      gate.resolve();
      await settled(fixture, chat.id);
      expect(fixture.chats.get(chat.id)?.turns[0]?.status).toBe("aborted");
      expect(fixture.checkpoints.windows[0]?.ended).toBe(true);
      await importing;
    } finally {
      await fixture.cleanup();
    }
  });
});
