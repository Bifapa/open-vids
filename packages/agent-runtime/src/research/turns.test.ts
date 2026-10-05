import { describe, expect, it } from "vitest";
import type {
  AgentId,
  MissingAssetNode,
  PermissionPart,
  StoryGraph,
} from "@hyperframes/agent-protocol";
import type { BackendPromptInput, BackendPromptOutcome, HostToolResult } from "../backend.js";
import type { ScriptedSession } from "../testing/backend.js";
import { ResearchToolError } from "./host.js";
import { createRuntimeFixture, waitUntil, type RuntimeFixture } from "../testing/runtimeFixture.js";
import { researchPolicy, trustedSource } from "../testing/research.js";
import { chapterNode, storyGraph, storyView } from "../testing/story.js";
import { toolNames, usableTools } from "../testing/usable.js";

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

const EXTERNAL = ["search_assets", "inspect_url", "import_asset", "resolve_missing_asset"];

/** What a resolve turn closes: the story's graph, its build, the timeline and renders. */
const CLOSED_IN_RESOLVE = [
  "edit_story",
  "build_story",
  "rebuild_story",
  "edit_timeline",
  "build_rough_cut",
  "render_video",
];

function missingNode(id: string, overrides: Partial<MissingAssetNode> = {}): MissingAssetNode {
  return {
    id,
    kind: "missing",
    title: `Missing ${id}`,
    position: { x: 0, y: 300 },
    locked: false,
    createdBy: "ai",
    userEdited: [],
    mediaKind: "video",
    need: "Close-up of ocean waves",
    neededDuration: 6,
    ...overrides,
  };
}

function storyWithMissing(): StoryGraph {
  return storyGraph({
    nodes: [
      chapterNode("ch1", { title: "Opening" }),
      missingNode("m1", { mediaKind: "video", need: "Close-up of ocean waves" }),
      missingNode("m2", { mediaKind: "sfx", need: "Sea ambience", neededDuration: null }),
      missingNode("m3", { locked: true, need: "Locked one" }),
    ],
    attachments: [
      {
        id: "a1",
        node: "m1",
        chapter: "ch1",
        placement: "middle",
        offset: null,
        duration: 4,
        createdBy: "ai",
      },
    ],
  });
}

