import { describe, expect, it } from "vitest";
import {
  SPECIALIST_IDS,
  type AgentId,
  type ChatMessage,
  type SpecialistId,
} from "@hyperframes/agent-protocol";
import type { BackendPromptInput, BackendPromptOutcome } from "../backend.js";
import type { ScriptedSession } from "../testing/backend.js";
import { createRuntimeFixture, waitUntil, type RuntimeFixture } from "../testing/runtimeFixture.js";
import type { StreamTimerApi, StreamTimerHandle } from "../turnStream.js";
import {
  qaChat,
  quality,
  script as qaScript,
  settled as qaSettled,
  directorScript,
  visionScript,
} from "../qa/harness.js";
import { cleanCheck } from "../testing/qa.js";

/** A tool or two each specialist owns: the Director has them when nobody else does. */
const OWN_TOOLS: Readonly<Record<SpecialistId, readonly string[]>> = {
  editor: ["edit_timeline", "render_video", "plan_cut", "build_rough_cut", "save_segments"],
  vision: ["inspect_frames", "save_vision_notes", "inspect_render", "report_render_findings"],
  motion: ["edit_timeline", "browse_presets"],
  research: ["search_assets", "inspect_url", "import_asset", "resolve_missing_asset"],
  audio: ["edit_timeline"],
};

type AgentScript = (
  input: BackendPromptInput,
  session: ScriptedSession,
) => Promise<BackendPromptOutcome>;

function script(fixture: RuntimeFixture, byAgent: Partial<Record<AgentId, AgentScript>>): void {
  fixture.backend.promptScript = (input, session) =>
    (byAgent[session.input.agent] ?? (async () => "completed"))(input, session);
}

async function settled(fixture: RuntimeFixture, chatId: string): Promise<void> {
  await waitUntil(
    () =>
      fixture.chats.get(chatId)?.turns.at(-1)?.status !== "running" &&
      fixture.turns.activeTurn === null,
    "the turn to end",
  );
}

const say = (input: BackendPromptInput, text: string) =>
  input.onEvent({ type: "text.delta", delta: text });

function untilAborted(signal: AbortSignal): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  if (signal.aborted) resolve();
  else signal.addEventListener("abort", () => resolve(), { once: true });
  return promise;
}

/** Real timers, except the delays a test fires by hand (a watchdog limit, a wait timeout). */
class PickyClock implements StreamTimerApi {
  private readonly held = new Map<StreamTimerHandle, { delay: number; callback: () => void }>();

  constructor(private readonly picked: readonly number[]) {}

  setTimeout(callback: () => void, delayMs: number): StreamTimerHandle {
    if (!this.picked.includes(delayMs)) return globalThis.setTimeout(callback, delayMs);
    const handle = globalThis.setTimeout(() => undefined, 2 ** 31 - 1);
    handle.unref();
    this.held.set(handle, { delay: delayMs, callback });
    return handle;
  }

  clearTimeout(timer: StreamTimerHandle): void {
    this.held.delete(timer);
    globalThis.clearTimeout(timer);
  }

  pending(delayMs: number): number {
    return [...this.held.values()].filter((entry) => entry.delay === delayMs).length;
  }

  fire(delayMs: number): void {
    for (const [handle, entry] of [...this.held]) {
      if (entry.delay !== delayMs) continue;
      this.clearTimeout(handle);
      entry.callback();
    }
  }
}

const textOf = (message: ChatMessage | undefined) =>
  message?.parts.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("") ?? "";

/** The delegated task title a specialist prompt carries. */
const titleOf = (input: BackendPromptInput) => /<task title="([^"]*)"/.exec(input.text)?.[1] ?? "";

const OFF = { qa: undefined } as const;

