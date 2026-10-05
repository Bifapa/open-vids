import { describe, expect, it } from "vitest";
import type { StoryActionOptions } from "@hyperframes/agent-protocol";
import type { BackendPromptInput, BackendPromptOutcome, HostToolResult } from "../backend.js";
import { ChatService } from "../chats.js";
import { RuntimeError } from "../errors.js";
import { isQaClosing } from "../qa/harness.js";
import type { ScriptedSession } from "../testing/backend.js";
import { createRuntimeFixture, waitUntil, type RuntimeFixture } from "../testing/runtimeFixture.js";
import { userEditedStory } from "../testing/story.js";
import { toolNames, usableTools } from "../testing/usable.js";

async function settled(fixture: RuntimeFixture, chatId: string): Promise<void> {
  await waitUntil(
    () =>
      fixture.chats.get(chatId)?.turns.at(-1)?.status !== "running" &&
      fixture.turns.activeTurn === null,
    "the turn to end",
  );
}

describe("story-mode turns", () => {
  it("records a story action as a story turn, and gives the Director the graph with the user's decisions and locks", async () => {
    const fixture = await createRuntimeFixture();
    try {
      const chat = await fixture.chats.create({}, []);
      fixture.story.viewResult = userEditedStory();
      let promptText = "";
      let open: string[] = [];
      fixture.backend.promptScript = async (input, session) => {
        if (isQaClosing(input)) return "completed";
        promptText = input.text;
        open = await usableTools(session, [
          "edit_story",
          "edit_timeline",
          "build_rough_cut",
          "render_video",
          "build_story",
        ]);
        return "completed";
      };

      // The chat itself stays in normal mode; the action alone makes the turn a story turn.
      await fixture.turns.start(chat.id, {
        prompt: "Review the story",
        mode: "normal",
        storyAction: "review",
      });
      await settled(fixture, chat.id);

      const state = fixture.chats.get(chat.id);
      expect(state?.turns[0]).toMatchObject({
        status: "completed",
        mode: "story",
        storyAction: "review",
      });
      expect(state?.chat.activeMode).toBe("normal");

      expect(promptText).toContain("<story-graph>");
      expect(promptText).toContain('ch1 "Cold open" · LOCKED');
      expect(promptText).toContain("(set by user)");
      expect(promptText).toContain("link removed by the user (do not re-add): ch2 → ch3");
      expect(promptText).toContain('<story-mode action="review">');
      expect(promptText).toContain("Never restore the previous AI variant");
      expect(promptText).toContain("Never change a locked node");

      // A review changes the story, never the timeline: the Director's session keeps its stable tool list and
      // dispatch refuses the timeline writers and the build in this turn.
      expect(toolNames(fixture.backend.sessionsOf("director")[0])).toEqual(
        expect.arrayContaining(["read_story", "edit_story", "edit_timeline", "build_story"]),
      );
      expect(open).toEqual(["edit_story"]);
    } finally {
      await fixture.cleanup();
    }
  });

  it("takes the turn's mode from the request, else from the chat, and records it", async () => {
    const fixture = await createRuntimeFixture();
    try {
      const chat = await fixture.chats.create({}, []);
      let promptText = "";
      let open: string[] = [];
      fixture.backend.promptScript = async (input, session) => {
        if (isQaClosing(input)) return "completed";
        promptText = input.text;
        open = await usableTools(session, ["edit_timeline", "edit_story"]);
        return "completed";
      };

      await fixture.turns.start(chat.id, { prompt: "Make the talk tighter" });
      await settled(fixture, chat.id);
      expect(fixture.chats.get(chat.id)?.turns[0]).toMatchObject({ mode: "normal" });
      expect(fixture.chats.get(chat.id)?.turns[0]?.storyAction).toBeUndefined();
      expect(promptText).not.toContain("<story-mode");
      expect(open).toEqual(["edit_timeline"]);

      await fixture.chats.update(chat.id, { activeMode: "story" });
      await fixture.turns.start(chat.id, { prompt: "Plan the launch video" });
      await settled(fixture, chat.id);
      expect(fixture.chats.get(chat.id)?.turns[1]).toMatchObject({ mode: "story" });
      expect(promptText).toContain('<story-mode action="plan">');
      expect(promptText).toContain("There is no story yet");
      expect(open).toEqual(["edit_story"]);

      await fixture.turns.start(chat.id, { prompt: "Just trim the intro", mode: "normal" });
      await settled(fixture, chat.id);
      expect(fixture.chats.get(chat.id)?.turns[2]).toMatchObject({ mode: "normal" });
      expect(promptText).not.toContain("<story-mode");
      expect(open).toEqual(["edit_timeline"]);

      // A mode change does not reopen the Director's resumable session: it keeps one stable tool list, and the
      // turn's mode is enforced at dispatch.
      const sessions = fixture.backend.sessionsOf("director");
      expect(sessions).toHaveLength(1);
      expect(toolNames(sessions[0])).toEqual(
        expect.arrayContaining(["edit_timeline", "edit_story"]),
      );
    } finally {
      await fixture.cleanup();
    }
  });

  it("keeps a chat's mode after the runtime restarts", async () => {
    const fixture = await createRuntimeFixture();
    try {
      const chat = await fixture.chats.create({}, []);
      await fixture.chats.update(chat.id, { activeMode: "story" });
      const reopened = await ChatService.open(fixture.scope, fixture.store);
      expect(reopened.get(chat.id)?.chat.activeMode).toBe("story");
    } finally {
      await fixture.cleanup();
    }
  });

  it("refuses a story action when the runtime has no story host", async () => {
    const fixture = await createRuntimeFixture({ story: undefined });
    try {
      const chat = await fixture.chats.create({}, []);
      await expect(
        fixture.turns.start(chat.id, { prompt: "Build the story", storyAction: "build" }),
      ).rejects.toBeInstanceOf(RuntimeError);
      expect(fixture.turns.activeTurn).toBeNull();
      expect(fixture.checkpoints.windows).toEqual([]);
    } finally {
      await fixture.cleanup();
    }
  });
});

