import { describe, expect, it } from "vitest";
import type { BackendPromptInput, BackendPromptOutcome, HostToolResult } from "../backend.js";
import { ChatService } from "../chats.js";
import { RuntimeError } from "../errors.js";
import type { ScriptedSession } from "../testing/backend.js";
import { createRuntimeFixture, waitUntil, type RuntimeFixture } from "../testing/runtimeFixture.js";
import { userEditedStory } from "../testing/story.js";

async function settled(fixture: RuntimeFixture, chatId: string): Promise<void> {
  await waitUntil(
    () =>
      fixture.chats.get(chatId)?.turns.at(-1)?.status !== "running" &&
      fixture.turns.activeTurn === null,
    "the turn to end",
  );
}

const toolNames = (session: ScriptedSession | undefined) =>
  session?.input.hostTools.map((tool) => tool.name) ?? [];

describe("story-mode turns", () => {
  it("records a story action as a story turn, and gives the Director the graph with the user's decisions and locks", async () => {
    const fixture = await createRuntimeFixture();
    try {
      const chat = await fixture.chats.create({}, []);
      fixture.story.viewResult = userEditedStory();
      let promptText = "";
      fixture.backend.promptScript = async (input) => {
        promptText = input.text;
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

      // A review changes the story, never the timeline.
      const director = toolNames(fixture.backend.sessionsOf("director")[0]);
      expect(director).toEqual(expect.arrayContaining(["read_story", "edit_story"]));
      expect(director).not.toContain("edit_timeline");
      expect(director).not.toContain("build_rough_cut");
      expect(director).not.toContain("render_video");
      expect(director).not.toContain("build_story");
    } finally {
      await fixture.cleanup();
    }
  });

  it("takes the turn's mode from the request, else from the chat, and records it", async () => {
    const fixture = await createRuntimeFixture();
    try {
      const chat = await fixture.chats.create({}, []);
      let promptText = "";
      fixture.backend.promptScript = async (input) => {
        promptText = input.text;
        return "completed";
      };

      await fixture.turns.start(chat.id, { prompt: "Make the talk tighter" });
      await settled(fixture, chat.id);
      expect(fixture.chats.get(chat.id)?.turns[0]).toMatchObject({ mode: "normal" });
      expect(fixture.chats.get(chat.id)?.turns[0]?.storyAction).toBeUndefined();
      expect(promptText).not.toContain("<story-mode");
      expect(toolNames(fixture.backend.sessionsOf("director")[0])).toContain("edit_timeline");
      expect(toolNames(fixture.backend.sessionsOf("director")[0])).not.toContain("edit_story");

      await fixture.chats.update(chat.id, { activeMode: "story" });
      await fixture.turns.start(chat.id, { prompt: "Plan the launch video" });
      await settled(fixture, chat.id);
      expect(fixture.chats.get(chat.id)?.turns[1]).toMatchObject({ mode: "story" });
      expect(promptText).toContain('<story-mode action="plan">');
      expect(promptText).toContain("There is no story yet");

      await fixture.turns.start(chat.id, { prompt: "Just trim the intro", mode: "normal" });
      await settled(fixture, chat.id);
      expect(fixture.chats.get(chat.id)?.turns[2]).toMatchObject({ mode: "normal" });
      expect(promptText).not.toContain("<story-mode");

      // The mode change reopens the Director's resumable session with the matching tools.
      const sessions = fixture.backend.sessionsOf("director");
      expect(sessions.map((session) => toolNames(session).includes("edit_story"))).toEqual([
        false,
        true,
        false,
      ]);
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
    (byAgent[session.input.agent] ?? (async () => "completed"))(input, session);
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

  it("gives build_story to the delegated Editor, not to the Director, and tells the Director to delegate", async () => {
    const fixture = await createRuntimeFixture();
    try {
      const chat = await fixture.chats.create({}, ["editor"]);
      fixture.story.viewResult = userEditedStory();
      let directorPrompt = "";
      script(fixture, {
        director: async (input, session) => {
          directorPrompt = input.text;
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

      expect(toolNames(fixture.backend.sessionsOf("director")[0])).not.toContain("build_story");
      expect(toolNames(fixture.backend.sessionsOf("editor")[0])).toEqual(
        expect.arrayContaining(["build_story", "read_story", "edit_timeline"]),
      );
      expect(toolNames(fixture.backend.sessionsOf("editor")[0])).not.toContain("edit_story");
      expect(fixture.story.buildRequests).toEqual([{ turnId: turn.id }]);
      expect(directorPrompt).toContain("Delegate the Editor: build_story");
    } finally {
      await fixture.cleanup();
    }
  });
});