describe("a specialist that is off hands its work to the Director", () => {
  it("gives the Director the tools and the working rules of every specialist that is off", async () => {
    // Render QA stays on here: the Director then also gets the render-review tools Vision would have had.
    const fixture = await createRuntimeFixture();
    try {
      const everyone = await fixture.chats.create({}, [...SPECIALIST_IDS]);
      const nobody = await fixture.chats.create({}, []);
      for (const chat of [everyone, nobody]) {
        await fixture.turns.start(chat.id, { prompt: "Hello" });
        await settled(fixture, chat.id);
      }
      const [withTeam, alone] = fixture.backend.sessionsOf("director");
      const toolsOf = (session: ScriptedSession | undefined) =>
        new Set(session?.input.hostTools.map((tool) => tool.name));

      // Alone, the Director can do every specialist's work: each tool the specialist owns is in its hands.
      const aloneTools = toolsOf(alone);
      for (const id of SPECIALIST_IDS) {
        for (const tool of OWN_TOOLS[id]) {
          expect(aloneTools.has(tool), `${id}: ${tool}`).toBe(true);
        }
      }
      // With the whole team enabled the specialists' own tools stay theirs.
      const teamTools = toolsOf(withTeam);
      for (const tool of [
        "edit_timeline",
        "plan_cut",
        "search_assets",
        "import_asset",
        "inspect_frames",
      ]) {
        expect(teamTools.has(tool), tool).toBe(false);
      }

      // The working rules of the specialists that are off ride in the Director's instructions.
      expect(alone?.input.instructions).toContain(
        "Research is off in this chat: you do its work yourself",
      );
      expect(alone?.input.instructions).toContain(
        "Editor is off in this chat: you do its work yourself",
      );
      expect(withTeam?.input.instructions).not.toContain(
        "is off in this chat: you do its work yourself",
      );
    } finally {
      await fixture.cleanup();
    }
  });

  it("names the specialists that are off, and their tools, in the team block of the turn", async () => {
    const fixture = await createRuntimeFixture(OFF);
    try {
      const chat = await fixture.chats.create({}, ["editor", "vision"]);
      await fixture.turns.start(chat.id, { prompt: "Hello" });
      await settled(fixture, chat.id);
      const prompt = fixture.backend.sessionsOf("director")[0]?.prompts[0]?.text ?? "";
      expect(prompt).toContain("Off in this chat (never delegate to them; their work is yours");
      expect(prompt).toContain("Research (search_assets");
      expect(prompt).toContain("Audio (edit_timeline)");
      expect(prompt).not.toContain("Disabled (never delegate)");
    } finally {
      await fixture.cleanup();
    }
  });

  it("names only the tools the running turn gives the Director for the work of a specialist that is off", async () => {
    const fixture = await createRuntimeFixture(OFF);
    try {
      const chat = await fixture.chats.create({}, ["vision"]);
      const promptOf = async (request: { prompt: string; storyAction?: "build" }) => {
        await fixture.turns.start(chat.id, request);
        await settled(fixture, chat.id);
        return fixture.backend.sessionsOf("director")[0]?.prompts.at(-1)?.text ?? "";
      };
      const editorLine = (prompt: string) =>
        /Editor \(([^)]*)\)/.exec(prompt.slice(prompt.indexOf("Off in this chat")))?.[1] ?? "";

      // A normal turn refuses the story build and rebuild, so the Director is not told to use them.
      const normal = editorLine(await promptOf({ prompt: "Trim the intro" }));
      expect(normal).toContain("edit_timeline");
      expect(normal).not.toContain("build_story");
      expect(normal).not.toContain("rebuild_story");

      // A build turn has build_story for the Director (there is no Editor to delegate it to), not rebuild_story.
      const build = editorLine(await promptOf({ prompt: "Build the video", storyAction: "build" }));
      expect(build).toContain("build_story");
      expect(build).not.toContain("rebuild_story");
    } finally {
      await fixture.cleanup();
    }
  });

  it("refuses to delegate to it and says which tools to use instead", async () => {
    const fixture = await createRuntimeFixture(OFF);
    try {
      const chat = await fixture.chats.create({}, ["editor"]);
      let refusal = { text: "", isError: false };
      script(fixture, {
        director: async (_input, session) => {
          const result = await session.callTool("delegate", {
            agent: "research",
            title: "Stock footage",
            task: "Find rain footage",
          });
          refusal = { text: result.text, isError: result.isError === true };
          return "completed";
        },
      });
      await fixture.turns.start(chat.id, { prompt: "Add rain" });
      await settled(fixture, chat.id);
      expect(refusal.isError).toBe(true);
      expect(refusal.text).toContain(
        "Research is off in this chat; do it yourself with search_assets",
      );
      expect(fixture.chats.get(chat.id)?.runs).toEqual([]);
    } finally {
      await fixture.cleanup();
    }
  });

  it("accepts the specialist's name the way models write it", async () => {
    const fixture = await createRuntimeFixture(OFF);
    try {
      const chat = await fixture.chats.create({}, ["editor"]);
      script(fixture, {
        director: async (_input, session) => {
          await session.callTool("delegate", { agent: "_editor", title: "Trim", task: "Trim it" });
          await session.callTool("wait_for_agents", {});
          return "completed";
        },
      });
      await fixture.turns.start(chat.id, { prompt: "Trim" });
      await settled(fixture, chat.id);
      expect(fixture.chats.get(chat.id)?.runs.map((run) => [run.agent, run.status])).toEqual([
        ["editor", "completed"],
      ]);
    } finally {
      await fixture.cleanup();
    }
  });
});