describe("the Research team in a turn", () => {
  it("tells the Director the policy and gives Research its policy block and tools, stamped with turn, agent and model", async () => {
    const fixture = await createRuntimeFixture();
    await fixture.settings.update({ autonomy: { askBeforeDownloads: false } });
    try {
      const chat = await fixture.chats.create({}, ["research"]);
      await fixture.chats.update(chat.id, {
        agentOverrides: {
          research: { model: { provider: "p", modelId: "m" }, thinking: null, allowedModels: [] },
        },
      });
      fixture.research.searchCandidates = [];
      let directorPrompt = "";
      let researchTask = "";
      script(fixture, {
        director: async (input, session) => {
          if (directorPrompt) return "completed";
          directorPrompt = input.text;
          await session.callTool("delegate", {
            agent: "research",
            title: "Find waves",
            task: "Find a clip of ocean waves",
          });
          await session.callTool("wait_for_agents", {});
          return "completed";
        },
        research: async (input, session) => {
          researchTask = input.text;
          await session.callTool("import_asset", {
            candidate: "cand-1",
            turnId: "forged",
            agent: "user",
            model: "evil/model",
          });
          return "completed";
        },
      });

      await fixture.turns.start(chat.id, { prompt: "Add ocean footage" });
      await settled(fixture, chat.id);

      expect(fixture.research.policyCalls).toBe(1);
      expect(directorPrompt).toContain(
        "Material from outside the project comes only from Research",
      );
      expect(directorPrompt).toContain("trusted sources only, 2 trusted sources enabled");
      expect(researchTask).toContain('<asset-search-policy mode="trusted">');
      expect(researchTask).toContain("wikimedia-commons · Wikimedia Commons");
      expect(researchTask).toContain("nasa-images · NASA Images");
      expect(researchTask).toContain("NOT allowed");

      const turnId = fixture.chats.get(chat.id)?.turns[0]?.id;
      expect(fixture.research.importRequests).toEqual([
        { candidate: "cand-1", turnId, agent: "research", model: "p/m" },
      ]);

      expect(toolNames(fixture.backend.sessionsOf("director")[0])).toContain("read_sources");
      expect(
        toolNames(fixture.backend.sessionsOf("director")[0]).filter((name) =>
          EXTERNAL.includes(name),
        ),
      ).toEqual([]);
      expect(toolNames(fixture.backend.sessionsOf("research")[0])).toEqual(
        expect.arrayContaining([...EXTERNAL, "read_sources"]),
      );
    } finally {
      await fixture.cleanup();
    }
  });

  it("states the wider policy to Research in any mode", async () => {
    const fixture = await createRuntimeFixture();
    try {
      const chat = await fixture.chats.create({}, ["research"]);
      fixture.research.policyResult = researchPolicy({
        mode: "any",
        sources: [trustedSource("wikimedia-commons"), trustedSource("off", { enabled: false })],
      });
      let task = "";
      let roster = "";
      script(fixture, {
        director: async (input, session) => {
          if (roster) return "completed";
          roster = input.text;
          await session.callTool("delegate", { agent: "research", title: "x", task: "x" });
          await session.callTool("wait_for_agents", {});
          return "completed";
        },
        research: async (input) => {
          task = input.text;
          return "completed";
        },
      });
      await fixture.turns.start(chat.id, { prompt: "Find something" });
      await settled(fixture, chat.id);
      expect(task).toContain('<asset-search-policy mode="any">');
      expect(task).toContain('The web backend (id "web")');
      expect(task).not.toContain("off ·");
      expect(roster).toContain("any public source, 1 trusted source enabled");
    } finally {
      await fixture.cleanup();
    }
  });

  it("hands the research tools and the policy to the Director when Research is off in the chat", async () => {
    const fixture = await createRuntimeFixture();
    try {
      const chat = await fixture.chats.create({}, ["editor"]);
      let prompt = "";
      script(fixture, {
        director: async (input) => {
          prompt ||= input.text;
          return "completed";
        },
      });
      await fixture.turns.start(chat.id, { prompt: "Find ocean footage" });
      await settled(fixture, chat.id);

      expect(prompt).toContain("Research is off in this chat, so you do its work yourself");
      expect(prompt).toContain("trusted sources only");
      expect(prompt).toContain("wikimedia-commons · Wikimedia Commons");
      expect(prompt).not.toContain("tell them to enable Research");
      expect(fixture.research.policyCalls).toBe(1);
      expect(toolNames(fixture.backend.sessionsOf("director")[0])).toEqual(
        expect.arrayContaining([...EXTERNAL, "read_sources"]),
      );
      // Nobody else got a research tool: the other sessions are not opened at all.
      expect(fixture.backend.sessionsOf("research")).toEqual([]);
    } finally {
      await fixture.cleanup();
    }
  });

  it("fails closed when Studio cannot say what the policy is", async () => {
    const fixture = await createRuntimeFixture();
    try {
      const chat = await fixture.chats.create({}, ["research"]);
      fixture.research.nextPolicyError = new ResearchToolError("studio_unavailable", "down");
      let prompt = "";
      let task = "";
      script(fixture, {
        director: async (input, session) => {
          if (prompt) return "completed";
          prompt = input.text;
          await session.callTool("delegate", { agent: "research", title: "x", task: "x" });
          await session.callTool("wait_for_agents", {});
          return "completed";
        },
        research: async (input) => {
          task = input.text;
          return "completed";
        },
      });
      await fixture.turns.start(chat.id, { prompt: "Find ocean footage" });
      await settled(fixture, chat.id);

      expect(prompt).toContain("could not be read");
      expect(prompt).toContain("Research's tools try again when it calls them");
      expect(task).toContain('status="unavailable"');
    } finally {
      await fixture.cleanup();
    }
  });
});

