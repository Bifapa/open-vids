import { describe, expect, it } from "vitest";
import {
  foldChatEvents,
  type AgentId,
  type AgentModelInfo,
  type AgentRun,
  type ChatMessage,
  type ModelSelection,
} from "@hyperframes/agent-protocol";
import type { BackendPromptInput, BackendPromptOutcome, HostToolResult } from "./backend.js";
import { ChatService } from "./chats.js";
import type { ScriptedSession } from "./testing/backend.js";
import { createRuntimeFixture, waitUntil, type RuntimeFixture } from "./testing/runtimeFixture.js";
import { TurnRunner } from "./turns.js";

/** The editing tools the Editor (and a Director without an Editor) gets, in registration order. */
const EDITOR_TOOLS = [
  "inspect_project",
  "inspect_timeline",
  "browse_presets",
  "render_video",
  "edit_timeline",
];

/** The analysis tools the Editor gets. */
const ANALYSIS_TOOLS_EDITOR = [
  "analyze_media",
  "read_analysis",
  "read_transcript",
  "save_segments",
  "plan_cut",
  "build_rough_cut",
];

/** A Director with neither Vision nor Editor enabled does that work itself. */
const ANALYSIS_TOOLS_SOLO = [
  "analyze_media",
  "read_analysis",
  "read_transcript",
  "save_segments",
  "inspect_frames",
  "save_vision_notes",
  "plan_cut",
  "build_rough_cut",
];

type AgentScript = (
  input: BackendPromptInput,
  session: ScriptedSession,
) => Promise<BackendPromptOutcome>;

function script(fixture: RuntimeFixture, byAgent: Partial<Record<AgentId, AgentScript>>): void {
  fixture.backend.promptScript = (input, session) =>
    (byAgent[session.input.agent] ?? (async () => "completed"))(input, session);
}

const say = (input: BackendPromptInput, text: string) =>
  input.onEvent({ type: "text.delta", delta: text });

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

const textOf = (message: ChatMessage | undefined) =>
  message?.parts.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("") ?? "";

function modelInfo(model: ModelSelection): AgentModelInfo {
  return { ...model, name: model.modelId, reasoning: true, efforts: ["low", "medium", "high"] };
}

