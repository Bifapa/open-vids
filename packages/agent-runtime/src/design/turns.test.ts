import { describe, expect, it } from "vitest";
import type { Activity, StartTurnRequest } from "@hyperframes/agent-protocol";
import { ChatService } from "../chats.js";
import { isQaClosing } from "../qa/harness.js";
import { RuntimeError } from "../errors.js";
import type { ScriptedSession } from "../testing/backend.js";
import {
  attachedDesign,
  sampleManifest,
  sampleSpec,
  sampleTokens,
  systemDetail,
} from "../testing/design.js";
import { sampleWebsiteStyle } from "../testing/research.js";
import { createRuntimeFixture, waitUntil, type RuntimeFixture } from "../testing/runtimeFixture.js";
import { toolNames } from "../testing/usable.js";

async function settled(fixture: RuntimeFixture, chatId: string): Promise<void> {
  await waitUntil(
    () =>
      fixture.chats.get(chatId)?.turns.at(-1)?.status !== "running" &&
      fixture.turns.activeTurn === null,
    "the turn to end",
  );
}

async function run(fixture: RuntimeFixture, chatId: string, request: StartTurnRequest) {
  await fixture.turns.start(chatId, request);
  await settled(fixture, chatId);
  return fixture.chats.get(chatId)?.turns.at(-1);
}

const PALETTE = [
  "#0b0b10",
  "#f5f5f7",
  "#9a9aa5",
  "#15151d",
  "#2a2a36",
  "#ff5a36",
  "#ffb347",
  "#7c5cff",
];

