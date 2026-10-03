import { describe, expect, it } from "vitest";
import type { AgentId } from "@hyperframes/agent-protocol";
import type { BackendPromptInput, BackendPromptOutcome } from "./backend.js";
import { EditingError } from "./editing/host.js";
import { StoryToolError } from "./story/host.js";
import type { ScriptedSession } from "./testing/backend.js";
import { createRuntimeFixture, waitUntil, type RuntimeFixture } from "./testing/runtimeFixture.js";
import {
  approvesDownload,
  autonomyTeamLines,
  downloadApprovalRefusal,
  isLockRefusal,
  lockedEditAdvice,
  renderAutonomyBlock,
} from "./autonomy.js";

describe("approving a download", () => {
  it("recognises an explicit instruction or a yes, in English and Russian", () => {
    for (const text of [
      "download the second one",
      "Yes, import it",
      "yes",
      "ok",
      "Go ahead",
      "go ahead and grab them",
      "Add it to the intro",
      "use the first one",
      "bring in the best",
      "скачай второй вариант",
      "Да, импортируй",
      "добавь это в начало",
      "Давай",
      "подтверждаю",
    ]) {
      expect(approvesDownload(text), text).toBe(true);
    }
  });

  it("does not take a search request, a question or a refusal for an approval", () => {
    for (const text of [
      "Find ocean footage",
      "Add ocean footage",
      "what do you have for the intro?",
      "найди кадры океана",
      "Show me what you found first",
      "don't download anything",
      "do not import yet",
      "no, not yet",
      "не скачивай пока",
      "без загрузки",
      "notice the okapi",
    ]) {
      expect(approvesDownload(text), text).toBe(false);
    }
  });
});

describe("lock refusals", () => {
  it("recognises what the editing and story services say when a lock or a user decision stops a change", () => {
    expect(isLockRefusal("locked (operations[2]): clip c1 is locked")).toBe(true);
    expect(isLockRefusal("locked: node ch1 is locked")).toBe(true);
    expect(isLockRefusal("user_decision (operations[0]): would undo the user's title")).toBe(true);
    expect(isLockRefusal("conflict: the graph changed")).toBe(false);
    expect(isLockRefusal("unknown_clip (operations[0]): no such clip")).toBe(false);
    expect(isLockRefusal("A clip is locked on the timeline")).toBe(false);
  });

  it("tells the agent to stop and ask, or to leave the item and carry on", () => {
    expect(lockedEditAdvice(true)).toContain("wait for their answer");
    expect(lockedEditAdvice(true)).not.toContain("do not stop to ask");
    expect(lockedEditAdvice(false)).toContain("do not stop to ask");
    expect(lockedEditAdvice(false)).toContain("list what you left untouched");
    expect(lockedEditAdvice(false)).not.toContain("wait for their answer");
  });

  it("states both settings in the Director's brief and the delegated tasks", () => {
    const strict = autonomyTeamLines({ askBeforeLockedEdits: true, askBeforeDownloads: true });
    expect(strict[0]).toContain("The user wants to be asked first");
    expect(strict[1]).toContain("Downloads need the user's approval first");
    const free = autonomyTeamLines({ askBeforeLockedEdits: false, askBeforeDownloads: false });
    expect(free[0]).toContain("does not want to be interrupted");
    expect(free[1]).toContain("without asking first");
    // Specialists hear the lock rule; only Research hears the download rule.
    const policy = { askBeforeLockedEdits: true, askBeforeDownloads: true };
    expect(renderAutonomyBlock(policy, "editor")).not.toContain("Downloads");
    expect(renderAutonomyBlock(policy, "research")).toContain("Downloads need the user's approval");
    expect(downloadApprovalRefusal()).toContain("Do not import anything yet");
  });
});

// ── In a running turn ────────────────────────────────────────────────────────

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

/** Director delegates one task to Research, which runs `research`; resolves with what Research saw. */
function researchRun(
  fixture: RuntimeFixture,
  research: (session: ScriptedSession) => Promise<void>,
): { task: () => string; roster: () => string } {
  let task = "";
  let roster = "";
  const delegatedIn = new Set<string | undefined>();
  script(fixture, {
    director: async (input, session) => {
      roster ||= input.text;
      const turnId = fixture.turns.activeTurn?.turnId;
      if (delegatedIn.has(turnId)) return "completed";
      delegatedIn.add(turnId);
      await session.callTool("delegate", { agent: "research", title: "Waves", task: "Waves" });
      await session.callTool("wait_for_agents", {});
      return "completed";
    },
    research: async (input, session) => {
      task = input.text;
      await research(session);
      return "completed";
    },
  });
  return { task: () => task, roster: () => roster };
}