describe("resolve turns", () => {
  it("lists the unlocked Missing Asset nodes, keeps the story and the timeline closed, and gives Research the tools", async () => {
    const fixture = await createRuntimeFixture();
    try {
      const chat = await fixture.chats.create({}, ["research", "editor"]);
      fixture.story.viewResult = storyView(storyWithMissing());
      let prompt = "";
      let closed: string[] | null = null;
      script(fixture, {
        director: async (input, session) => {
          prompt ||= input.text;
          closed ??= await usableTools(session, [...CLOSED_IN_RESOLVE, ...EXTERNAL]);
          return "completed";
        },
      });

      await fixture.turns.start(chat.id, {
        prompt: "Find the missing material",
        storyAction: "resolve",
      });
      await settled(fixture, chat.id);

      expect(fixture.chats.get(chat.id)?.turns[0]).toMatchObject({
        status: "completed",
        mode: "story",
        storyAction: "resolve",
      });
      expect(prompt).toContain('<story-mode action="resolve">');
      expect(prompt).toContain("Missing Asset nodes to resolve (2):");
      expect(prompt).toContain(
        "- m1 “Missing m1” · search for video (video) · need: Close-up of ocean waves · about 6 s · used in ch1 “Opening” (middle, 4 s)",
      );
      expect(prompt).toContain(
        "- m2 “Missing m2” · search for audio (sfx) · need: Sea ambience · used in no chapter yet",
      );
      expect(prompt).not.toContain("- m3 “Missing m3” · search for");
      expect(prompt).toContain("Delegate Research");
      expect(prompt).toContain("Build Story");

      const director = toolNames(fixture.backend.sessionsOf("director")[0]);
      expect(director).toEqual(expect.arrayContaining(["read_story", "read_sources", "delegate"]));
      // The session keeps its stable tool list; the resolve turn refuses these at dispatch.
      expect(closed).toEqual([]);
    } finally {
      await fixture.cleanup();
    }
  });

  it("limits the scope to the nodes the user chose and refuses Research anything outside it", async () => {
    const fixture = await createRuntimeFixture();
    try {
      const chat = await fixture.chats.create({}, ["research"]);
      fixture.story.viewResult = storyView(storyWithMissing());
      let prompt = "";
      let inside = "";
      let outside = "";
      script(fixture, {
        director: async (input, session) => {
          prompt = input.text;
          await session.callTool("delegate", { agent: "research", title: "m2", task: "Find m2" });
          await session.callTool("wait_for_agents", {});
          return "completed";
        },
        research: async (_input, session) => {
          outside = (
            await session.callTool("import_asset", { candidate: "c", resolveMissing: "m1" })
          ).text;
          inside = (
            await session.callTool("import_asset", { candidate: "c", resolveMissing: "m2" })
          ).text;
          return "completed";
        },
      });

      await fixture.turns.start(chat.id, {
        prompt: "Find the sea sound",
        storyAction: "resolve",
        storyOptions: { missing: ["m2", "gone"] },
      });
      await settled(fixture, chat.id);

      expect(prompt).toContain("Missing Asset nodes to resolve (1):");
      expect(prompt).toContain("- m2 ");
      expect(prompt).not.toContain("- m1 ");
      expect(prompt).toContain("Not in scope (locked, already resolved or not found): gone.");
      expect(outside).toContain(
        "m1 is not one of the Missing Asset nodes this turn may resolve (m2, gone)",
      );
      expect(inside).toContain("Imported ");
      expect(fixture.research.importRequests.map((request) => request.resolveMissing)).toEqual([
        "m2",
      ]);
      // The resolve turn's research session has read_story and the research tools but no way to edit the story.
      const researchTools = toolNames(fixture.backend.sessionsOf("research")[0]);
      expect(researchTools).toEqual(expect.arrayContaining(["read_story", ...EXTERNAL]));
      expect(researchTools).not.toContain("edit_story");
      expect(researchTools).not.toContain("edit_timeline");
    } finally {
      await fixture.cleanup();
    }
  });

  it("gives the Director the resolve work when Research is not enabled, with the story and the timeline still closed", async () => {
    const fixture = await createRuntimeFixture();
    try {
      const chat = await fixture.chats.create({}, ["editor"]);
      fixture.story.viewResult = storyView(storyWithMissing());
      let prompt = "";
      let closed: string[] | null = null;
      script(fixture, {
        director: async (input, session) => {
          prompt ||= input.text;
          closed ??= await usableTools(session, CLOSED_IN_RESOLVE);
          return "completed";
        },
      });
      await fixture.turns.start(chat.id, {
        prompt: "Find the missing material",
        storyAction: "resolve",
      });
      await settled(fixture, chat.id);

      expect(prompt).toContain("Research is off in this chat, so you do its work yourself");
      expect(prompt).toContain("Missing Asset nodes to resolve (2):");
      expect(prompt).not.toContain("Do nothing");
      expect(fixture.research.policyCalls).toBe(1);
      const director = toolNames(fixture.backend.sessionsOf("director")[0]);
      expect(director).toEqual(
        expect.arrayContaining([...EXTERNAL, "read_sources", "read_story", "delegate"]),
      );
      expect(closed).toEqual([]);
      expect(fixture.backend.sessionsOf("research")).toEqual([]);
    } finally {
      await fixture.cleanup();
    }
  });

  it("gives a build turn the research team of a normal turn, with the full-production steps", async () => {
    const fixture = await createRuntimeFixture();
    try {
      const chat = await fixture.chats.create({}, ["research", "editor"]);
      fixture.story.viewResult = storyView(storyWithMissing());
      let directorPrompt = "";
      let delegated: HostToolResult | null = null;
      script(fixture, {
        director: async (input, session) => {
          directorPrompt ||= input.text;
          if (delegated !== null) return "completed";
          delegated = await session.callTool("delegate", {
            agent: "research",
            title: "Find the sea sound",
            task: "Find m2",
          });
          await session.callTool("wait_for_agents", {});
          return "completed";
        },
      });
      await fixture.turns.start(chat.id, { prompt: "Build the video", storyAction: "build" });
      await settled(fixture, chat.id);

      expect(delegated).not.toMatchObject({ isError: true });
      const director = toolNames(fixture.backend.sessionsOf("director")[0]);
      expect(director).toEqual(expect.arrayContaining(["read_sources", "edit_story"]));
      expect(director.filter((name) => EXTERNAL.includes(name))).toEqual([]);
      expect(toolNames(fixture.backend.sessionsOf("research")[0])).toEqual(
        expect.arrayContaining(EXTERNAL),
      );
      expect(directorPrompt).toContain(
        "Material from outside the project comes only from Research",
      );
      expect(directorPrompt).toContain("resolveMissing");
      expect(directorPrompt).toContain("sound effects");
    } finally {
      await fixture.cleanup();
    }
  });

  it("offers no research tool in a rebuild turn, refuses delegating to Research and says so in the team roster", async () => {
    const fixture = await createRuntimeFixture();
    try {
      const chat = await fixture.chats.create({}, ["research", "editor"]);
      fixture.story.viewResult = storyView(storyWithMissing());
      let directorPrompt = "";
      let delegated: HostToolResult | null = null;
      let open: string[] | null = null;
      script(fixture, {
        director: async (input, session) => {
          directorPrompt ||= input.text;
          if (delegated !== null) return "completed";
          delegated = await session.callTool("delegate", {
            agent: "research",
            title: "x",
            task: "x",
          });
          open = await usableTools(session, ["read_sources", ...EXTERNAL]);
          return "completed";
        },
      });
      await fixture.turns.start(chat.id, { prompt: "Rebuild it", storyAction: "rebuild" });
      await settled(fixture, chat.id);

      expect(delegated).toMatchObject({
        isError: true,
        text: expect.stringContaining("Research cannot search or import in a Rebuild turn"),
      });
      expect(fixture.backend.sessionsOf("research")).toEqual([]);
      expect(directorPrompt).toContain("Research cannot search or import in a Rebuild turn");
      expect(directorPrompt).not.toContain(
        "Material from outside the project comes only from Research",
      );
      // Every session keeps its stable tool list; the rebuild turn refuses the research tools at dispatch.
      expect(open).toEqual([]);
    } finally {
      await fixture.cleanup();
    }
  });
});

