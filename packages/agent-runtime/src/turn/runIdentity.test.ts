import { describe, expect, it } from "vitest";
import type { AgentId } from "@hyperframes/agent-protocol";
import type { BackendPromptInput, BackendPromptOutcome } from "../backend.js";
import type { ScriptedSession } from "../testing/backend.js";
import { createRuntimeFixture, waitUntil, type RuntimeFixture } from "../testing/runtimeFixture.js";

type AgentScript = (
  input: BackendPromptInput,
  session: ScriptedSession,
) => Promise<BackendPromptOutcome>;

/** These tests are about who a session works for, not Render QA: the fixture's QA host stays out of the turn. */
const NO_QA = { qa: undefined } as const;

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

/** Jev as the user would have configured it: signed in, on a model the catalog lists. */
async function enableJev(fixture: RuntimeFixture): Promise<void> {
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
}

/** What the harness asks the runtime before it writes a composition file itself. */
const claim = (session: ScriptedSession, file: string): string | null => {
  const ask = session.input.claimWriteFiles;
  if (!ask) throw new Error("the session has no write claim");
  return ask([file]);
};

describe("write leases follow the run a session serves", () => {
  it("lets a Jev run write the file of the specialist run that called it", async () => {
    const fixture = await createRuntimeFixture(NO_QA);
    try {
      const chat = await fixture.chats.create({}, ["editor"]);
      await enableJev(fixture);
      let editorClaim: string | null = "unset";
      let jevClaim: string | null = "unset";
      script(fixture, {
        director: async (_input, session) => {
          await session.callTool("delegate", {
            agent: "editor",
            title: "Fix",
            task: "Fix the intro",
          });
          await session.callTool("wait_for_agents", {});
          return "completed";
        },
        editor: async (_input, session) => {
          editorClaim = claim(session, "index.html");
          await session.callTool("jev", { title: "Nudge", task: "Nudge the title" });
          return "completed";
        },
        jev: async (_input, session) => {
          jevClaim = claim(session, "index.html");
          return "completed";
        },
      });
      await fixture.turns.start(chat.id, { prompt: "Fix the intro" });
      await settled(fixture, chat.id);
      expect(editorClaim).toBeNull();
      expect(jevClaim).toBeNull();
    } finally {
      await fixture.cleanup();
    }
  });

  it("keeps two Jev runs of the Director from sharing one lease", async () => {
    const fixture = await createRuntimeFixture(NO_QA);
    try {
      const chat = await fixture.chats.create({}, ["editor"]);
      await enableJev(fixture);
      const firstHolds = Promise.withResolvers<void>();
      const secondTried = Promise.withResolvers<void>();
      const claims: Array<string | null> = [];
      let started = 0;
      script(fixture, {
        director: async (_input, session) => {
          await Promise.all([
            session.callTool("jev", { title: "First", task: "Touch index.html" }),
            session.callTool("jev", { title: "Second", task: "Touch index.html too" }),
          ]);
          return "completed";
        },
        jev: async (_input, session) => {
          started += 1;
          if (started === 1) {
            claims.push(claim(session, "index.html"));
            firstHolds.resolve();
            await secondTried.promise;
          } else {
            await firstHolds.promise;
            claims.push(claim(session, "index.html"));
            secondTried.resolve();
          }
          return "completed";
        },
      });
      await fixture.turns.start(chat.id, { prompt: "Touch the title twice" });
      await settled(fixture, chat.id);
      expect(claims[0]).toBeNull();
      expect(claims[1]).toContain("Jev");
      expect(claims[1]).toContain("is changing that file");
    } finally {
      await fixture.cleanup();
    }
  });

  it("tells the two runs of one specialist apart", async () => {
    const fixture = await createRuntimeFixture(NO_QA);
    try {
      const chat = await fixture.chats.create({}, ["vision"]);
      const firstHolds = Promise.withResolvers<void>();
      const secondTried = Promise.withResolvers<void>();
      let secondClaim: string | null = "unset";
      script(fixture, {
        director: async (_input, session) => {
          await session.callTool("delegate", { agent: "vision", title: "One", task: "FIRST-TASK" });
          await session.callTool("delegate", {
            agent: "vision",
            title: "Two",
            task: "SECOND-TASK",
          });
          await session.callTool("wait_for_agents", {});
          return "completed";
        },
        vision: async (input, session) => {
          if (input.text.includes("FIRST-TASK")) {
            expect(claim(session, "index.html")).toBeNull();
            firstHolds.resolve();
            await secondTried.promise;
          } else {
            await firstHolds.promise;
            secondClaim = claim(session, "index.html");
            secondTried.resolve();
          }
          return "completed";
        },
      });
      await fixture.turns.start(chat.id, { prompt: "Check twice" });
      await settled(fixture, chat.id);
      const firstRun = fixture.chats.get(chat.id)?.runs.find((run) => run.title === "One");
      expect(secondClaim).toContain("Vision");
      expect(secondClaim).toContain(firstRun?.id ?? "no run");
    } finally {
      await fixture.cleanup();
    }
  });
});

describe("tool calls follow the run that made them", () => {
  it("records each concurrent Research run's own model in the provenance of what it imports", async () => {
    const fixture = await createRuntimeFixture(NO_QA);
    await fixture.settings.update({ autonomy: { askBeforeDownloads: false } });
    try {
      const chat = await fixture.chats.create({}, ["research"]);
      const secondImported = Promise.withResolvers<void>();
      script(fixture, {
        director: async (_input, session) => {
          await session.callTool("delegate", { agent: "research", title: "A", task: "FIRST-TASK" });
          await session.callTool("delegate", {
            agent: "research",
            title: "B",
            task: "SECOND-TASK",
          });
          await session.callTool("wait_for_agents", {});
          return "completed";
        },
        research: async (input, session) => {
          const first = input.text.includes("FIRST-TASK");
          input.onEvent({
            type: "model.resolved",
            model: { provider: "test", modelId: first ? "model-a" : "model-b" },
            thinking: null,
          });
          await session.callTool("import_asset", { candidate: first ? "cand-a" : "cand-b" });
          // The first run is still going while the second imports.
          if (first) await secondImported.promise;
          else secondImported.resolve();
          return "completed";
        },
      });
      await fixture.turns.start(chat.id, { prompt: "Add two clips" });
      await settled(fixture, chat.id);
      const modelOf = (candidate: string) =>
        fixture.research.importRequests.find((request) => request.candidate === candidate)?.model;
      expect(modelOf("cand-a")).toBe("test/model-a");
      expect(modelOf("cand-b")).toBe("test/model-b");
    } finally {
      await fixture.cleanup();
    }
  });
});