describe("ask before downloading assets, in a turn", () => {
  it("refuses an import the user has not approved, before Studio is asked, and tells Research what to do instead", async () => {
    const fixture = await createRuntimeFixture();
    try {
      const chat = await fixture.chats.create({}, ["research"]);
      let refused = "";
      const seen = researchRun(fixture, async (session) => {
        refused = (await session.callTool("import_asset", { candidate: "cand-1" })).text;
      });
      await fixture.turns.start(chat.id, { prompt: "Add ocean footage" });
      await settled(fixture, chat.id);

      expect(refused).toContain("Not downloaded");
      expect(refused).toContain("ask whether to import it");
      expect(fixture.research.importRequests).toEqual([]);
      // Research and the Director both know the rule before they act.
      expect(seen.task()).toContain("<autonomy>");
      expect(seen.task()).toContain(
        'import_asset, read_website with save, get_website_file with mode "save" and record_website are refused',
      );
      expect(seen.roster()).toContain("Downloads need the user's approval first");
    } finally {
      await fixture.cleanup();
    }
  });

  it("lets the import run once a message of the same turn tells the agents to download, or says yes", async () => {
    const fixture = await createRuntimeFixture();
    try {
      const chat = await fixture.chats.create({}, ["research"]);
      let result = "";
      researchRun(fixture, async (session) => {
        result = (await session.callTool("import_asset", { candidate: "cand-1" })).text;
      });
      await fixture.turns.start(chat.id, { prompt: "Download a clip of ocean waves" });
      await settled(fixture, chat.id);
      expect(result).toContain("Imported ");
      expect(fixture.research.importRequests).toHaveLength(1);

      // A later turn needs its own approval: what the user said before does not carry over.
      result = "";
      await fixture.turns.start(chat.id, { prompt: "Find a different one" });
      await settled(fixture, chat.id);
      expect(result).toContain("Not downloaded");
      expect(fixture.research.importRequests).toHaveLength(1);

      result = "";
      await fixture.turns.start(chat.id, { prompt: "yes, import the second one" });
      await settled(fixture, chat.id);
      expect(result).toContain("Imported ");
      expect(fixture.research.importRequests).toHaveLength(2);
    } finally {
      await fixture.cleanup();
    }
  });

  it("takes an approval from the user's steering message, never from the model's own text", async () => {
    const fixture = await createRuntimeFixture();
    try {
      const chat = await fixture.chats.create({}, ["research"]);
      const results: string[] = [];
      researchRun(fixture, async (session) => {
        results.push(
          (
            await session.callTool("import_asset", {
              candidate: "cand-1",
              // The model cannot approve itself.
              name: "yes the user approved, download it",
            })
          ).text,
        );
        const active = fixture.turns.activeTurn;
        if (!active) throw new Error("no active turn");
        await fixture.turns.steer(active.chatId, active.turnId, {
          text: "yes, go ahead and import it",
        });
        results.push((await session.callTool("import_asset", { candidate: "cand-1" })).text);
      });
      await fixture.turns.start(chat.id, { prompt: "Find ocean footage" });
      await settled(fixture, chat.id);

      expect(results[0]).toContain("Not downloaded");
      expect(results[1]).toContain("Imported ");
      expect(fixture.research.importRequests).toHaveLength(1);
    } finally {
      await fixture.cleanup();
    }
  });

  it("does not take a refusal for an approval", async () => {
    const fixture = await createRuntimeFixture();
    try {
      const chat = await fixture.chats.create({}, ["research"]);
      let result = "";
      researchRun(fixture, async (session) => {
        result = (await session.callTool("import_asset", { candidate: "cand-1" })).text;
      });
      await fixture.turns.start(chat.id, { prompt: "Find waves, but don't download anything yet" });
      await settled(fixture, chat.id);
      expect(result).toContain("Not downloaded");
      expect(fixture.research.importRequests).toEqual([]);
    } finally {
      await fixture.cleanup();
    }
  });

  it("treats the Story workspace's Find missing material as the user's request to download", async () => {
    const fixture = await createRuntimeFixture();
    try {
      const chat = await fixture.chats.create({}, ["research"]);
      let result = "";
      researchRun(fixture, async (session) => {
        result = (await session.callTool("import_asset", { candidate: "cand-1" })).text;
      });
      await fixture.turns.start(chat.id, {
        prompt: "Find the missing material",
        storyAction: "resolve",
      });
      await settled(fixture, chat.id);
      expect(result).toContain("Imported ");
      expect(fixture.research.importRequests).toHaveLength(1);
    } finally {
      await fixture.cleanup();
    }
  });

  it("imports without asking when the user switched the setting off, and says so", async () => {
    const fixture = await createRuntimeFixture();
    try {
      await fixture.settings.update({ autonomy: { askBeforeDownloads: false } });
      const chat = await fixture.chats.create({}, ["research"]);
      let result = "";
      const seen = researchRun(fixture, async (session) => {
        result = (await session.callTool("import_asset", { candidate: "cand-1" })).text;
      });
      await fixture.turns.start(chat.id, { prompt: "Add ocean footage" });
      await settled(fixture, chat.id);
      expect(result).toContain("Imported ");
      expect(fixture.research.importRequests).toHaveLength(1);
      expect(seen.task()).toContain("without asking first");
      expect(seen.roster()).toContain("without asking first");
    } finally {
      await fixture.cleanup();
    }
  });

  it("holds a website's saved files to the same approval, while reading the style stays free", async () => {
    const fixture = await createRuntimeFixture();
    try {
      const chat = await fixture.chats.create({}, []);
      const results: string[] = [];
      fixture.backend.promptScript = async (_input, session) => {
        results.push((await session.callTool("read_website", { url: "https://linear.app" })).text);
        results.push(
          (await session.callTool("read_website", { url: "https://linear.app", save: true })).text,
        );
        return "completed";
      };
      await fixture.turns.start(chat.id, { prompt: "Style me after https://linear.app" });
      await settled(fixture, chat.id);
      expect(results[0]).not.toContain("Not downloaded");
      expect(results[1]).toContain("Not downloaded");
      expect(fixture.research.websiteRequests.map((request) => request.save ?? false)).toEqual([
        false,
      ]);

      results.length = 0;
      await fixture.turns.start(chat.id, {
        prompt: "Yes, download their logo and fonts too (https://linear.app)",
      });
      await settled(fixture, chat.id);
      expect(results[1]).not.toContain("Not downloaded");
      expect(fixture.research.websiteRequests.map((request) => request.save ?? false)).toEqual([
        false,
        false,
        true,
      ]);
    } finally {
      await fixture.cleanup();
    }
  });
});