describe("design action turns", () => {
  it("records the action and the user's choices, runs as an edit turn in the chat's mode and persists them", async () => {
    const fixture = await createRuntimeFixture();
    try {
      const chat = await fixture.chats.create({}, []);
      await fixture.chats.update(chat.id, { intent: "ask", activeMode: "story" });
      let promptText = "";
      let director: ScriptedSession | undefined;
      fixture.backend.promptScript = async (input, session) => {
        promptText = input.text;
        director = session;
        return "completed";
      };
      const turn = await run(fixture, chat.id, {
        prompt: "Make a design system from this project",
        designAction: "create",
        designOptions: { source: "project" },
      });
      expect(turn).toMatchObject({
        status: "completed",
        intent: "edit",
        mode: "story",
        designAction: "create",
        designOptions: { source: "project" },
      });
      expect(fixture.chats.get(chat.id)?.chat.intent).toBe("ask");

      // The turn's prompt says what it is; none of the story, plan-approval or offer blocks apply to it.
      expect(promptText).toContain('<design-turn action="create" source="project">');
      expect(promptText).toContain("extract_project_design is the ONLY source of colors");
      expect(promptText).toContain("a save with one is refused");
      expect(promptText).toContain("Do NOT change compositions or the timeline");
      expect(promptText).not.toContain("<story-mode");
      expect(promptText).not.toContain("<story-graph>");
      expect(promptText).not.toContain("<plan-approval>");
      expect(promptText).not.toContain("<story-offer>");
      expect(toolNames(director)).toEqual(
        expect.arrayContaining([
          "list_design_systems",
          "read_design_system",
          "extract_project_design",
          "video_palette",
          "save_design_system",
          "attach_design_system",
        ]),
      );

      const reopened = await ChatService.open(fixture.scope, fixture.store);
      expect(reopened.get(chat.id)?.turns[0]).toMatchObject({
        designAction: "create",
        designOptions: { source: "project" },
      });
    } finally {
      await fixture.cleanup();
    }
  });

  it("leaves an ordinary turn without design fields or blocks; the typed-request tools are there, never a composition write", async () => {
    const fixture = await createRuntimeFixture();
    try {
      const chat = await fixture.chats.create({}, []);
      let promptText = "";
      let director: ScriptedSession | undefined;
      const answers: Record<string, string> = {};
      fixture.backend.promptScript = async (input, session) => {
        if (isQaClosing(input)) return "completed";
        promptText = input.text;
        director = session;
        answers.palette = (await session.callTool("video_palette", { video: "assets/a.mp4" })).text;
        answers.timeline = session.input.fileWriteRefusal?.("write") ?? "allowed";
        return "completed";
      };
      const turn = await run(fixture, chat.id, { prompt: "Trim the intro" });
      expect(turn?.designAction).toBeUndefined();
      expect(turn?.designOptions).toBeUndefined();
      expect(promptText).not.toContain("<design-turn");
      expect(toolNames(director)).toEqual(
        expect.arrayContaining([
          "list_design_systems",
          "read_design_system",
          "extract_project_design",
          "save_design_system",
          "attach_design_system",
        ]),
      );
      // The video source starts from the Design dialog, and an ordinary turn still writes files as before.
      expect(answers.palette).toContain("is not available to you in this turn");
      expect(answers.timeline).toBe("allowed");
      expect(director?.input.instructions).toContain("In an ordinary turn the same tools answer");
      expect(fixture.design.saves).toEqual([]);
    } finally {
      await fixture.cleanup();
    }
  });

  it("answers a typed request in an ordinary turn: create from the brief, change what was read, refuse a video source", async () => {
    const fixture = await createRuntimeFixture();
    try {
      const chat = await fixture.chats.create({}, []);
      fixture.design.systems = [systemDetail("acme", { name: "Acme", version: 2, createdAt: 9 })];
      const answers: string[] = [];
      fixture.backend.promptScript = async (input, session) => {
        if (isQaClosing(input)) return "completed";
        const save = (args: unknown) => session.callTool("save_design_system", args);
        answers.push(
          (
            await save({
              name: "Reel",
              source: { kind: "video", ref: "a.mp4" },
              spec: sampleSpec(),
            })
          ).text,
        );
        answers.push((await save({ id: "acme", spec: sampleSpec() })).text);
        await session.callTool("read_design_system", { id: "acme" });
        answers.push(
          (
            await save({
              id: "acme",
              spec: sampleSpec({ tokens: sampleTokens({ "--accent": "#ff9d3a" }) }),
            })
          ).text,
        );
        answers.push((await save({ name: "Night Drive", spec: sampleSpec() })).text);
        answers.push((await session.callTool("attach_design_system", { id: "night-drive" })).text);
        return "completed";
      };
      const turn = await run(fixture, chat.id, {
        prompt: "Warm up Acme's accent, then a new look",
      });
      expect(turn?.designAction).toBeUndefined();
      expect(answers[0]).toContain("starts from the Design button");
      expect(answers[1]).toContain("name must be");
      expect(answers[2]).toContain("version 3");
      expect(answers[3]).toContain("Saved design system night-drive");
      expect(answers[4]).toContain("carries design system night-drive");
      expect(fixture.design.saves.map((save) => save.id)).toEqual(["acme", "night-drive"]);
      expect(fixture.design.saves[0]?.request).toMatchObject({ baseVersion: 2, baseCreatedAt: 9 });
      expect(fixture.design.saves[0]?.request.name).toBeUndefined();
      // Nothing in the compositions or the timeline changed; the attach is the turn's one counted change.
      expect(fixture.editing.applyRequests).toHaveLength(0);
      expect(turn?.changes).toEqual([{ kind: "design_attach", count: 1 }]);
    } finally {
      await fixture.cleanup();
    }
  });

  it("has no design tools, role text, snapshot block or inventory line without a design host (the beta flag off)", async () => {
    const fixture = await createRuntimeFixture({ design: undefined });
    try {
      const chat = await fixture.chats.create({}, ["editor", "motion"]);
      fixture.design.state = {
        attached: attachedDesign(),
        library: { name: "Acme", version: 2 },
        updateAvailable: false,
        snapshotOk: true,
      };
      const instructions: string[] = [];
      let promptText = "";
      let inventory = "";
      let offered = "";
      fixture.backend.promptScript = async (input, session) => {
        if (isQaClosing(input)) return "completed";
        if (session.input.agent !== "director") return "completed";
        promptText = input.text;
        for (const agent of ["director", "editor", "motion"] as const)
          for (const open of fixture.backend.sessionsOf(agent))
            instructions.push(open.input.instructions);
        instructions.push(session.input.instructions);
        inventory = (await session.callTool("inspect_project", {})).text;
        offered = toolNames(session).includes("save_design_system") ? "offered" : "absent";
        return "completed";
      };
      await run(fixture, chat.id, { prompt: "Add a title" });
      expect(offered).toBe("absent");
      expect(promptText).not.toContain("<project-design");
      expect(inventory).not.toContain("Design system:");
      for (const text of instructions) {
        expect(text).not.toContain("save_design_system");
        expect(text).not.toContain("design/tokens.css");
      }
      expect(fixture.design.saves).toEqual([]);
    } finally {
      await fixture.cleanup();
    }
  });

  it("refuses a design action when the runtime has no design host", async () => {
    const fixture = await createRuntimeFixture({ design: undefined });
    try {
      const chat = await fixture.chats.create({}, []);
      await expect(
        fixture.turns.start(chat.id, { prompt: "Make a system", designAction: "create" }),
      ).rejects.toBeInstanceOf(RuntimeError);
      expect(fixture.chats.get(chat.id)?.turns).toEqual([]);
    } finally {
      await fixture.cleanup();
    }
  });

  it("writes the library and never a composition: timeline writers and file writes are refused", async () => {
    const fixture = await createRuntimeFixture();
    try {
      const chat = await fixture.chats.create({}, []);
      // Even in a chat that works in Story mode the design turn leaves the story alone.
      await fixture.chats.update(chat.id, { activeMode: "story" });
      const answers: Record<string, string> = {};
      fixture.backend.promptScript = async (_input, session) => {
        for (const name of [
          "edit_timeline",
          "render_video",
          "build_rough_cut",
          "edit_story",
          "build_story",
        ]) {
          answers[name] = (await session.callTool(name, {})).text;
        }
        answers.read_story = (await session.callTool("read_story", {})).text;
        answers.write = session.input.fileWriteRefusal?.("write") ?? "allowed";
        answers.edit = session.input.fileWriteRefusal?.("edit") ?? "allowed";
        answers.read = session.input.fileWriteRefusal?.("read") ?? "allowed";
        return "completed";
      };
      await run(fixture, chat.id, { prompt: "System from scratch", designAction: "create" });
      for (const name of [
        "edit_timeline",
        "render_video",
        "build_rough_cut",
        "edit_story",
        "build_story",
        "write",
        "edit",
      ]) {
        expect(answers[name], name).toContain("Design Systems turn");
      }
      expect(answers.read_story).not.toContain("Design Systems turn");
      expect(answers.read).toBe("allowed");
      expect(fixture.story.editRequests).toHaveLength(0);
      expect(fixture.story.buildRequests).toHaveLength(0);
      expect(fixture.editing.applyRequests).toHaveLength(0);
      expect(fixture.editing.renderRequests).toHaveLength(0);

      // The next ordinary turn writes as before.
      fixture.backend.promptScript = async (input, session) => {
        if (isQaClosing(input)) return "completed";
        answers.write = session.input.fileWriteRefusal?.("write") ?? "allowed";
        return "completed";
      };
      await run(fixture, chat.id, { prompt: "Make the title red", mode: "normal" });
      expect(answers.write).toBe("allowed");
    } finally {
      await fixture.cleanup();
    }
  });

  it("saves through the tool: the chat shows a coded row with the system id, the user's source is enforced", async () => {
    const fixture = await createRuntimeFixture();
    try {
      const chat = await fixture.chats.create({}, []);
      fixture.design.saveNotes = ["System font Arial is not stored."];
      let wrongSource = "";
      fixture.backend.promptScript = async (_input, session) => {
        wrongSource = (
          await session.callTool("save_design_system", {
            name: "Night Drive",
            source: { kind: "website", ref: "evil.test" },
            spec: sampleSpec(),
          })
        ).text;
        await session.callTool("save_design_system", { name: "Night Drive", spec: sampleSpec() });
        return "completed";
      };
      await run(fixture, chat.id, {
        prompt: "A night-drive look",
        designAction: "create",
        designOptions: { source: "scratch" },
      });
      expect(wrongSource).toContain('The user chose "scratch"');
      expect(fixture.design.saves).toHaveLength(1);
      expect(fixture.design.saves[0]).toMatchObject({
        id: "night-drive",
        request: { source: { kind: "scratch" }, projectId: "project-one" },
      });

      const rows = (fixture.chats.get(chat.id)?.messages ?? [])
        .flatMap((message) => (message.role === "assistant" ? message.parts : []))
        .flatMap((part): Activity[] => (part.type === "activity" ? [part.activity] : []))
        .filter((activity) => activity.labelCode === "saving_design_system");
      expect(rows.map((row) => row.status)).toEqual(["failed", "done"]);
      expect(rows[1]?.labelParams).toEqual({ id: "night-drive", name: "Night Drive" });
    } finally {
      await fixture.cleanup();
    }
  });

  it("an edit action saves only to the chosen system, on the version the Director read", async () => {
    const fixture = await createRuntimeFixture();
    try {
      const chat = await fixture.chats.create({}, []);
      fixture.design.systems = [
        systemDetail("acme", { name: "Acme", version: 3 }),
        systemDetail("beta", { name: "Beta", version: 1 }),
      ];
      const answers: string[] = [];
      fixture.backend.promptScript = async (input, session) => {
        expect(input.text).toContain('<design-turn action="edit">');
        expect(input.text).toContain("Call read_design_system on it first");
        expect(input.text).toContain("system acme");
        answers.push((await session.callTool("save_design_system", { spec: sampleSpec() })).text);
        await session.callTool("read_design_system", { id: "acme" });
        answers.push(
          (
            await session.callTool("save_design_system", {
              id: "beta",
              name: "Beta",
              spec: sampleSpec(),
            })
          ).text,
        );
        answers.push(
          (
            await session.callTool("save_design_system", {
              spec: sampleSpec({ tokens: sampleTokens({ "--accent": "#ff9d3a" }) }),
            })
          ).text,
        );
        return "completed";
      };
      const turn = await run(fixture, chat.id, {
        prompt: "Make the accent warmer",
        designAction: "edit",
        designOptions: { systemId: "acme" },
      });
      expect(turn).toMatchObject({ designAction: "edit", designOptions: { systemId: "acme" } });
      expect(answers[0]).toContain("Read acme with read_design_system first");
      expect(answers[1]).toContain("edits the system acme");
      expect(answers[2]).toContain("version 4");
      expect(fixture.design.saves).toHaveLength(1);
      expect(fixture.design.saves[0]).toMatchObject({ id: "acme", request: { baseVersion: 3 } });
      expect(fixture.design.saves[0]?.request.spec.tokens["--accent"]).toBe("#ff9d3a");
    } finally {
      await fixture.cleanup();
    }
  });

  it("counts an attach in the turn's changes but not the library save, and runs no render QA", async () => {
    const fixture = await createRuntimeFixture();
    try {
      const chat = await fixture.chats.create({}, []);
      fixture.backend.promptScript = async (_input, session) => {
        await session.callTool("save_design_system", { name: "Acme", spec: sampleSpec() });
        await session.callTool("attach_design_system", { id: "acme" });
        return "completed";
      };
      const turn = await run(fixture, chat.id, { prompt: "Acme look", designAction: "create" });
      expect(turn?.status).toBe("completed");
      expect(turn?.changes).toEqual([{ kind: "design_attach", count: 1 }]);
      expect(fixture.design.attaches).toEqual(["acme"]);
      expect(fixture.qa.checkRequests).toHaveLength(0);
    } finally {
      await fixture.cleanup();
    }
  });
});

