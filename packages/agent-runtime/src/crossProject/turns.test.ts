import type { AgentId } from "@hyperframes/agent-protocol";
import { describe, expect, it } from "vitest";
import type { BackendPromptInput, BackendPromptOutcome } from "../backend.js";
import { ResearchToolError } from "../research/host.js";
import type { ScriptedSession } from "../testing/backend.js";
import { manifestFile, projectReference } from "../testing/crossProject.js";
import { createRuntimeFixture, waitUntil, type RuntimeFixture } from "../testing/runtimeFixture.js";
import { toolNames } from "../testing/usable.js";

const REEL = "aaaaaaaaaaaaaaaa";

async function settled(fixture: RuntimeFixture, chatId: string): Promise<void> {
  await waitUntil(
    () =>
      fixture.chats.get(chatId)?.turns.at(-1)?.status !== "running" &&
      fixture.turns.activeTurn === null,
    "the turn to end",
  );
}

type Script = (
  input: BackendPromptInput,
  session: ScriptedSession,
) => Promise<BackendPromptOutcome>;

function script(fixture: RuntimeFixture, byAgent: Partial<Record<AgentId, Script>>): void {
  fixture.backend.promptScript = (input, session) =>
    (byAgent[session.input.agent] ?? (async () => "completed"))(input, session);
}

function withReel(fixture: RuntimeFixture): void {
  fixture.crossProject.projects.set(REEL, {
    name: "Summer reel",
    files: [
      manifestFile("renders/final.mp4", "renders", { bytes: 12_400_000 }),
      manifestFile("assets/theme.mp3", "music", { license: "CC BY 4.0" }),
    ],
    story: "1. Opening",
  });
}