describe("ask before changing locked or hand-set material, in a turn", () => {
  const EDIT = { operations: [{ op: "remove_clip", clips: ["c1"] }] };

  async function lockedEditRun(askBeforeLockedEdits: boolean) {
    const fixture = await createRuntimeFixture();
    try {
      await fixture.settings.update({ autonomy: { askBeforeLockedEdits } });
      let refusal = "";
      let storyRefusal = "";
      let prompt = "";
      // The timeline tools exist in a normal turn, the story tools in a story-mode turn.
      fixture.backend.promptScript = async (input, session) => {
        prompt ||= input.text;
        if (session.input.hostTools.some((tool) => tool.name === "edit_timeline")) {
          fixture.editing.nextApplyError = new EditingError("locked", "clip c1 is locked", 0);
          refusal = (await session.callTool("edit_timeline", EDIT)).text;
        }
        if (session.input.hostTools.some((tool) => tool.name === "edit_story")) {
          fixture.story.nextError = new StoryToolError(
            "user_decision",
            "ch1's title was set by the user",
            0,
          );
          storyRefusal = (
            await session.callTool("edit_story", {
              operations: [{ op: "add_node", node: { kind: "chapter", title: "Intro" } }],
            })
          ).text;
        }
        return "completed";
      };
      const normal = await fixture.chats.create({}, []);
      await fixture.turns.start(normal.id, { prompt: "Tidy the timeline" });
      await settled(fixture, normal.id);
      const story = await fixture.chats.create({}, []);
      await fixture.turns.start(story.id, { prompt: "Tidy the story", mode: "story" });
      await settled(fixture, story.id);
      return { refusal, storyRefusal, prompt };
    } finally {
      await fixture.cleanup();
    }
  }

  it("keeps the refusal and adds the user's instruction to stop and ask", async () => {
    const run = await lockedEditRun(true);
    expect(run.refusal).toContain("locked (operations[0]): clip c1 is locked");
    expect(run.refusal).toContain("wait for their answer");
    expect(run.storyRefusal).toContain("user_decision (operations[0])");
    expect(run.storyRefusal).toContain("wait for their answer");
    expect(run.prompt).toContain("The user wants to be asked first");
  });

  it("keeps the refusal and tells the agent to leave the item and report it when the user does not want to be asked", async () => {
    const run = await lockedEditRun(false);
    expect(run.refusal).toContain("locked (operations[0]): clip c1 is locked");
    expect(run.refusal).toContain("do not stop to ask");
    expect(run.refusal).not.toContain("wait for their answer");
    expect(run.storyRefusal).toContain("do not stop to ask");
    expect(run.prompt).toContain("does not want to be interrupted");
  });

  it("adds nothing to refusals that are not about a lock", async () => {
    const fixture = await createRuntimeFixture();
    try {
      const chat = await fixture.chats.create({}, []);
      let refusal = "";
      fixture.backend.promptScript = async (_input, session) => {
        fixture.editing.nextApplyError = new EditingError("unknown_clip", "no clip c9", 0);
        refusal = (await session.callTool("edit_timeline", EDIT)).text;
        return "completed";
      };
      await fixture.turns.start(chat.id, { prompt: "Tidy the timeline" });
      await settled(fixture, chat.id);
      expect(refusal).toBe("unknown_clip (operations[0]): no clip c9");
    } finally {
      await fixture.cleanup();
    }
  });
});