describe("applying a saved system is a separate, approved step", () => {
  it("offers propose_plan only after the system is saved, and tells the Director when it may use it", async () => {
    const fixture = await createRuntimeFixture();
    try {
      const chat = await fixture.chats.create({}, []);
      await fixture.settings.update({ autonomy: { planApproval: "big" } });
      const answers: string[] = [];
      let promptText = "";
      fixture.backend.promptScript = async (input, session) => {
        promptText = input.text;
        const steps = [
          { title: "Link design/tokens.css in index.html" },
          { title: "Use the tokens" },
        ];
        answers.push((await session.callTool("propose_plan", { steps })).text);
        await session.callTool("save_design_system", { name: "Acme", spec: sampleSpec() });
        answers.push((await session.callTool("propose_plan", { steps })).text);
        return "completed";
      };
      const turn = await run(fixture, chat.id, {
        prompt: "Make a system and apply it to my videos",
        designAction: "create",
      });
      expect(promptText).toContain("then call propose_plan with the steps of applying it");
      expect(promptText).not.toContain("<plan-approval>");
      expect(answers[0]).toContain("Save the design system first");
      expect(answers[1]).not.toContain("Save the design system first");
      expect(turn?.plan?.proposal).toBe(true);
      expect(fixture.editing.applyRequests).toHaveLength(0);
    } finally {
      await fixture.cleanup();
    }
  });

  it("tells the Director to leave applying for the next message when plans are off", async () => {
    const fixture = await createRuntimeFixture();
    try {
      const chat = await fixture.chats.create({}, []);
      await fixture.settings.update({ autonomy: { planApproval: "never" } });
      let promptText = "";
      fixture.backend.promptScript = async (input) => {
        promptText = input.text;
        return "completed";
      };
      await run(fixture, chat.id, { prompt: "System, and apply it", designAction: "create" });
      expect(promptText).toContain("applying it is a separate step");
      expect(promptText).not.toContain("call propose_plan");
    } finally {
      await fixture.cleanup();
    }
  });
});

