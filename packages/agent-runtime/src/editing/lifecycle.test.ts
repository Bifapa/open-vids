import { describe, expect, it } from "vitest";
import type { AgentRun, ChatMessage } from "@hyperframes/agent-protocol";
import type { BackendEvent, HostToolResult } from "../backend.js";
import { EditingError } from "./host.js";
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

const setComposition = {
  operations: [{ op: "set_composition", duration: 5 }],
};

const activitiesOf = (messages: ChatMessage[], run: AgentRun) =>
  messages
    .filter((message) => message.runId === run.id && message.role === "assistant")
    .flatMap((message) =>
      message.parts.flatMap((part) => (part.type === "activity" ? [part.activity] : [])),
    )
    .map((activity) => [activity.label, activity.status]);

describe("editing inside the turn's checkpoint", () => {
  it("waits for an edit that is in flight when the turn ends, and only then closes the checkpoint", async () => {
    const fixture = await createRuntimeFixture();
    try {
      const chat = await fixture.chats.create({}, []);
      const gate = Promise.withResolvers<void>();
      fixture.editing.applyGate = gate.promise;
      let inFlight: Promise<HostToolResult> | null = null;
      const director: { session?: ScriptedSession } = {};
      fixture.backend.promptScript = async (_input, session) => {
        // A closing prompt of the turn (Render QA's report) must not repeat the edit.
        if (inFlight) return "completed";
        director.session = session;
        // The model's reply ends while its edit is still being written.
        inFlight = session.callTool("edit_timeline", setComposition);
        await waitUntil(
          () => fixture.editing.applyRequests.length === 1,
          "the edit to reach Studio",
        );
        return "completed";
      };

      await fixture.turns.start(chat.id, { prompt: "Cut it" });
      // The turn is closing its editing (it told the running edit to stop waiting) but must not end yet.
      await waitUntil(
        () => fixture.editing.applySignals[0]?.aborted === true,
        "the turn to close its editing",
      );
      expect(fixture.turns.activeTurn).not.toBeNull();
      expect(fixture.checkpoints.windows[0]?.ended).toBe(false);
      expect(fixture.editing.applyFinished).toHaveLength(0);

      gate.resolve();
      await settled(fixture, chat.id);
      expect(fixture.editing.applyFinished).toHaveLength(1);
      expect(fixture.checkpoints.windows[0]?.ended).toBe(true);
      expect(await inFlight).toMatchObject({
        text: expect.stringContaining("Applied 1 operation"),
      });

      // The turn is over: the same session can no longer change the project.
      const late = await director.session?.callTool("edit_timeline", setComposition);
      expect(late).toMatchObject({ isError: true });
      expect(late?.text).toContain("no running turn");
      expect(fixture.editing.applyRequests).toHaveLength(1);
    } finally {
      await fixture.cleanup();
    }
  });

  it("cancels a running render when the turn is aborted", async () => {
    const fixture = await createRuntimeFixture();
    try {
      const chat = await fixture.chats.create({}, []);
      fixture.editing.renderGate = new Promise<void>(() => {});
      let render: Promise<HostToolResult> | null = null;
      fixture.backend.promptScript = async (input, session) => {
        render = session.callTool("render_video", { quality: "draft" });
        await untilAborted(input.signal);
        return "aborted";
      };

      const turn = await fixture.turns.start(chat.id, { prompt: "Render it" });
      await waitUntil(() => fixture.editing.renderRequests.length === 1, "the render to start");
      fixture.turns.abort(chat.id, turn.id);
      await settled(fixture, chat.id);

      expect(fixture.editing.renderCancelled).toBe(true);
      expect(await render).toMatchObject({
        isError: true,
        text: expect.stringMatching(/^aborted:/),
      });
      expect(fixture.chats.get(chat.id)?.turns[0]?.status).toBe("aborted");
      expect(fixture.checkpoints.windows[0]?.ended).toBe(true);
    } finally {
      await fixture.cleanup();
    }
  });

  it("cancels a render still running when the Director finishes, before the checkpoint closes", async () => {
    const fixture = await createRuntimeFixture();
    try {
      const chat = await fixture.chats.create({}, []);
      fixture.editing.renderGate = new Promise<void>(() => {});
      let render: Promise<HostToolResult> | null = null;
      fixture.backend.promptScript = async (_input, session) => {
        render = session.callTool("render_video", {});
        await waitUntil(() => fixture.editing.renderRequests.length === 1, "the render to start");
        return "completed";
      };

      await fixture.turns.start(chat.id, { prompt: "Render it" });
      await settled(fixture, chat.id);

      expect(fixture.editing.renderCancelled).toBe(true);
      expect(await render).toMatchObject({ isError: true });
      expect(fixture.chats.get(chat.id)?.turns[0]?.status).toBe("completed");
    } finally {
      await fixture.cleanup();
    }
  });

  it("turns a refused edit into a tool error the model can act on, and the turn carries on", async () => {
    const fixture = await createRuntimeFixture();
    try {
      const chat = await fixture.chats.create({}, []);
      fixture.editing.nextApplyError = new EditingError(
        "out_of_bounds",
        "start is past the end",
        0,
      );
      const results: HostToolResult[] = [];
      fixture.backend.promptScript = async (_input, session) => {
        results.push(await session.callTool("edit_timeline", setComposition));
        results.push(await session.callTool("edit_timeline", setComposition));
        return "completed";
      };
      await fixture.turns.start(chat.id, { prompt: "Cut it" });
      await settled(fixture, chat.id);
      expect(results[0]).toEqual({
        isError: true,
        text: "out_of_bounds (operations[0]): start is past the end",
      });
      expect(results[1]?.isError).toBeUndefined();
      expect(fixture.chats.get(chat.id)?.turns[0]?.status).toBe("completed");
    } finally {
      await fixture.cleanup();
    }
  });
});