type Script = (
  input: BackendPromptInput,
  session: ScriptedSession,
) => Promise<BackendPromptOutcome>;

function script(fixture: RuntimeFixture, byAgent: Partial<Record<string, Script>>): void {
  fixture.backend.promptScript = (input, session) =>
    isQaClosing(input)
      ? Promise.resolve("completed")
      : (byAgent[session.input.agent] ?? (async () => "completed"))(input, session);
}

describe("build turns", () => {
  it("lets the Director build when no Editor is enabled, stamping the turn and the graph version", async () => {
    const fixture = await createRuntimeFixture();
    try {
      const chat = await fixture.chats.create({}, []);
      fixture.story.viewResult = userEditedStory();
      let result: HostToolResult | null = null;
      script(fixture, {
        director: async (_input, session) => {
          result = await session.callTool("build_story", { baseVersion: "sha256:story-v1" });
          return "completed";
        },
      });
      const turn = await fixture.turns.start(chat.id, {
        prompt: "Build the story",
        storyAction: "build",
      });
      await settled(fixture, chat.id);

      expect(fixture.story.buildRequests).toEqual([
        { baseVersion: "sha256:story-v1", turnId: turn.id },
      ]);
      expect(result).toMatchObject({ text: expect.stringContaining("Built the story") });
      expect(fixture.chats.get(chat.id)?.turns[0]).toMatchObject({
        status: "completed",
        mode: "story",
        storyAction: "build",
      });
    } finally {
      await fixture.cleanup();
    }
  });

  it("lets the Director edit the graph before the build and freezes it after, and says outside material is unavailable when the runtime cannot search", async () => {
    const fixture = await createRuntimeFixture({ research: undefined });
    try {
      const chat = await fixture.chats.create({}, []);
      fixture.story.viewResult = userEditedStory();
      const batch = {
        operations: [
          {
            op: "add_node",
            node: { kind: "missing", title: "Music bed", mediaKind: "music", need: "calm" },
          },
        ],
      };
      let before: HostToolResult | null = null;
      let after: HostToolResult | null = null;
      let directorPrompt = "";
      script(fixture, {
        director: async (input, session) => {
          directorPrompt = input.text;
          before = await session.callTool("edit_story", batch);
          await session.callTool("build_story", {});
          after = await session.callTool("edit_story", batch);
          return "completed";
        },
      });
      await fixture.turns.start(chat.id, { prompt: "Build the video", storyAction: "build" });
      await settled(fixture, chat.id);

      expect(before).not.toMatchObject({ isError: true });
      expect(after).toMatchObject({ isError: true, text: expect.stringContaining("frozen") });
      expect(fixture.story.editRequests).toHaveLength(1);
      expect(fixture.story.buildRequests).toHaveLength(1);
      expect(directorPrompt).toContain("Outside material cannot be fetched in this turn");
    } finally {
      await fixture.cleanup();
    }
  });

  it("gives build_story to the delegated Editor, not to the Director, and tells the Director to delegate", async () => {
    const fixture = await createRuntimeFixture();
    try {
      const chat = await fixture.chats.create({}, ["editor"]);
      fixture.story.viewResult = userEditedStory();
      const director: { prompt: string; open: string[] } = { prompt: "", open: [] };
      script(fixture, {
        director: async (input, session) => {
          director.prompt = input.text;
          director.open = await usableTools(session, ["build_story"]);
          await session.callTool("delegate", {
            agent: "editor",
            title: "Build the story",
            task: "Build the story into the timeline",
          });
          await session.callTool("wait_for_agents", {});
          return "completed";
        },
        editor: async (_input, session) => {
          await session.callTool("build_story", {});
          return "completed";
        },
      });
      const turn = await fixture.turns.start(chat.id, {
        prompt: "Build the story",
        storyAction: "build",
      });
      await settled(fixture, chat.id);

      // The Director's session lists build_story too (the list is stable); in this turn dispatch refuses it.
      expect(director.open).toEqual([]);
      expect(toolNames(fixture.backend.sessionsOf("editor")[0])).toEqual(
        expect.arrayContaining(["build_story", "read_story", "edit_timeline"]),
      );
      expect(toolNames(fixture.backend.sessionsOf("editor")[0])).not.toContain("edit_story");
      expect(fixture.story.buildRequests).toEqual([{ turnId: turn.id }]);
      expect(director.prompt).toContain("Delegate the Editor: build_story");
    } finally {
      await fixture.cleanup();
    }
  });
});