describe("the project's attached design system in prompts", () => {
  const attached = attachedDesign();

  function attachAcme(fixture: RuntimeFixture, updateAvailable = false) {
    fixture.design.state = {
      attached,
      library: { name: "Acme", version: updateAvailable ? 3 : 2 },
      updateAvailable,
      snapshotOk: true,
    };
    fixture.design.snapshotResult = {
      state: fixture.design.state,
      tokens: sampleTokens(),
      manifest: sampleManifest({
        version: 2,
        fonts: [
          {
            family: "Space Grotesk",
            role: "display",
            source: "google",
            weights: [700],
            license: null,
            files: [],
            portable: true,
            guess: true,
          },
        ],
        transitions: [{ name: "Quick fade", kind: "fade", durationSec: 0.3, ease: "power2.out" }],
        motionRules: ["Cuts on the beat."],
        guesses: ["font Space Grotesk is a guess"],
      }),
    };
  }

  it("states the system to the Director, to the specialists that write compositions and in inspect_project", async () => {
    const fixture = await createRuntimeFixture();
    try {
      attachAcme(fixture, true);
      const chat = await fixture.chats.create({}, ["editor", "motion", "vision"]);
      const tasks: Record<string, string> = {};
      let directorPrompt = "";
      let inventory = "";
      fixture.backend.promptScript = async (input, session) => {
        if (isQaClosing(input)) return "completed";
        if (session.input.agent !== "director") {
          tasks[session.input.agent] = input.text;
          return "completed";
        }
        directorPrompt = input.text;
        for (const agent of ["editor", "motion", "vision"]) {
          await session.callTool("delegate", {
            agent,
            title: `${agent} work`,
            task: "Do the work.",
          });
        }
        await session.callTool("wait_for_agents", {});
        inventory = (await session.callTool("inspect_project", {})).text;
        return "completed";
      };
      await run(fixture, chat.id, { prompt: "Add a title card" });

      const link = '<link rel="stylesheet" href="design/tokens.css">';
      expect(directorPrompt).toContain(
        '<project-design system="acme" version="2" update-available>',
      );
      expect(directorPrompt).toContain(link);
      expect(directorPrompt).toContain("first source of design truth");
      expect(directorPrompt).toContain("--brand: #ff5a36");
      expect(directorPrompt).toContain("Space Grotesk (display, google, 700, GUESS)");
      expect(directorPrompt).toContain("Guessed (not exact): font Space Grotesk is a guess");
      expect(directorPrompt).toContain("The library holds version 3");
      expect(directorPrompt).toContain("Never hard-code a color the system already has");
      expect(directorPrompt).not.toContain("<!doctype");

      expect(tasks.editor).toContain(link);
      expect(tasks.motion).toContain(link);
      expect(tasks.vision).not.toContain("<project-design");

      expect(inventory).toContain(
        'Design system: acme — "Acme", version 2 (the library has version 3; the user updates it)',
      );
    } finally {
      await fixture.cleanup();
    }
  });

  it("says nothing when no system is attached or Studio cannot say, and warns about damaged files", async () => {
    const fixture = await createRuntimeFixture();
    try {
      const chat = await fixture.chats.create({}, []);
      const prompts: string[] = [];
      fixture.backend.promptScript = async (input) => {
        if (isQaClosing(input)) return "completed";
        prompts.push(input.text);
        return "completed";
      };
      await run(fixture, chat.id, { prompt: "Add a title" });
      fixture.design.snapshotFails = true;
      await run(fixture, chat.id, { prompt: "Add another title" });
      fixture.design.snapshotFails = false;
      attachAcme(fixture);
      fixture.design.state = { ...fixture.design.state, snapshotOk: false };
      fixture.design.snapshotResult = { state: fixture.design.state, tokens: null, manifest: null };
      await run(fixture, chat.id, { prompt: "Add a third title" });
      expect(prompts[0]).not.toContain("<project-design");
      expect(prompts[1]).not.toContain("<project-design");
      expect(prompts[2]).toContain("design/ are damaged or incomplete");
    } finally {
      await fixture.cleanup();
    }
  });

  it("is also stated in a design turn, beside the turn's own block", async () => {
    const fixture = await createRuntimeFixture();
    try {
      attachAcme(fixture);
      const chat = await fixture.chats.create({}, []);
      let promptText = "";
      fixture.backend.promptScript = async (input) => {
        promptText = input.text;
        return "completed";
      };
      await run(fixture, chat.id, { prompt: "A second look", designAction: "create" });
      expect(promptText).toContain("<design-turn");
      expect(promptText).toContain("<project-design");
    } finally {
      await fixture.cleanup();
    }
  });
});