// ── Permission requests in a running turn ────────────────────────────────────

/** The permission part of a chat's main (Director) message of the turn, if the card is there. */
function permissionPart(fixture: RuntimeFixture, chatId: string) {
  const state = fixture.chats.get(chatId);
  const turn = state?.turns.at(-1);
  const message = state?.messages.find((entry) => entry.id === turn?.assistantMessageId);
  if (!message || message.role !== "assistant") return null;
  return message.parts.find((part): part is PermissionPart => part.type === "permission") ?? null;
}

describe("a website tool asks the user from the chat", () => {
  it("shows the card in the main message, resumes the call on Allow once and revokes the grant at the end", async () => {
    const fixture = await createRuntimeFixture();
    try {
      fixture.research.policyResult = researchPolicy({
        websites: { readLinkedPages: false, fullAccess: false },
      });
      const chat = await fixture.chats.create({}, ["motion"]);
      let read: HostToolResult | null = null;
      fixture.backend.promptScript = async (_input, session) => {
        if (session.input.agent !== "director") return "completed";
        read = await session.callTool("read_website", { url: "https://linear.app" });
        return "completed";
      };
      const turn = await fixture.turns.start(chat.id, {
        prompt: "вот ссылка https://linear.app — сделай интро",
      });

      await waitUntil(() => permissionPart(fixture, chat.id) !== null, "the permission card");
      const pending = permissionPart(fixture, chat.id);
      expect(pending?.permission).toMatchObject({
        kind: "read_linked_pages",
        action: "read",
        site: "linear.app",
        agent: "director",
        state: "pending",
      });
      expect(fixture.research.websiteRequests).toEqual([]);

      const answered = await fixture.turns.answerPermission(
        chat.id,
        turn.id,
        pending?.permission.id ?? "",
        "once",
      );
      expect(answered.permission.state).toBe("allowed_once");
      await settled(fixture, chat.id);

      expect(read).toMatchObject({
        text: expect.stringContaining("allowed reading linked pages on linear.app once"),
      });
      expect(fixture.research.grants).toEqual([
        { turnId: turn.id, access: "read", site: "linear.app" },
      ]);
      expect(fixture.research.websiteRequests).toEqual([
        { url: "https://linear.app", allowedSites: ["linear.app"], turnId: turn.id },
      ]);
      // The card's final state is in the live chat and in the durable event log (a reload shows it).
      expect(permissionPart(fixture, chat.id)?.permission.state).toBe("allowed_once");
      const reloaded = await fixture.store.load(chat.id);
      const part = reloaded.state?.messages
        .flatMap((message) => (message.role === "assistant" ? message.parts : []))
        .find((entry) => entry.type === "permission");
      expect(part).toMatchObject({ permission: { state: "allowed_once" } });
      // The turn's grant is revoked when it ends.
      expect(fixture.research.revokedGrants).toEqual([turn.id]);
    } finally {
      await fixture.cleanup();
    }
  });

  it("expires a pending card when the turn is stopped, and the waiting call is refused", async () => {
    const fixture = await createRuntimeFixture();
    try {
      fixture.research.policyResult = researchPolicy({
        websites: { readLinkedPages: false, fullAccess: false },
      });
      const chat = await fixture.chats.create({});
      let read: HostToolResult | null = null;
      fixture.backend.promptScript = async (_input, session) => {
        read = await session.callTool("read_website", { url: "https://linear.app" });
        return "completed";
      };
      const turn = await fixture.turns.start(chat.id, {
        prompt: "вот ссылка https://linear.app — сделай интро",
      });
      await waitUntil(() => permissionPart(fixture, chat.id) !== null, "the permission card");

      fixture.turns.abort(chat.id, turn.id);
      await settled(fixture, chat.id);

      expect(read).toMatchObject({
        isError: true,
        text: expect.stringContaining("turn ended before the user answered"),
      });
      expect(permissionPart(fixture, chat.id)?.permission.state).toBe("expired");
      expect(fixture.research.grants).toEqual([]);
      expect(fixture.research.websiteRequests).toEqual([]);
    } finally {
      await fixture.cleanup();
    }
  });

  it("refuses an answer for an unknown request and after the turn ended", async () => {
    const fixture = await createRuntimeFixture();
    try {
      fixture.research.policyResult = researchPolicy({
        websites: { readLinkedPages: false, fullAccess: false },
      });
      const chat = await fixture.chats.create({});
      fixture.backend.promptScript = async (_input, session) => {
        await session.callTool("read_website", { url: "https://linear.app" });
        return "completed";
      };
      const turn = await fixture.turns.start(chat.id, {
        prompt: "вот ссылка https://linear.app",
      });
      await waitUntil(() => permissionPart(fixture, chat.id) !== null, "the permission card");
      const permissionId = permissionPart(fixture, chat.id)?.permission.id ?? "";
      await expect(
        fixture.turns.answerPermission(chat.id, turn.id, "unknown", "once"),
      ).rejects.toMatchObject({ code: "turn_not_active" });
      await expect(
        fixture.turns.answerPermission(chat.id, "unknown-turn", permissionId, "once"),
      ).rejects.toMatchObject({ code: "turn_not_found" });
      await expect(
        fixture.turns.answerPermission("unknown-chat", turn.id, permissionId, "once"),
      ).rejects.toMatchObject({ code: "chat_not_found" });

      await fixture.turns.answerPermission(chat.id, turn.id, permissionId, "deny");
      await settled(fixture, chat.id);
      await expect(
        fixture.turns.answerPermission(chat.id, turn.id, permissionId, "once"),
      ).rejects.toMatchObject({ code: "turn_not_active" });
    } finally {
      await fixture.cleanup();
    }
  });
});