describe("rebuild turns", () => {
  const options: StoryActionOptions = {
    chapters: ["ch2"],
    manualEdits: "replace",
    allowLocked: ["ch1"],
  };

  it("stores the user's options on the turn, applies them in the Director's rebuild_story and states them in the prompt", async () => {
    const fixture = await createRuntimeFixture();
    try {
      const chat = await fixture.chats.create({}, []);
      fixture.story.viewResult = userEditedStory();
      let promptText = "";
      let result: HostToolResult | null = null;
      let notAvailable: string[] = [];
      script(fixture, {
        director: async (input, session) => {
          promptText = input.text;
          result = await session.callTool("rebuild_story", {
            baseVersion: "sha256:story-v1",
            // A model cannot widen what the user chose.
            allowLocked: ["ch1", "ch2", "ch3"],
            manualEdits: "keep",
          });
          const closed = [
            "edit_story",
            "build_story",
            "edit_timeline",
            "build_rough_cut",
            "render_video",
          ];
          const open = await usableTools(session, closed);
          notAvailable = closed.filter((name) => !open.includes(name));
          return "completed";
        },
      });
      const started = await fixture.turns.start(chat.id, {
        prompt: "Rebuild affected sections",
        storyAction: "rebuild",
        storyOptions: options,
      });
      await settled(fixture, chat.id);

      expect(started).toMatchObject({
        mode: "story",
        storyAction: "rebuild",
        storyOptions: options,
      });
      expect(fixture.chats.get(chat.id)?.turns[0]).toMatchObject({
        status: "completed",
        storyAction: "rebuild",
        storyOptions: options,
      });
      expect(fixture.story.rebuildRequests).toEqual([
        { baseVersion: "sha256:story-v1", turnId: started.id, ...options },
      ]);
      expect(result).toMatchObject({
        text: expect.stringContaining("Rebuilt the affected sections"),
      });

      // The Director's session lists every story tool; a rebuild turn refuses all but rebuild_story at dispatch.
      const director = toolNames(fixture.backend.sessionsOf("director")[0]);
      expect(director).toEqual(expect.arrayContaining(["read_story", "rebuild_story"]));
      expect(notAvailable).toEqual([
        "edit_story",
        "build_story",
        "edit_timeline",
        "build_rough_cut",
        "render_video",
      ]);

      expect(promptText).toContain('<story-mode action="rebuild">');
      expect(promptText).toContain("Call rebuild_story exactly once");
      expect(promptText).toContain("only the changed sections of ch2 are regenerated");
      expect(promptText).toContain(
        "manual edits to generated clips in a section that must change are REPLACED",
      );
      expect(promptText).toContain("the user allowed these locked chapters to be rebuilt: ch1");
    } finally {
      await fixture.cleanup();
    }
  });

  it("defaults to every affected section, keeping manual edits and leaving locked chapters alone", async () => {
    const fixture = await createRuntimeFixture();
    try {
      const chat = await fixture.chats.create({}, []);
      fixture.story.viewResult = userEditedStory();
      let promptText = "";
      script(fixture, {
        director: async (input, session) => {
          promptText = input.text;
          await session.callTool("rebuild_story", {});
          return "completed";
        },
      });
      const started = await fixture.turns.start(chat.id, {
        prompt: "Rebuild affected sections",
        storyAction: "rebuild",
      });
      await settled(fixture, chat.id);

      expect(fixture.chats.get(chat.id)?.turns[0]?.storyOptions).toBeUndefined();
      expect(fixture.story.rebuildRequests).toEqual([{ turnId: started.id }]);
      expect(promptText).toContain("every affected section is regenerated");
      expect(promptText).toContain("are KEPT (policy keep)");
      expect(promptText).toContain("no locked chapter may be rebuilt");
    } finally {
      await fixture.cleanup();
    }
  });

  it("gives a build turn only the locked-chapter permission, and stamps it on build_story", async () => {
    const fixture = await createRuntimeFixture();
    try {
      const chat = await fixture.chats.create({}, []);
      fixture.story.viewResult = userEditedStory();
      let promptText = "";
      script(fixture, {
        director: async (input, session) => {
          promptText = input.text;
          await session.callTool("build_story", { allowLocked: ["ch1", "ch3"] });
          return "completed";
        },
      });
      const started = await fixture.turns.start(chat.id, {
        prompt: "Build the story",
        storyAction: "build",
        storyOptions: { allowLocked: ["ch1"] },
      });
      await settled(fixture, chat.id);

      expect(fixture.story.buildRequests).toEqual([{ turnId: started.id, allowLocked: ["ch1"] }]);
      expect(promptText).toContain(
        "Options for this turn: the user allowed these locked chapters to be rebuilt: ch1.",
      );
      expect(promptText).toContain("manual edits to clips the story generated");
    } finally {
      await fixture.cleanup();
    }
  });
});

describe("edit_timeline in a turn", () => {
  it("carries the turn id, so the service can tell which turn made an edit", async () => {
    const fixture = await createRuntimeFixture();
    try {
      const chat = await fixture.chats.create({}, []);
      script(fixture, {
        director: async (_input, session) => {
          await session.callTool("edit_timeline", {
            operations: [{ op: "set_composition", duration: 5 }],
          });
          return "completed";
        },
      });
      const started = await fixture.turns.start(chat.id, { prompt: "Shorten it" });
      await settled(fixture, chat.id);

      expect(fixture.editing.applyRequests).toHaveLength(1);
      expect(fixture.editing.applyRequests[0]?.turnId).toBe(started.id);
    } finally {
      await fixture.cleanup();
    }
  });
});