describe("delegated tasks", () => {
  it("carry the user's own words and attachments, and say when a report was cut", async () => {
    const fixture = await createRuntimeFixture(OFF);
    try {
      const chat = await fixture.chats.create({}, ["editor"]);
      let report = "";
      script(fixture, {
        director: async (_input, session) => {
          await session.callTool("delegate", {
            agent: "editor",
            title: "Trim",
            task: "Trim the intro",
          });
          report = (await session.callTool("wait_for_agents", {})).text;
          return "completed";
        },
        editor: async (input) => {
          say(input, "x".repeat(25_000));
          return "completed";
        },
      });
      await fixture.turns.start(chat.id, {
        prompt: "Make the intro punchy, keep the logo sting",
        references: [
          {
            id: "ref-1",
            kind: "video",
            source: { type: "project-path", path: "assets/intro.mp4" },
            durationSeconds: 12,
          },
        ],
      });
      await settled(fixture, chat.id);
      const task = fixture.backend.sessionsOf("editor")[0]?.prompts[0]?.text ?? "";
      expect(task).toContain("<user-request>");
      expect(task).toContain("Make the intro punchy, keep the logo sting");
      expect(task).toContain("assets/intro.mp4");
      expect(report).toContain("[Report cut here: 20000 of 25000 characters shown.");
    } finally {
      await fixture.cleanup();
    }
  });
});