describe("multi-agent orchestration", () => {
  it("runs specialists in parallel inside the Director turn and returns their reports", async () => {
    const fixture = await createRuntimeFixture();
    try {
      const chat = await fixture.chats.create({}, ["editor", "vision"]);
      const editorGate = Promise.withResolvers<void>();
      let checkpointOpenWhenEditorFinished = false;
      let waitReport = "";
      script(fixture, {
        director: async (input, session) => {
          await session.callTool("update_plan", {
            steps: [
              { title: "Trim intro", status: "running", agent: "editor" },
              { title: "Check framing", status: "running", agent: "vision" },
            ],
          });
          const editor = await session.callTool("delegate", {
            agent: "editor",
            title: "Trim intro",
            task: "Trim the intro to 3 seconds",
          });
          const vision = await session.callTool("delegate", {
            agent: "vision",
            title: "Check framing",
            task: "Check the framing of the intro",
          });
          expect([editor.isError, vision.isError]).toEqual([undefined, undefined]);
          waitReport = (await session.callTool("wait_for_agents", {})).text;
          await session.callTool("update_plan", {
            steps: [
              { title: "Trim intro", status: "done", agent: "editor" },
              { title: "Check framing", status: "done", agent: "vision" },
            ],
          });
          say(input, "Intro trimmed and framing checked.");
          return "completed";
        },
        editor: async (input) => {
          say(input, "**Report:**\nTrimmed the intro to 3 s in index.html.");
          // Vision releases this gate: the two specialists must be running at the same time.
          await editorGate.promise;
          checkpointOpenWhenEditorFinished = fixture.checkpoints.windows[0]?.ended === false;
          return "completed";
        },
        vision: async (input) => {
          say(input, "Framing is fine.");
          editorGate.resolve();
          return "completed";
        },
      });

      await fixture.turns.start(chat.id, { prompt: "Tighten the intro" });
      await settled(fixture, chat.id);

      const state = fixture.chats.get(chat.id);
      if (!state) throw new Error("chat missing");
      const turn = state.turns[0];
      expect(turn?.status).toBe("completed");
      expect(turn?.plan?.steps.map((step) => [step.title, step.status])).toEqual([
        ["Trim intro", "done"],
        ["Check framing", "done"],
      ]);
      expect(state.runs.map((run) => [run.agent, run.status, run.parentRunId])).toEqual([
        ["editor", "completed", null],
        ["vision", "completed", null],
      ]);
      expect(state.runs[0]?.summary).toBe("Trimmed the intro to 3 s in index.html.");
      expect(waitReport).toContain("Trimmed the intro to 3 s");
      expect(waitReport).toContain("Framing is fine.");

      // One checkpoint for the whole turn, still open while the specialists worked.
      expect(fixture.checkpoints.windows).toHaveLength(1);
      expect(checkpointOpenWhenEditorFinished).toBe(true);

      // Main thread: the Director's reply holds the delegation points; each run has its own thread.
      const director = state.messages.find((message) => message.id === turn?.assistantMessageId);
      expect(
        director?.role === "assistant"
          ? director.parts.flatMap((part) => (part.type === "delegation" ? [part.runId] : []))
          : [],
      ).toEqual(state.runs.map((run) => run.id));
      const editorRun = state.runs[0];
      const editorThread = state.messages.filter((message) => message.runId === editorRun?.id);
      expect(editorThread.map((message) => message.role)).toEqual(["task", "assistant"]);
      expect(textOf(editorThread[0])).toBe("Trim the intro to 3 seconds");
      expect(editorThread[1]).toMatchObject({ agent: "editor", status: "complete" });

      // Each specialist keeps its own resumable session beside the Director's, without delegation tools.
      const editorSession = fixture.backend.sessionsOf("editor")[0];
      expect(editorSession?.input.stateDir).toMatch(/agents[/\\]editor$/);
      expect(editorSession?.input.hostTools.map((tool) => tool.name)).toEqual([
        ...EDITOR_TOOLS,
        ...ANALYSIS_TOOLS_EDITOR,
        "read_story",
      ]);
    } finally {
      await fixture.cleanup();
    }
  });

  it("refuses disabled specialists and keeps delegation one level deep", async () => {
    const fixture = await createRuntimeFixture();
    try {
      const chat = await fixture.chats.create({}, ["editor"]);
      let refusal = "";
      let nestedDelegation: unknown = null;
      script(fixture, {
        director: async (_input, session) => {
          const delegate = session.input.hostTools.find((tool) => tool.name === "delegate");
          expect(delegate?.parameters).toMatchObject({
            properties: { agent: { enum: ["editor"] } },
          });
          refusal = (
            await session.callTool("delegate", {
              agent: "audio",
              title: "Music",
              task: "Add music",
            })
          ).text;
          await session.callTool("delegate", { agent: "editor", title: "Cut", task: "Cut" });
          await session.callTool("wait_for_agents", {});
          return "completed";
        },
        editor: async (_input, session) => {
          nestedDelegation = await session
            .callTool("delegate", { agent: "vision", title: "x", task: "x" })
            .catch((error: unknown) => error);
          return "completed";
        },
      });

      await fixture.turns.start(chat.id, { prompt: "Add music and cut" });
      await settled(fixture, chat.id);

      expect(refusal).toContain("Audio is not enabled in this chat");
      expect(nestedDelegation).toBeInstanceOf(Error);
      expect(fixture.backend.sessionsOf("audio")).toHaveLength(0);
      expect(fixture.chats.get(chat.id)?.runs.map((run) => run.agent)).toEqual(["editor"]);

      // A chat with no specialists gives the Director no delegation tools at all.
      const solo = await fixture.chats.create({}, []);
      script(fixture, {});
      await fixture.turns.start(solo.id, { prompt: "Just do it" });
      await settled(fixture, solo.id);
      const soloDirector = fixture.backend.sessionsOf("director").at(-1);
      expect(soloDirector?.input.hostTools.map((tool) => tool.name)).toEqual([
        "update_plan",
        ...EDITOR_TOOLS,
        ...ANALYSIS_TOOLS_SOLO,
        "read_story",
        "read_website",
        "get_website_file",
        "record_website",
      ]);
    } finally {
      await fixture.cleanup();
    }
  });

  it("runs each agent on its configured model and lets the Director route only within limits", async () => {
    const fixture = await createRuntimeFixture();
    try {
      const director: ModelSelection = { provider: "p", modelId: "director" };
      const editorModel: ModelSelection = { provider: "p", modelId: "editor" };
      const cheap: ModelSelection = { provider: "p", modelId: "cheap" };
      const visionOverride: ModelSelection = { provider: "p", modelId: "vision-chat" };
      fixture.backend.catalog = {
        models: [director, editorModel, cheap, visionOverride].map(modelInfo),
        defaultModel: director,
        defaultThinking: "medium",
      };
      await fixture.settings.update({
        director: { model: director, thinking: "high" },
        specialists: {
          editor: {
            model: editorModel,
            thinking: "medium",
            allowedModels: [cheap],
            enabledByDefault: true,
          },
        },
      });
      const chat = await fixture.chats.create({}, ["editor", "vision"]);
      await fixture.chats.update(chat.id, {
        agentOverrides: { vision: { model: visionOverride, thinking: "low", allowedModels: [] } },
      });
      const refusals: string[] = [];
      script(fixture, {
        director: async (_input, session) => {
          await session.callTool("delegate", {
            agent: "editor",
            title: "Quick trim",
            task: "Trim",
            model: "p/cheap",
            thinking: "low",
          });
          await session.callTool("delegate", { agent: "vision", title: "Look", task: "Look" });
          for (const args of [
            { agent: "vision", title: "x", task: "x", model: "p/editor" },
            { agent: "editor", title: "x", task: "x", thinking: "max" },
          ]) {
            refusals.push((await session.callTool("delegate", args)).text);
          }
          await session.callTool("wait_for_agents", {});
          return "completed";
        },
      });

      await fixture.turns.start(chat.id, { prompt: "Go" });
      await settled(fixture, chat.id);

      const prompts = (agent: AgentId) =>
        fixture.backend.sessionsOf(agent).flatMap((session) => session.prompts);
      expect(prompts("director")[0]).toMatchObject({ model: director, thinking: "high" });
      expect(prompts("editor")[0]).toMatchObject({ model: cheap, thinking: "low" });
      expect(prompts("vision")[0]).toMatchObject({ model: visionOverride, thinking: "low" });
      expect(fixture.chats.get(chat.id)?.runs.map((run) => run.routedByDirector)).toEqual([
        true,
        false,
      ]);
      expect(refusals[0]).toContain("has not allowed other models");
      expect(refusals[1]).toContain("limited to medium");
    } finally {
      await fixture.cleanup();
    }
  });

  it("queues a second task for a busy specialist instead of running it concurrently", async () => {
    const fixture = await createRuntimeFixture();
    try {
      const chat = await fixture.chats.create({}, ["editor"]);
      let running = 0;
      let peak = 0;
      const firstTask = Promise.withResolvers<void>();
      script(fixture, {
        director: async (_input, session) => {
          await session.callTool("delegate", { agent: "editor", title: "One", task: "1" });
          await session.callTool("delegate", { agent: "editor", title: "Two", task: "2" });
          expect(fixture.chats.get(chat.id)?.runs.map((run) => run.status)).toEqual([
            "running",
            "queued",
          ]);
          firstTask.resolve();
          await session.callTool("wait_for_agents", {});
          return "completed";
        },
        editor: async () => {
          running += 1;
          peak = Math.max(peak, running);
          await firstTask.promise;
          running -= 1;
          return "completed";
        },
      });
      await fixture.turns.start(chat.id, { prompt: "Two edits" });
      await settled(fixture, chat.id);
      expect(peak).toBe(1);
      // The Director published no plan, so normal mode derives one from its runs.
      expect(
        fixture.chats
          .get(chat.id)
          ?.turns[0]?.plan?.steps.map((step) => [step.title, step.status, step.agent]),
      ).toEqual([
        ["One", "done", "editor"],
        ["Two", "done", "editor"],
        ["Review and assemble the result", "done", "director"],
      ]);
      expect(fixture.chats.get(chat.id)?.runs.map((run) => run.status)).toEqual([
        "completed",
        "completed",
      ]);
    } finally {
      await fixture.cleanup();
    }
  });

  it("aborting the turn stops running specialists before the checkpoint closes", async () => {
    const fixture = await createRuntimeFixture();
    try {
      const chat = await fixture.chats.create({}, ["editor"]);
      let checkpointOpenWhenStopped = false;
      script(fixture, {
        director: async (input, session) => {
          await session.callTool("delegate", { agent: "editor", title: "Long", task: "Long" });
          await session.callTool("wait_for_agents", {}, input.signal);
          return "aborted";
        },
        editor: async (input) => {
          await untilAborted(input.signal);
          checkpointOpenWhenStopped = fixture.checkpoints.windows[0]?.ended === false;
          return "aborted";
        },
      });
      const turn = await fixture.turns.start(chat.id, { prompt: "Long job" });
      await waitUntil(
        () => fixture.chats.get(chat.id)?.runs[0]?.status === "running",
        "the editor to start",
      );
      fixture.turns.abort(chat.id, turn.id);
      await settled(fixture, chat.id);

      const events = fixture.chats.events(chat.id);
      const runEnded = events.findIndex((event) => event.type === "agent.completed");
      const turnEnded = events.findIndex((event) => event.type === "turn.aborted");
      expect(fixture.chats.get(chat.id)?.runs[0]?.status).toBe("aborted");
      expect(runEnded).toBeGreaterThan(-1);
      expect(runEnded).toBeLessThan(turnEnded);
      expect(checkpointOpenWhenStopped).toBe(true);
      expect(fixture.checkpoints.windows[0]?.ended).toBe(true);
    } finally {
      await fixture.cleanup();
    }
  });

  it("force-closes a specialist that ignores the abort, so no run outlives the turn", async () => {
    const fixture = await createRuntimeFixture({ stopGraceMs: 10 });
    try {
      const chat = await fixture.chats.create({}, ["editor"]);
      script(fixture, {
        director: async (input, session) => {
          await session.callTool("delegate", { agent: "editor", title: "Stuck", task: "x" });
          await session.callTool("wait_for_agents", {}, input.signal);
          return "aborted";
        },
        editor: () => new Promise<BackendPromptOutcome>(() => undefined),
      });
      const turn = await fixture.turns.start(chat.id, { prompt: "Stuck job" });
      await waitUntil(
        () => fixture.chats.get(chat.id)?.runs[0]?.status === "running",
        "the editor to start",
      );
      fixture.turns.abort(chat.id, turn.id);
      await settled(fixture, chat.id);
      expect(fixture.chats.get(chat.id)?.runs[0]?.status).toBe("aborted");
      expect(fixture.backend.sessionsOf("editor")[0]?.disposed).toBe(true);
      expect(fixture.chats.get(chat.id)?.turns[0]?.status).toBe("aborted");
    } finally {
      await fixture.cleanup();
    }
  });

  it("re-prompts a Director that ended without collecting its runs", async () => {
    const fixture = await createRuntimeFixture();
    try {
      const chat = await fixture.chats.create({}, ["editor"]);
      script(fixture, {
        director: async (input, session) => {
          if (session.prompts.length === 1) {
            await session.callTool("delegate", { agent: "editor", title: "Trim", task: "Trim" });
            say(input, "Started the editor.");
          } else {
            say(input, " Done: trimmed.");
          }
          return "completed";
        },
        editor: async (input) => {
          say(input, "Trimmed to 3 s.");
          return "completed";
        },
      });
      await fixture.turns.start(chat.id, { prompt: "Trim" });
      await settled(fixture, chat.id);
      const director = fixture.backend.sessionsOf("director")[0];
      expect(director?.prompts).toHaveLength(2);
      expect(director?.prompts[1]?.text).toContain("<delegated-results>");
      expect(director?.prompts[1]?.text).toContain("Trimmed to 3 s.");
      const reply = fixture.chats
        .get(chat.id)
        ?.messages.find((message) => message.role === "assistant" && !message.runId);
      expect(reply?.parts.flatMap((part) => (part.type === "text" ? [part.text] : []))).toEqual([
        "Started the editor.",
        " Done: trimmed.",
      ]);
      expect(fixture.chats.get(chat.id)?.turns[0]?.status).toBe("completed");
    } finally {
      await fixture.cleanup();
    }
  });

  it("steering reaches the Director while it waits, and it can cancel a run", async () => {
    const fixture = await createRuntimeFixture();
    try {
      const chat = await fixture.chats.create({}, ["editor"]);
      let waitResult = "";
      script(fixture, {
        director: async (input, session) => {
          const started = await session.callTool("delegate", {
            agent: "editor",
            title: "Music pass",
            task: "Add loud music",
          });
          const runId = /run ([^)]+)\)/.exec(started.text)?.[1];
          waitResult = (await session.callTool("wait_for_agents", {}, input.signal)).text;
          await session.callTool("cancel_agent", { runId });
          await session.callTool("wait_for_agents", {}, input.signal);
          return "completed";
        },
        editor: async (input) => {
          await untilAborted(input.signal);
          return "aborted";
        },
      });
      const turn = await fixture.turns.start(chat.id, { prompt: "Add music" });
      await waitUntil(
        () => fixture.chats.get(chat.id)?.runs[0]?.status === "running",
        "the editor to start",
      );
      await fixture.turns.steer(chat.id, turn.id, { text: "Actually, no music." });
      await settled(fixture, chat.id);

      expect(fixture.backend.sessionsOf("director")[0]?.steering).toEqual(["Actually, no music."]);
      expect(waitResult).toContain("still working");
      expect(waitResult).toContain("new instruction");
      expect(fixture.chats.get(chat.id)?.runs[0]?.status).toBe("cancelled");
      expect(fixture.chats.get(chat.id)?.turns[0]?.status).toBe("completed");
    } finally {
      await fixture.cleanup();
    }
  });

  it("persists specialist threads across a restart and closes runs a crash left open", async () => {
    const fixture = await createRuntimeFixture();
    try {
      const chat = await fixture.chats.create({}, ["editor"]);
      script(fixture, {
        director: async (_input, session) => {
          await session.callTool("delegate", { agent: "editor", title: "Trim", task: "Trim" });
          await session.callTool("wait_for_agents", {});
          return "completed";
        },
        editor: async (input) => {
          say(input, "Trimmed.");
          return "completed";
        },
      });
      await fixture.turns.start(chat.id, { prompt: "Trim" });
      await settled(fixture, chat.id);
      const before = fixture.chats.get(chat.id);
      const finishedRun = before?.runs[0];
      const finishedTurn = before?.turns[0];
      if (!before || !finishedRun || !finishedTurn) throw new Error("expected a finished run");

      const reloaded = await ChatService.open(fixture.scope, fixture.store, { now: fixture.now });
      expect(reloaded.get(chat.id)).toEqual(before);

      // A crash in the middle of a delegated run: the log ends with the turn and the run still running.
      const turnId = "crashed-turn";
      const run: AgentRun = {
        id: "crashed-run",
        turnId,
        agent: "editor",
        parentRunId: null,
        title: finishedRun.title,
        status: "running",
        model: null,
        thinking: null,
        routedByDirector: false,
        taskMessageId: "crashed-task",
        assistantMessageId: "crashed-reply",
        startedAt: 1,
        summary: null,
      };
      await reloaded.emit(chat.id, {
        type: "turn.started",
        turn: { ...finishedTurn, id: turnId, status: "running", checkpoint: null },
        promptMessage: {
          id: "crashed-prompt",
          chatId: chat.id,
          turnId,
          createdAt: 1,
          role: "user",
          steering: false,
          parts: [{ type: "text", id: "t", text: "Again" }],
        },
        assistantMessage: {
          id: "crashed-director",
          chatId: chat.id,
          turnId,
          createdAt: 1,
          role: "assistant",
          parts: [],
          status: "streaming",
          model: null,
        },
      });
      await reloaded.emit(chat.id, {
        type: "agent.started",
        run,
        parentMessageId: "crashed-director",
        taskMessage: {
          id: "crashed-task",
          chatId: chat.id,
          turnId,
          createdAt: 1,
          role: "task",
          runId: run.id,
          agent: "editor",
          from: "director",
          parts: [{ type: "text", id: "t2", text: "Trim again" }],
          steering: false,
        },
        assistantMessage: {
          id: "crashed-reply",
          chatId: chat.id,
          turnId,
          createdAt: 1,
          role: "assistant",
          parts: [],
          status: "streaming",
          model: null,
          runId: run.id,
          agent: "editor",
        },
      });

      const restartedChats = await ChatService.open(fixture.scope, fixture.store, {
        now: fixture.now,
      });
      const restarted = new TurnRunner(
        restartedChats,
        fixture.backend,
        fixture.checkpoints,
        fixture.store,
        fixture.settings,
        { now: fixture.now },
      );
      await restarted.recoverCheckpoints();
      const recovered = restartedChats.get(chat.id);
      expect(recovered?.runs.find((entry) => entry.id === "crashed-run")?.status).toBe(
        "interrupted",
      );
      expect(recovered?.turns.find((entry) => entry.id === turnId)?.status).toBe("interrupted");
      expect(recovered?.messages.find((message) => message.id === "crashed-reply")).toMatchObject({
        status: "aborted",
      });
      // The fold of the log on disk agrees with the live state.
      expect(foldChatEvents(restartedChats.events(chat.id))).toEqual(recovered);
      await restarted.dispose();
    } finally {
      await fixture.cleanup();
    }
  });
});