describe("design sources", () => {
  it("a video source: the video is fixed, Vision is asked for frames, and fonts and transitions are marked as guesses", async () => {
    const fixture = await createRuntimeFixture();
    try {
      const chat = await fixture.chats.create({}, ["vision"]);
      fixture.design.palette = {
        video: "assets/clip.mp4",
        durationSec: 30,
        samples: 8,
        colors: [{ value: "#101820", share: 0.6 }],
      };
      let promptText = "";
      let palette = "";
      let other = "";
      fixture.backend.promptScript = async (input, session) => {
        promptText = input.text;
        palette = (await session.callTool("video_palette", {})).text;
        other = (await session.callTool("video_palette", { video: "assets/elsewhere.mp4" })).text;
        return "completed";
      };
      await run(fixture, chat.id, {
        prompt: "Like this video",
        designAction: "create",
        designOptions: { source: "video", video: "assets/clip.mp4" },
      });
      expect(promptText).toContain('<design-turn action="create" source="video">');
      expect(promptText).toContain("Source: the video assets/clip.mp4");
      expect(promptText).toContain("never eyeball a color");
      expect(promptText).toContain("delegate Vision to look at 4–8 frames");
      expect(promptText).toContain("is a GUESS");
      expect(promptText).toContain("guess: true");
      expect(palette).toContain("#101820 · 60%");
      expect(other).toContain("measure that file");
    } finally {
      await fixture.cleanup();
    }
  });

  it("a video source with Vision off: the Director looks at the frames itself", async () => {
    const fixture = await createRuntimeFixture();
    try {
      const chat = await fixture.chats.create({}, []);
      let promptText = "";
      fixture.backend.promptScript = async (input) => {
        promptText = input.text;
        return "completed";
      };
      await run(fixture, chat.id, {
        prompt: "Like this video",
        designAction: "create",
        designOptions: { source: "video", video: "assets/clip.mp4" },
      });
      expect(promptText).toContain("look at 4–8 frames of the video yourself with inspect_frames");
      expect(promptText).not.toContain("delegate Vision");
    } finally {
      await fixture.cleanup();
    }
  });

  it("a website source: the chosen site counts as linked, others do not, and the read ends with the draft", async () => {
    const fixture = await createRuntimeFixture();
    try {
      const chat = await fixture.chats.create({}, []);
      let promptText = "";
      let read = "";
      let refused = "";
      fixture.backend.promptScript = async (input, session) => {
        promptText = input.text;
        read = (await session.callTool("read_website", { url: "https://www.acme.test/about" }))
          .text;
        refused = (await session.callTool("read_website", { url: "https://evil.test/" })).text;
        return "completed";
      };
      await run(fixture, chat.id, {
        prompt: "Use their look",
        designAction: "create",
        designOptions: { source: "website", url: "https://www.acme.test/" },
      });
      expect(promptText).toContain("Source: the website https://www.acme.test/");
      expect(promptText).toContain("DRAFT SPEC");
      expect(read).toContain("Design system draft from this site");
      expect(read).toContain(`"--brand":"${sampleWebsiteStyle().colors[3]?.hex}"`);
      expect(refused).toContain("not a page of a website the user linked");
    } finally {
      await fixture.cleanup();
    }
  });

  it("an external project source reads that project's design only through the host that has the capability", async () => {
    const fixture = await createRuntimeFixture();
    try {
      const chat = await fixture.chats.create({}, []);
      let extracted = "";
      fixture.backend.promptScript = async (_input, session) => {
        extracted = (await session.callTool("extract_project_design", {})).text;
        return "completed";
      };
      await run(fixture, chat.id, {
        prompt: "Like my other project",
        designAction: "create",
        designOptions: { source: "external_project", projectKey: "proj-9" },
      });
      expect(fixture.design.externalCalls).toEqual(["proj-9"]);
      expect(fixture.design.extractCalls).toBe(0);
      expect(extracted).toContain("unavailable");
    } finally {
      await fixture.cleanup();
    }
  });

  it("a project source gets the exact colors of the extraction and no invented ones", async () => {
    const fixture = await createRuntimeFixture();
    try {
      const chat = await fixture.chats.create({}, []);
      fixture.design.extraction = {
        files: ["index.html"],
        colors: PALETTE.map((value, index) => ({ value, count: 9 - index, roles: ["fill"] })),
        fonts: [{ family: "Inter", count: 4, weights: [400], loading: "google" }],
        easings: [{ value: "power2.out", count: 3 }],
        durations: [{ seconds: 0.4, count: 5 }],
        radii: [],
        fontSizes: [],
        shadows: [],
        declaredTokens: {},
      };
      const results: string[] = [];
      fixture.backend.promptScript = async (_input, session) => {
        results.push((await session.callTool("extract_project_design", {})).text);
        results.push(
          (
            await session.callTool("save_design_system", {
              name: "From project",
              spec: sampleSpec({ tokens: sampleTokens({ "--brand": "#00ff00" }) }),
            })
          ).text,
        );
        results.push(
          (
            await session.callTool("save_design_system", {
              name: "From project",
              spec: sampleSpec(),
            })
          ).text,
        );
        return "completed";
      };
      await run(fixture, chat.id, {
        prompt: "Make it a system",
        designAction: "create",
        designOptions: { source: "project" },
      });
      expect(results[0]).toContain("#ff5a36 · ×4");
      expect(results[0]).toContain('"Inter" · ×4 · weights 400 · google');
      expect(results[1]).toContain("#00ff00");
      expect(results[1]).toContain("never invent one");
      expect(results[2]).toContain("Saved design system from-project");
      expect(fixture.design.saves).toHaveLength(1);
    } finally {
      await fixture.cleanup();
    }
  });
});