describe("specialist concurrency and queues", () => {
  it("runs two Research tasks at once, the second on its own ephemeral session, and queues the third", async () => {
    const fixture = await createRuntimeFixture(OFF);
    try {
      const chat = await fixture.chats.create({}, ["research"]);
      const gates = new Map(
        ["A", "B", "C"].map((title) => [title, Promise.withResolvers<void>()] as const),
      );
      const started: string[] = [];
      let statuses: string[] = [];
      script(fixture, {
        director: async (_input, session) => {
          for (const title of ["A", "B", "C"]) {
            await session.callTool("delegate", { agent: "research", title, task: `Find ${title}` });
          }
          statuses = (fixture.chats.get(chat.id)?.runs ?? []).map((run) => run.status);
          gates.get("A")?.resolve();
          await session.callTool("wait_for_agents", {});
          return "completed";
        },
        research: async (input) => {
          const title = titleOf(input);
          started.push(title);
          await gates.get(title)?.promise;
          return "completed";
        },
      });
      await fixture.turns.start(chat.id, { prompt: "Find three clips" });
      await waitUntil(() => started.length === 3, "all three tasks to start");
      gates.get("B")?.resolve();
      gates.get("C")?.resolve();
      await settled(fixture, chat.id);

      expect(statuses).toEqual(["running", "running", "queued"]);
      const sessions = fixture.backend.sessionsOf("research");
      expect(sessions.map((session) => session.input.stateDir === null)).toEqual([false, true]);
      expect(started.slice(0, 2)).toEqual(["A", "B"]);
      expect(fixture.chats.get(chat.id)?.runs.map((run) => run.status)).toEqual([
        "completed",
        "completed",
        "completed",
      ]);
    } finally {
      await fixture.cleanup();
    }
  });

  it("frees the line when a queued run is cancelled, and tells the Director who stopped a run", async () => {
    const fixture = await createRuntimeFixture(OFF);
    try {
      const chat = await fixture.chats.create({}, ["editor"]);
      const gate = Promise.withResolvers<void>();
      const started: string[] = [];
      let queuedWhenCancelled: string | undefined;
      let report = "";
      script(fixture, {
        director: async (_input, session) => {
          const ids: string[] = [];
          for (const title of ["A", "B", "C"]) {
            const result = await session.callTool("delegate", {
              agent: "editor",
              title,
              task: title,
            });
            ids.push(/run (\S+)\)/.exec(result.text)?.[1] ?? "");
          }
          await session.callTool("cancel_agent", { runId: ids[1], reason: "not needed" });
          await waitUntil(
            () =>
              fixture.chats.get(chat.id)?.runs.find((run) => run.id === ids[1])?.status ===
              "cancelled",
            "the queued run to be cancelled",
          );
          queuedWhenCancelled = fixture.chats
            .get(chat.id)
            ?.runs.find((run) => run.id === ids[1])?.status;
          gate.resolve();
          report = (await session.callTool("wait_for_agents", {})).text;
          return "completed";
        },
        editor: async (input) => {
          started.push(titleOf(input));
          await gate.promise;
          return "completed";
        },
      });
      await fixture.turns.start(chat.id, { prompt: "Three jobs" });
      await settled(fixture, chat.id);
      // B left the line at once, while A was still holding it; C ran after A.
      expect(queuedWhenCancelled).toBe("cancelled");
      expect(started).toEqual(["A", "C"]);
      expect(report).toContain("stopped on your request (not needed)");
    } finally {
      await fixture.cleanup();
    }
  });

  it("lets the user stop one run: the turn goes on and the Director is told not to restart it", async () => {
    const fixture = await createRuntimeFixture(OFF);
    try {
      const chat = await fixture.chats.create({}, ["editor", "motion"]);
      const release = Promise.withResolvers<void>();
      let report = "";
      script(fixture, {
        director: async (_input, session) => {
          await session.callTool("delegate", { agent: "editor", title: "Cut", task: "Cut it" });
          await session.callTool("delegate", { agent: "motion", title: "Title", task: "Title it" });
          report = (await session.callTool("wait_for_agents", {})).text;
          return "completed";
        },
        editor: async (_input, session) => {
          await untilAborted(session.prompts.at(-1)?.signal ?? new AbortController().signal);
          return "aborted";
        },
        motion: async (input) => {
          await release.promise;
          say(input, "Title added.");
          return "completed";
        },
      });
      const turn = await fixture.turns.start(chat.id, { prompt: "Cut and title" });
      await waitUntil(
        () => fixture.chats.get(chat.id)?.runs.some((run) => run.agent === "motion") ?? false,
        "both runs",
      );
      const editorRun = fixture.chats.get(chat.id)?.runs.find((run) => run.agent === "editor");
      const cancelled = await fixture.turns.cancelRun(
        chat.id,
        turn.id,
        editorRun?.id ?? "",
        "too slow",
      );
      release.resolve();
      await settled(fixture, chat.id);

      expect(cancelled.run.status).toBe("cancelled");
      expect(fixture.chats.get(chat.id)?.turns[0]?.status).toBe("completed");
      expect(report).toContain("stopped by the user. Do not start it again unless the user asks");
      expect(report).toContain("Title added.");
    } finally {
      await fixture.cleanup();
    }
  });

  it("puts a message to a queued run in front of its task", async () => {
    const fixture = await createRuntimeFixture(OFF);
    try {
      const chat = await fixture.chats.create({}, ["editor"]);
      const gate = Promise.withResolvers<void>();
      let reply = "";
      script(fixture, {
        director: async (_input, session) => {
          await session.callTool("delegate", { agent: "editor", title: "A", task: "first" });
          const second = await session.callTool("delegate", {
            agent: "editor",
            title: "B",
            task: "second",
          });
          const runId = /run (\S+)\)/.exec(second.text)?.[1] ?? "";
          reply = (await session.callTool("message_agent", { runId, text: "Make it 3 seconds" }))
            .text;
          gate.resolve();
          await session.callTool("wait_for_agents", {});
          return "completed";
        },
        editor: async (input) => {
          if (titleOf(input) === "A") await gate.promise;
          return "completed";
        },
      });
      await fixture.turns.start(chat.id, { prompt: "Two jobs" });
      await settled(fixture, chat.id);
      const prompts =
        fixture.backend.sessionsOf("editor")[0]?.prompts.map((prompt) => prompt.text) ?? [];
      expect(reply).toContain("has not started yet (queued)");
      expect(prompts[0]).not.toContain("<corrections>");
      expect(prompts[1]).toContain("<corrections>");
      expect(prompts[1]).toContain("Make it 3 seconds");
      expect(prompts[1]).toContain("second");
    } finally {
      await fixture.cleanup();
    }
  });
});