describe("# project attachments in a turn", () => {
  it("offers the tool and the manifest block only when the chat attached a project, and keeps the key, name and parts out of nothing else", async () => {
    const fixture = await createRuntimeFixture();
    try {
      withReel(fixture);
      const plain = await fixture.chats.create({}, ["editor"]);
      const attachedChat = await fixture.chats.create({}, ["editor"]);
      const prompts: Record<string, string> = {};
      script(fixture, {
        director: async (input, session) => {
          prompts[session.input.chatId] ??= input.text;
          return "completed";
        },
      });
      await fixture.turns.start(plain.id, { prompt: "Cut it" });
      await settled(fixture, plain.id);
      await fixture.turns.start(attachedChat.id, {
        prompt: "Use the music of #Summer reel",
        references: [projectReference(REEL, "Summer reel", ["music"])],
      });
      await settled(fixture, attachedChat.id);

      const plainDirector = fixture.backend
        .sessionsOf("director")
        .find((session) => session.input.chatId === plain.id);
      const attachedDirector = fixture.backend
        .sessionsOf("director")
        .find((session) => session.input.chatId === attachedChat.id);
      expect(toolNames(plainDirector)).not.toContain("import_from_project");
      expect(prompts[plain.id]).not.toContain("<attached-projects>");
      expect(toolNames(attachedDirector)).toContain("import_from_project");

      const prompt = prompts[attachedChat.id] ?? "";
      expect(prompt).toContain("<attached-projects>");
      expect(prompt).toContain("- assets/theme.mp3 · music");
      // Only the attached part is listed, and the story only when it was attached.
      expect(prompt).not.toContain("renders/final.mp4");
      expect(prompt).not.toContain("Story outline");
      expect(fixture.crossProject.manifestRequests).toEqual([{ key: REEL, parts: ["music"] }]);
      // <references> shows key, name and parts and nothing else of the reference.
      expect(prompt).toContain(
        `{"kind":"project","projectKey":"${REEL}","name":"Summer reel","parts":["music"]}`,
      );
      expect(prompt).not.toContain("<attachments>");
    } finally {
      await fixture.cleanup();
    }
  });

  it("asks Studio for the story with the story part: its outline reaches the prompt, and with the story alone there is no file tool", async () => {
    const fixture = await createRuntimeFixture();
    try {
      withReel(fixture);
      const chat = await fixture.chats.create({}, ["editor"]);
      let prompt = "";
      script(fixture, {
        director: async (input) => {
          prompt ||= input.text;
          return "completed";
        },
      });
      await fixture.turns.start(chat.id, {
        prompt: "take the structure of #Summer reel",
        references: [projectReference(REEL, "Summer reel", ["story"])],
      });
      await settled(fixture, chat.id);
      expect(fixture.crossProject.manifestRequests).toEqual([{ key: REEL, parts: ["story"] }]);
      expect(prompt).toContain("1. Opening");
      expect(prompt).toContain("there are no files to copy");
      expect(prompt).not.toContain("assets/theme.mp3");
      expect(toolNames(fixture.backend.sessionsOf("director")[0])).not.toContain(
        "import_from_project",
      );
    } finally {
      await fixture.cleanup();
    }
  });

  it("lets the Director and the Editor copy only attached files, and stamps the copy with the turn, the agent and the model", async () => {
    const fixture = await createRuntimeFixture();
    try {
      withReel(fixture);
      const chat = await fixture.chats.create({}, ["editor"]);
      await fixture.chats.update(chat.id, {
        agentOverrides: {
          editor: { model: { provider: "p", modelId: "m" }, thinking: null, allowedModels: [] },
        },
      });
      const answers: Record<string, string> = {};
      script(fixture, {
        director: async (input, session) => {
          if (answers.denied) return "completed";
          const denied = await session.callTool("import_from_project", {
            project: REEL,
            files: ["renders/final.mp4"],
          });
          answers.denied = denied.text;
          await session.callTool("delegate", {
            agent: "editor",
            title: "Add music",
            task: "Put the theme under the video",
          });
          await session.callTool("wait_for_agents", {});
          return "completed";
        },
        editor: async (_input, session) => {
          const copied = await session.callTool("import_from_project", {
            project: "Summer reel",
            files: ["assets/theme.mp3"],
            turnId: "forged",
          });
          answers.copied = copied.text;
          return "completed";
        },
      });
      await fixture.turns.start(chat.id, {
        prompt: "music from #Summer reel",
        references: [projectReference(REEL, "Summer reel", ["music"])],
      });
      await settled(fixture, chat.id);

      expect(answers.denied).toContain("Nothing was copied");
      const turn = fixture.chats.get(chat.id)?.turns[0];
      expect(fixture.crossProject.importRequests).toEqual([
        {
          projectKey: REEL,
          files: ["assets/theme.mp3"],
          turnId: turn?.id,
          agent: "editor",
          model: "p/m",
        },
      ]);
      expect(answers.copied).toContain("assets/from/Summer reel/assets/theme.mp3");
      expect(turn?.changes).toContainEqual({ kind: "import", count: 1 });
    } finally {
      await fixture.cleanup();
    }
  });

  it("keeps a project attached in an earlier turn accessible and in the block, and refuses to copy in an Ask turn", async () => {
    const fixture = await createRuntimeFixture();
    try {
      withReel(fixture);
      const chat = await fixture.chats.create({}, ["editor"]);
      const prompts: Record<string, string> = {};
      const answers: Record<string, string> = {};
      // Render QA may prompt the Director again at the end of a turn that copied: only a turn's first prompt counts.
      const marker = (text: string) =>
        ["ZQ1", "ZQ2", "ZQ3"].find((phrase) => text.includes(phrase));
      script(fixture, {
        director: async (input, session) => {
          const which = marker(input.text);
          if (which === undefined || which in prompts) return "completed";
          prompts[which] = input.text;
          if (which !== "ZQ1") {
            answers[which] = (
              await session.callTool("import_from_project", {
                project: REEL,
                files: ["assets/theme.mp3"],
              })
            ).text;
          }
          return "completed";
        },
      });
      await fixture.turns.start(chat.id, {
        prompt: "ZQ1 look at #Summer reel",
        references: [projectReference(REEL, "Summer reel", ["music"])],
      });
      await settled(fixture, chat.id);
      // The next message attaches nothing new; the earlier attachment still stands.
      await fixture.turns.start(chat.id, { prompt: "ZQ2 now use its theme" });
      await settled(fixture, chat.id);
      expect(prompts.ZQ2).toContain('Project "Summer reel"');
      expect(answers.ZQ2).toContain("Copied 1 of 1 file");

      await fixture.turns.start(chat.id, {
        prompt: "ZQ3 and again, but only tell me",
        intent: "ask",
      });
      await settled(fixture, chat.id);
      expect(answers.ZQ3).toContain("This is an Ask turn");
      expect(fixture.crossProject.importRequests).toHaveLength(1);
    } finally {
      await fixture.cleanup();
    }
  });

  it("says Studio could not list the project and carries on when the manifest fails", async () => {
    const fixture = await createRuntimeFixture();
    try {
      withReel(fixture);
      fixture.crossProject.nextManifestError = new ResearchToolError(
        "studio_unavailable",
        "Studio is down.",
      );
      const chat = await fixture.chats.create({}, []);
      let prompt = "";
      script(fixture, {
        director: async (input) => {
          prompt = input.text;
          return "completed";
        },
      });
      await fixture.turns.start(chat.id, {
        prompt: "#Summer reel",
        references: [projectReference(REEL, "Summer reel", ["all"])],
      });
      await settled(fixture, chat.id);
      expect(fixture.chats.get(chat.id)?.turns[0]?.status).toBe("completed");
      expect(prompt).toContain("Studio could not list this project now (Studio is down.)");
    } finally {
      await fixture.cleanup();
    }
  });

  it("gives a project attached by steering its manifest at once, and lets it be copied when the tool was already there", async () => {
    const fixture = await createRuntimeFixture();
    try {
      withReel(fixture);
      const chat = await fixture.chats.create({}, ["editor"]);
      const gate = Promise.withResolvers<BackendPromptOutcome>();
      let started = false;
      script(fixture, {
        director: async () => {
          started = true;
          return gate.promise;
        },
      });
      const turn = await fixture.turns.start(chat.id, {
        prompt: "first, the logo project",
        references: [projectReference("bbbbbbbbbbbbbbbb", "Other", ["images"])],
      });
      await waitUntil(() => started, "the first prompt");
      await fixture.turns.steer(chat.id, turn.id, {
        text: "also the music of #Summer reel",
        references: [projectReference(REEL, "Summer reel", ["music"])],
      });
      const director = fixture.backend.sessionsOf("director")[0];
      const copied = await director?.callTool("import_from_project", {
        project: REEL,
        files: ["assets/theme.mp3"],
      });
      gate.resolve("completed");
      await settled(fixture, chat.id);

      expect(director?.steering[0]).toContain("also the music of #Summer reel");
      expect(director?.steering[0]).toContain('Project "Summer reel"');
      expect(director?.steering[0]).toContain("- assets/theme.mp3 · music");
      // Only the project this steering attached rides on it.
      expect(director?.steering[0]).not.toContain('Project "Other"');
      expect(copied?.isError).toBeUndefined();
    } finally {
      await fixture.cleanup();
    }
  });
});
