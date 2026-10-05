import { describe, expect, it } from "vitest";
import { SPECIALIST_IDS, type AgentId } from "@hyperframes/agent-protocol";
import { isQaClosing, quality } from "../qa/harness.js";
import type { HostToolResult } from "../backend.js";
import { createRuntimeFixture, waitUntil, type RuntimeFixture } from "../testing/runtimeFixture.js";
import { toolNames } from "../testing/usable.js";

/** The composition frames tool inside a running turn: who gets it, the budget and the host wiring. */

async function settled(fixture: RuntimeFixture, chatId: string): Promise<void> {
  await waitUntil(
    () =>
      fixture.chats.get(chatId)?.turns.at(-1)?.status !== "running" &&
      fixture.turns.activeTurn === null,
    "the turn to end",
  );
}

describe("inspect_composition in a turn", () => {
  it("reaches the frames host from the Director and returns the frames as images", async () => {
    const fixture = await createRuntimeFixture();
    try {
      const chat = await fixture.chats.create({}, ["editor", "vision"]);
      const seen: HostToolResult[] = [];
      fixture.backend.promptScript = async (input, session) => {
        if (isQaClosing(input) || seen.length > 0) return "completed";
        seen.push(
          await session.callTool("inspect_composition", {
            times: [1, 4],
            composition: "compositions/intro.html",
          }),
        );
        return "completed";
      };
      await fixture.turns.start(chat.id, { prompt: "Look at the intro" });
      await settled(fixture, chat.id);

      expect(fixture.frames.requests).toEqual([
        { times: [1, 4], composition: "compositions/intro.html" },
      ]);
      expect(seen[0]?.isError).toBeUndefined();
      expect(seen[0]?.images).toHaveLength(2);
      expect(seen[0]?.text).toContain("2 frames of compositions/intro.html");
      // The turn's signal reaches the host, and the call is closed with the turn.
      expect(fixture.frames.signals).toHaveLength(1);
    } finally {
      await fixture.cleanup();
    }
  });

  it("is in the sessions of the agents that judge or change the picture, and in no other", async () => {
    const fixture = await createRuntimeFixture();
    try {
      const chat = await fixture.chats.create({}, [
        "editor",
        "motion",
        "vision",
        "audio",
        "research",
      ]);
      fixture.backend.promptScript = async (input, session) => {
        if (isQaClosing(input) || session.input.agent !== "director") return "completed";
        for (const agent of SPECIALIST_IDS) {
          await session.callTool("delegate", { agent, title: agent, task: `Work as ${agent}` });
        }
        await session.callTool("wait_for_agents", {});
        return "completed";
      };
      await fixture.turns.start(chat.id, { prompt: "Check the picture" });
      await settled(fixture, chat.id);

      const has = (agent: AgentId) =>
        toolNames(fixture.backend.sessionsOf(agent)[0]).includes("inspect_composition");
      expect(has("director")).toBe(true);
      expect(SPECIALIST_IDS.filter(has)).toEqual(["editor", "vision", "motion"]);
    } finally {
      await fixture.cleanup();
    }
  });

  it("is the Director's own when every specialist that would look is off", async () => {
    const fixture = await createRuntimeFixture();
    try {
      const chat = await fixture.chats.create({}, ["audio", "research"]);
      fixture.backend.promptScript = async () => "completed";
      await fixture.turns.start(chat.id, { prompt: "Check the picture" });
      await settled(fixture, chat.id);
      expect(toolNames(fixture.backend.sessionsOf("director")[0])).toContain("inspect_composition");
    } finally {
      await fixture.cleanup();
    }
  });

  it("keeps a per-turn frame budget and refuses a call that would exceed it, naming what is left", async () => {
    const fixture = await createRuntimeFixture();
    try {
      const chat = await fixture.chats.create({}, []);
      await fixture.chats.update(chat.id, {
        executionQuality: quality(1, { analysisFramesPerSource: 8 }),
      });
      const seen: HostToolResult[] = [];
      fixture.backend.promptScript = async (input, session) => {
        if (isQaClosing(input) || seen.length > 0) return "completed";
        seen.push(await session.callTool("inspect_composition", { times: [1, 2, 3, 4, 5, 6] }));
        seen.push(await session.callTool("inspect_composition", { times: [7, 8, 9] }));
        return "completed";
      };
      await fixture.turns.start(chat.id, { prompt: "Look at it" });
      await settled(fixture, chat.id);

      expect(seen[0]?.isError).toBeUndefined();
      expect(seen[1]).toMatchObject({
        isError: true,
        text: expect.stringContaining("Ask for at most 2 frames"),
      });
      expect(fixture.frames.requests).toHaveLength(1);
    } finally {
      await fixture.cleanup();
    }
  });

  it("is not offered, and says so, when the runtime has no frames host", async () => {
    const fixture = await createRuntimeFixture({ frames: undefined });
    try {
      const chat = await fixture.chats.create({}, ["editor", "vision"]);
      fixture.backend.promptScript = async () => "completed";
      await fixture.turns.start(chat.id, { prompt: "Look at it" });
      await settled(fixture, chat.id);
      for (const session of fixture.backend.sessions) {
        expect(toolNames(session)).not.toContain("inspect_composition");
      }
    } finally {
      await fixture.cleanup();
    }
  });

  it("refuses a call that arrives after the turn ended", async () => {
    const fixture = await createRuntimeFixture();
    try {
      const chat = await fixture.chats.create({}, []);
      fixture.backend.promptScript = async () => "completed";
      await fixture.turns.start(chat.id, { prompt: "Say hi" });
      await settled(fixture, chat.id);
      const session = fixture.backend.sessionsOf("director")[0];
      const late = await session?.callTool("inspect_composition", { times: [1] });
      expect(late).toMatchObject({
        isError: true,
        text: expect.stringContaining("no running turn"),
      });
      expect(fixture.frames.requests).toEqual([]);
    } finally {
      await fixture.cleanup();
    }
  });
});