describe("Editor orchestration", () => {
  it("lets a delegated Editor inspect and edit the timeline, with labelled activity rows on its thread", async () => {
    const fixture = await createRuntimeFixture();
    try {
      // Every specialist is on, so the Director delegates the editing instead of inheriting it.
      const chat = await fixture.chats.create({}, [
        "editor",
        "motion",
        "audio",
        "vision",
        "research",
      ]);
      let directorTools: string[] = [];
      let editorResults: HostToolResult[] = [];
      fixture.backend.promptScript = async (_input, session) => {
        if (session.input.agent === "director") {
          directorTools = session.input.hostTools.map((tool) => tool.name);
          await session.callTool("delegate", {
            agent: "editor",
            title: "Assemble the cut",
            task: "Cut assets/a.mp4 to 6 seconds and split it at 3",
          });
          await session.callTool("wait_for_agents", {});
          return "completed";
        }
        editorResults = [
          await session.callTool("inspect_timeline", {}),
          await session.callTool("edit_timeline", {
            operations: [
              { op: "add_clip", asset: "assets/a.mp4", start: 0, track: 0, duration: 6 },
              { op: "split_clip", clip: "clip-101", at: 3 },
            ],
          }),
        ];
        return "completed";
      };

      await fixture.turns.start(chat.id, { prompt: "Make a short cut" });
      await settled(fixture, chat.id);

      const state = fixture.chats.get(chat.id);
      const run = state?.runs[0];
      if (!state || !run) throw new Error("the Editor did not run");
      expect(run).toMatchObject({ agent: "editor", status: "completed" });
      expect(directorTools).not.toContain("edit_timeline");
      expect(directorTools).toContain("inspect_timeline");
      expect(editorResults.map((result) => result.isError)).toEqual([undefined, undefined]);
      expect(fixture.editing.applyRequests).toHaveLength(1);
      expect(activitiesOf(state.messages, run)).toEqual([
        ["Inspecting the timeline", "done"],
        ["Editing the timeline · 2 changes (add clip, split)", "done"],
      ]);
      expect(state.turns[0]?.status).toBe("completed");
    } finally {
      await fixture.cleanup();
    }
  });
});

describe("activity rows", () => {
  it("shows a labelled editing call as its own row between file activity groups", async () => {
    const fixture = await createRuntimeFixture();
    try {
      const chat = await fixture.chats.create({}, []);
      const read = (
        input: { onEvent: (event: BackendEvent) => void },
        id: string,
        target: string,
      ) => {
        input.onEvent({ type: "tool.start", toolCallId: id, kind: "inspect", targets: [target] });
        input.onEvent({ type: "tool.end", toolCallId: id, ok: true });
      };
      fixture.backend.promptScript = async (input, session) => {
        read(input, "r1", "a.html");
        await session.callTool("inspect_timeline", {});
        read(input, "r2", "b.html");
        return "completed";
      };
      await fixture.turns.start(chat.id, { prompt: "Look around" });
      await settled(fixture, chat.id);
      const state = fixture.chats.get(chat.id);
      const director = state?.messages.find(
        (message) => message.id === state.turns[0]?.assistantMessageId,
      );
      const rows =
        director?.role === "assistant"
          ? director.parts.flatMap((part) => (part.type === "activity" ? [part.activity] : []))
          : [];
      expect(rows.map((row) => [row.label, row.status])).toEqual([
        ["Reading a.html", "done"],
        ["Inspecting the timeline", "done"],
        ["Reading b.html", "done"],
      ]);
    } finally {
      await fixture.cleanup();
    }
  });
});