describe("waiting for delegated runs", () => {
  it("holds until the timeout and reports what is still going, then gives the result", async () => {
    const clock = new PickyClock([7_000]);
    const fixture = await createRuntimeFixture({ ...OFF, timers: clock });
    try {
      const chat = await fixture.chats.create({}, ["editor"]);
      const gate = Promise.withResolvers<void>();
      const waits: string[] = [];
      script(fixture, {
        director: async (_input, session) => {
          await session.callTool("delegate", { agent: "editor", title: "Slow", task: "Slow job" });
          waits.push((await session.callTool("wait_for_agents", { timeoutSeconds: 7 })).text);
          gate.resolve();
          waits.push((await session.callTool("wait_for_agents", {})).text);
          return "completed";
        },
        editor: async (input) => {
          await gate.promise;
          say(input, "Done slowly.");
          return "completed";
        },
      });
      await fixture.turns.start(chat.id, { prompt: "Slow work" });
      await waitUntil(() => clock.pending(7_000) === 1, "the wait to start");
      clock.fire(7_000);
      await settled(fixture, chat.id);
      expect(waits[0]).toContain("still working");
      expect(waits[0]).toContain("Waited 7 seconds; 1 of these runs is still going");
      expect(waits[1]).toContain("Done slowly.");
    } finally {
      await fixture.cleanup();
    }
  });

  it("returns as soon as one run has finished when asked for until: any", async () => {
    const fixture = await createRuntimeFixture(OFF);
    try {
      const chat = await fixture.chats.create({}, ["editor", "motion"]);
      const gate = Promise.withResolvers<void>();
      let first = "";
      script(fixture, {
        director: async (_input, session) => {
          await session.callTool("delegate", { agent: "editor", title: "Long", task: "long" });
          await session.callTool("delegate", { agent: "motion", title: "Quick", task: "quick" });
          first = (await session.callTool("wait_for_agents", { until: "any" })).text;
          gate.resolve();
          await session.callTool("wait_for_agents", {});
          return "completed";
        },
        editor: async () => {
          await gate.promise;
          return "completed";
        },
        motion: async (input) => {
          say(input, "Quick done.");
          return "completed";
        },
      });
      await fixture.turns.start(chat.id, { prompt: "Two jobs" });
      await settled(fixture, chat.id);
      expect(first).toContain("Quick done.");
      expect(first).toContain('"Long"');
      expect(first).toContain("still working");
    } finally {
      await fixture.cleanup();
    }
  });
});

