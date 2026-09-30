import { describe, expect, it } from "vitest";
import type { HostToolResult } from "../backend.js";
import { SAMPLE_SOURCE } from "../testing/analysis.js";
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

describe("analysis inside the turn", () => {
  it("cancels a running analysis job when the turn is aborted", async () => {
    const fixture = await createRuntimeFixture();
    try {
      const chat = await fixture.chats.create({}, []);
      fixture.analysis.jobGate = new Promise<void>(() => {});
      let analysis: Promise<HostToolResult> | null = null;
      fixture.backend.promptScript = async (input, session) => {
        analysis = session.callTool("analyze_media", { source: SAMPLE_SOURCE });
        await untilAborted(input.signal);
        return "aborted";
      };

      const turn = await fixture.turns.start(chat.id, { prompt: "Analyze the talk" });
      await waitUntil(() => fixture.analysis.startRequests.length === 1, "the job to start");
      fixture.turns.abort(chat.id, turn.id);
      await settled(fixture, chat.id);

      expect(fixture.analysis.cancelledJobs).toEqual(["job-1"]);
      expect(await analysis).toMatchObject({
        isError: true,
        text: expect.stringMatching(/^aborted:/),
      });
      expect(fixture.chats.get(chat.id)?.turns[0]?.status).toBe("aborted");
      expect(fixture.checkpoints.windows[0]?.ended).toBe(true);
    } finally {
      await fixture.cleanup();
    }
  });

  it("cancels a job still running when the Director finishes, and refuses every call after the turn", async () => {
    const fixture = await createRuntimeFixture();
    try {
      const chat = await fixture.chats.create({}, []);
      fixture.analysis.jobGate = new Promise<void>(() => {});
      let analysis: Promise<HostToolResult> | null = null;
      const director: { session?: ScriptedSession } = {};
      fixture.backend.promptScript = async (_input, session) => {
        director.session = session;
        analysis = session.callTool("analyze_media", { source: SAMPLE_SOURCE });
        await waitUntil(() => fixture.analysis.startRequests.length === 1, "the job to start");
        return "completed";
      };

      await fixture.turns.start(chat.id, { prompt: "Analyze the talk" });
      await settled(fixture, chat.id);

      expect(fixture.analysis.cancelledJobs).toEqual(["job-1"]);
      expect(await analysis).toMatchObject({ isError: true });
      expect(fixture.chats.get(chat.id)?.turns[0]?.status).toBe("completed");

      for (const [name, args] of [
        ["analyze_media", { source: SAMPLE_SOURCE }],
        ["read_analysis", { source: SAMPLE_SOURCE }],
        ["plan_cut", { source: SAMPLE_SOURCE }],
      ] as const) {
        const late = await callDirect(director.session, name, args);
        expect(late).toMatchObject({ isError: true });
        expect(late.text).toContain("no running turn");
      }
      expect(fixture.analysis.startRequests).toHaveLength(1);
      expect(fixture.analysis.overviewRequests).toEqual([]);
      expect(fixture.analysis.planRequests).toEqual([]);
    } finally {
      await fixture.cleanup();
    }
  });

  it("waits for a rough cut whose edit is in flight when the turn ends, and only then closes the checkpoint", async () => {
    const fixture = await createRuntimeFixture();
    try {
      const chat = await fixture.chats.create({}, []);
      const gate = Promise.withResolvers<void>();
      let build: Promise<HostToolResult> | null = null;
      const director: { session?: ScriptedSession } = {};
      fixture.backend.promptScript = async (_input, session) => {
        director.session = session;
        await session.callTool("plan_cut", { source: SAMPLE_SOURCE });
        fixture.editing.applyGate = gate.promise;
        build = session.callTool("build_rough_cut", { plan: "cut-1" });
        await waitUntil(
          () => fixture.editing.applyRequests.length === 1,
          "the edit to reach Studio",
        );
        return "completed";
      };

      await fixture.turns.start(chat.id, { prompt: "Cut the talk" });
      await waitUntil(
        () => fixture.editing.applySignals[0]?.aborted === true,
        "the turn to close its analysis",
      );
      expect(fixture.turns.activeTurn).not.toBeNull();
      expect(fixture.checkpoints.windows[0]?.ended).toBe(false);
      // While the turn is closing, its tools are already refused.
      const closing = await callDirect(director.session, "plan_cut", { source: SAMPLE_SOURCE });
      expect(closing.text).toContain("no running turn");

      gate.resolve();
      await settled(fixture, chat.id);
      expect(fixture.editing.applyFinished).toHaveLength(1);
      expect(fixture.checkpoints.windows[0]?.ended).toBe(true);
      expect(await build).toMatchObject({ text: expect.stringContaining("Built cut-1") });
      expect(fixture.analysis.planRequests).toHaveLength(1);
    } finally {
      await fixture.cleanup();
    }
  });

  it("does not send a rough cut once the turn is stopping", async () => {
    const fixture = await createRuntimeFixture();
    try {
      const chat = await fixture.chats.create({}, []);
      let build: Promise<HostToolResult> | null = null;
      fixture.backend.promptScript = async (input, session) => {
        await session.callTool("plan_cut", { source: SAMPLE_SOURCE });
        await untilAborted(input.signal);
        build = session.callTool("build_rough_cut", { plan: "cut-1" });
        return "aborted";
      };
      const turn = await fixture.turns.start(chat.id, { prompt: "Cut the talk" });
      await waitUntil(() => fixture.analysis.planRequests.length === 1, "the plan");
      fixture.turns.abort(chat.id, turn.id);
      await settled(fixture, chat.id);

      expect(await build).toMatchObject({ isError: true });
      expect(fixture.editing.applyRequests).toEqual([]);
    } finally {
      await fixture.cleanup();
    }
  });
});