const activityRows = (messages: ChatMessage[], match: (message: ChatMessage) => boolean) =>
  messages
    .filter((message) => match(message) && message.role === "assistant")
    .flatMap((message) =>
      message.parts.flatMap((part) => (part.type === "activity" ? [part.activity] : [])),
    )
    .map((activity) => [activity.label, activity.status]);

describe("long-form pipeline orchestration", () => {
  it("routes analysis tools to the Director, Vision and Editor runs and keeps the rough cut in one edit", async () => {
    const fixture = await createRuntimeFixture();
    try {
      const chat = await fixture.chats.create({}, ["editor", "vision"]);
      const source = "assets/raw-talk.mp4";
      let frames: HostToolResult | null = null;
      let build: HostToolResult | null = null;
      const toolsOf = (session: ScriptedSession) =>
        session.input.hostTools.map((tool) => tool.name);
      script(fixture, {
        director: async (input, session) => {
          await session.callTool("analyze_media", { source });
          const vision = await session.callTool("delegate", {
            agent: "vision",
            title: "Look at the flagged frames",
            task: `Inspect the open vision targets of ${source} and save notes`,
          });
          const segmentation = await session.callTool("delegate", {
            agent: "editor",
            title: "Segment the talk",
            task: `Read the transcript of ${source} and save the semantic segments`,
          });
          expect([vision.isError, segmentation.isError]).toEqual([undefined, undefined]);
          await session.callTool("wait_for_agents", {});
          await session.callTool("delegate", {
            agent: "editor",
            title: "Build the rough cut",
            task: `Plan the cut of ${source} and build it on the timeline`,
          });
          await session.callTool("wait_for_agents", {});
          say(input, "Rough cut is on the timeline.");
          return "completed";
        },
        vision: async (_input, session) => {
          frames = await session.callTool("inspect_frames", { source, times: [100.5, 101.5] });
          await session.callTool("save_vision_notes", {
            source,
            notes: [
              {
                start: 100,
                end: 102,
                frames: [100.5, 101.5],
                quality: "unusable",
                tags: ["black"],
                finding: "Black frames.",
              },
            ],
          });
          return "completed";
        },
        editor: async (input, session) => {
          if (input.text.includes("semantic segments")) {
            await session.callTool("read_transcript", { source });
            await session.callTool("save_segments", {
              source,
              transcriptVersion: "sha256:aaaa",
              segments: [
                {
                  firstSentence: "s1",
                  lastSentence: "s3",
                  title: "The talk",
                  summary: "All of it.",
                  role: "main",
                  priority: "must",
                },
              ],
            });
          } else {
            await session.callTool("plan_cut", { source, label: "rough cut" });
            build = await session.callTool("build_rough_cut", { plan: "cut-1" });
          }
          return "completed";
        },
      });

      await fixture.turns.start(chat.id, { prompt: "Tighten the raw talk" });
      await settled(fixture, chat.id);

      const state = fixture.chats.get(chat.id);
      if (!state) throw new Error("chat missing");
      expect(state.turns[0]?.status).toBe("completed");
      expect(state.runs.map((run) => [run.agent, run.status])).toEqual([
        ["vision", "completed"],
        ["editor", "completed"],
        ["editor", "completed"],
      ]);

      // Each tool ran once, on behalf of the right agent.
      expect(fixture.analysis.startRequests).toEqual([{ source }]);
      expect(fixture.analysis.frameRequests).toHaveLength(1);
      expect(fixture.analysis.visionRequests).toHaveLength(1);
      expect(fixture.analysis.segmentRequests).toHaveLength(1);
      expect(fixture.analysis.planRequests).toEqual([{ source, label: "rough cut" }]);
      expect(fixture.editing.applyRequests).toHaveLength(1);
      expect(fixture.editing.applyRequests[0]?.operations.map((operation) => operation.op)).toEqual(
        ["add_sequence", "set_composition"],
      );
      expect(fixture.checkpoints.windows).toHaveLength(1);

      // Vision saw the frames as images; the Editor's rough cut reports its clips.
      expect(frames).toMatchObject({
        images: [{ mimeType: "image/jpeg" }, { mimeType: "image/jpeg" }],
      });
      expect(build).toMatchObject({ text: expect.stringContaining("3 clips") });

      // Who has which tool.
      const director = fixture.backend.sessionsOf("director")[0];
      const vision = fixture.backend.sessionsOf("vision")[0];
      const editor = fixture.backend.sessionsOf("editor")[0];
      if (!director || !vision || !editor) throw new Error("a session is missing");
      expect(toolsOf(director)).toContain("analyze_media");
      expect(toolsOf(director)).not.toContain("inspect_frames");
      expect(toolsOf(director)).not.toContain("plan_cut");
      expect(toolsOf(vision)).toContain("inspect_frames");
      expect(toolsOf(vision)).not.toContain("plan_cut");
      expect(toolsOf(editor)).toContain("build_rough_cut");
      expect(toolsOf(editor)).not.toContain("inspect_frames");

      // Activity rows land on the thread of the run that made the call.
      const [visionRun, segmentRun, buildRun] = state.runs;
      expect(activityRows(state.messages, (message) => message.runId === visionRun?.id)).toEqual([
        ["Looking at 2 frames", "done"],
        ["Saving 1 visual note", "done"],
      ]);
      expect(activityRows(state.messages, (message) => message.runId === segmentRun?.id)).toEqual([
        ["Reading the transcript", "done"],
        ["Saving 1 segment", "done"],
      ]);
      expect(activityRows(state.messages, (message) => message.runId === buildRun?.id)).toEqual([
        ["Planning the cut · rough cut", "done"],
        ["Building the rough cut · 3 clips", "done"],
      ]);
      expect(
        activityRows(
          state.messages,
          (message) => message.id === state.turns[0]?.assistantMessageId,
        ),
      ).toEqual([["Analyzing raw-talk.mp4", "done"]]);
    } finally {
      await fixture.cleanup();
    }
  });
});