describe("a run that stops answering", () => {
  it("is stopped with a clear reason, and the turn goes on", async () => {
    const clock = new PickyClock([12_345]);
    const fixture = await createRuntimeFixture({ ...OFF, timers: clock, promptStallMs: 12_345 });
    try {
      const chat = await fixture.chats.create({}, ["editor"]);
      let report = "";
      script(fixture, {
        director: async (_input, session) => {
          await session.callTool("delegate", { agent: "editor", title: "Stuck", task: "Hang" });
          report = (await session.callTool("wait_for_agents", {})).text;
          return "completed";
        },
        editor: async (input) => {
          say(input, "Starting.");
          await untilAborted(input.signal);
          return "aborted";
        },
      });
      await fixture.turns.start(chat.id, { prompt: "Hang" });
      // The Director's own prompt watchdog and the run's: the run's is the second to be armed.
      await waitUntil(
        () => clock.pending(12_345) >= 2 && fixture.backend.sessionsOf("editor").length > 0,
        "the run's watchdog to be armed",
      );
      clock.fire(12_345);
      await settled(fixture, chat.id);
      const run = fixture.chats.get(chat.id)?.runs[0];
      expect(run).toMatchObject({ agent: "editor", status: "failed" });
      expect(run?.error?.message).toContain("No progress for 12 seconds");
      expect(report).toContain("Error: No progress for 12 seconds");
      expect(fixture.chats.get(chat.id)?.turns[0]?.status).toBe("completed");
    } finally {
      await fixture.cleanup();
    }
  });
});

describe("Jev", () => {
  it("reads the project through host tools instead of editing files blind", async () => {
    const fixture = await createRuntimeFixture(OFF);
    try {
      const chat = await fixture.chats.create({}, ["editor"]);
      fixture.backend.catalog = {
        models: [
          { provider: "anthropic", modelId: "haiku", name: "haiku", reasoning: true, efforts: [] },
        ],
        defaultModel: null,
        defaultThinking: null,
      };
      await fixture.settings.update({
        jev: {
          enabled: true,
          provider: "anthropic",
          modelId: "haiku",
          credentials: "provider-login",
          thinking: null,
        },
      });
      script(fixture, {
        director: async (_input, session) => {
          await session.callTool("jev", { title: "Look", task: "What is on the timeline?" });
          return "completed";
        },
      });
      await fixture.turns.start(chat.id, { prompt: "Peek" });
      await settled(fixture, chat.id);
      const jev = fixture.backend.sessionsOf("jev")[0];
      expect(jev?.input.hostTools.map((tool) => tool.name).sort()).toEqual(
        ["inspect_project", "inspect_timeline", "read_analysis", "read_story"].sort(),
      );
      expect(textOf(fixture.chats.get(chat.id)?.messages.at(-1))).toBeDefined();
    } finally {
      await fixture.cleanup();
    }
  });
});

describe("the plan the user sees", () => {
  it("lists the work the Director delegated, not the Render QA review the runtime starts itself", async () => {
    const fixture = await createRuntimeFixture();
    try {
      const chatId = await qaChat(fixture, quality(1), ["editor", "vision"]);
      fixture.qa.checkResults = [cleanCheck()];
      const director = directorScript(fixture, {
        first: async (session) => {
          await session.callTool("delegate", { agent: "editor", title: "Trim", task: "Trim it" });
          await session.callTool("wait_for_agents", {});
          fixture.qa.bump();
        },
      });
      qaScript(fixture, { director: director.run, vision: visionScript([]) });
      await fixture.turns.start(chatId, { prompt: "Trim the intro" });
      await qaSettled(fixture, chatId);
      const state = fixture.chats.get(chatId);
      expect(state?.runs.map((run) => run.title)).toContain("Render QA · pass 1");
      expect(state?.turns[0]?.plan?.steps.map((step) => step.title)).toEqual([
        "Trim",
        "Review and assemble the result",
      ]);
    } finally {
      await fixture.cleanup();
    }
  });
});