describe("auto canvas turns", () => {
  it("tells the Director to choose the frame format when the start request says canvas auto", async () => {
    const fixture = await createRuntimeFixture();
    try {
      const chat = await fixture.chats.create({}, []);
      script(fixture, {
        director: async (input) => {
          say(input, "Chose 9:16 for the Reel.");
          return "completed";
        },
      });
      await fixture.turns.start(chat.id, {
        prompt: "Make a Reel from the interview",
        intent: "edit",
        canvas: "auto",
      });
      await settled(fixture, chat.id);
      const director = fixture.backend.sessionsOf("director")[0];
      expect(director?.prompts[0]?.text).toContain("<canvas-auto>");
      expect(director?.prompts[0]?.text).toContain("set_canvas");
      expect(fixture.chats.get(chat.id)?.chat.canvasAuto).toBe(true);

      // A chat with a fixed canvas carries no instruction.
      const fixed = await fixture.chats.create({}, []);
      await fixture.turns.start(fixed.id, { prompt: "Make it" });
      await settled(fixture, fixed.id);
      expect(fixture.backend.sessionsOf("director").at(-1)?.prompts[0]?.text).not.toContain(
        "<canvas-auto>",
      );
    } finally {
      await fixture.cleanup();
    }
  });

  it("keeps the format open through a plan turn and clears the flag when an edit sets the canvas", async () => {
    const fixture = await createRuntimeFixture();
    try {
      const chat = await fixture.chats.create({}, []);
      script(fixture, {
        director: async (input, session) => {
          if (input.text.includes("Plan a Reel")) {
            say(input, "Plan: a 9:16 Reel from the interview.");
          } else {
            const edit = await session.callTool("edit_timeline", {
              operations: [{ op: "set_canvas", width: 1080, height: 1920 }],
            });
            expect(edit.isError).toBeUndefined();
            say(input, "Built the Reel in 9:16.");
          }
          return "completed";
        },
      });
      await fixture.turns.start(chat.id, {
        prompt: "Plan a Reel from the interview",
        intent: "plan",
        canvas: "auto",
      });
      await settled(fixture, chat.id);

      const planned = fixture.backend.sessionsOf("director")[0];
      expect(planned?.prompts[0]?.text).toContain("<canvas-auto>");
      expect(planned?.prompts[0]?.text).toContain("still to be decided");
      expect(fixture.chats.get(chat.id)?.chat.canvasAuto).toBe(true);
      // Durable: the flag survives a restart (reopened from the same store).
      const reopened = await ChatService.open(fixture.scope, fixture.store);
      expect(reopened.get(chat.id)?.chat.canvasAuto).toBe(true);

      // The edit turn carries no `canvas` field: the chat's flag alone keeps the instruction.
      await fixture.turns.start(chat.id, { prompt: "Build the Reel", intent: "edit" });
      await settled(fixture, chat.id);
      const prompts = fixture.backend
        .sessionsOf("director")
        .flatMap((session) => session.prompts.map((prompt) => prompt.text));
      expect(prompts.at(-1)).toContain("<canvas-auto>");
      expect(prompts.at(-1)).toContain("set_canvas");
      expect(
        fixture.editing.applyRequests.map((request) => request.operations.map((op) => op.op)),
      ).toEqual([["set_canvas"]]);
      expect(fixture.chats.get(chat.id)?.chat.canvasAuto).toBeUndefined();
      const cleared = await ChatService.open(fixture.scope, fixture.store);
      expect(cleared.get(chat.id)?.chat.canvasAuto).toBeUndefined();

      // The flag is gone: the chat's next turn carries no instruction.
      await fixture.turns.start(chat.id, { prompt: "Add music", intent: "edit" });
      await settled(fixture, chat.id);
      expect(fixture.backend.sessionsOf("director").at(-1)?.prompts.at(-1)?.text).not.toContain(
        "<canvas-auto>",
      );
    } finally {
      await fixture.cleanup();
    }
  });
});
