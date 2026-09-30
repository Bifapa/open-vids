import { describe, expect, it } from "vitest";
import { EXECUTION_BUDGETS } from "@hyperframes/agent-protocol";
import type { HostToolResult } from "../backend.js";
import { SAMPLE_SOURCE } from "../testing/analysis.js";
import { cleanCheck, qaDraft } from "../testing/qa.js";
import { createRuntimeFixture, type RuntimeFixture } from "../testing/runtimeFixture.js";
import {
  directorScript,
  finding,
  qaChat,
  quality,
  script,
  settled,
  visionScript,
} from "./harness.js";

const toolNames = (fixture: RuntimeFixture, agent: "vision") =>
  fixture.backend.sessionsOf(agent)[0]?.input.hostTools.map((tool) => tool.name) ?? [];

describe("Execution Quality of a turn", () => {
  it.each(["fast", "balanced", "best"] as const)(
    "resolves the %s preset, records it on the turn and states it to the Director",
    async (preset) => {
      const fixture = await createRuntimeFixture();
      try {
        const chat = await fixture.chats.create({}, ["editor", "vision"]);
        await fixture.chats.update(chat.id, {
          executionQuality: { preset, custom: { ...EXECUTION_BUDGETS.balanced, qaPasses: 5 } },
        });
        let roster = "";
        script(fixture, {
          director: async (input) => {
            roster = input.text;
            return "completed";
          },
        });
        const started = await fixture.turns.start(chat.id, { prompt: "What is in the project?" });
        await settled(fixture, chat.id);

        const budget = EXECUTION_BUDGETS[preset];
        expect(started.execution).toEqual({ preset, budget });
        expect(fixture.chats.get(chat.id)?.turns[0]?.execution).toEqual({ preset, budget });
        const name = preset[0]?.toUpperCase() + preset.slice(1);
        expect(roster).toContain(`Execution quality: ${name}.`);
        expect(roster).toContain(
          `at most ${budget.qaPasses} ${budget.qaPasses === 1 ? "pass" : "passes"} (${budget.qaPasses - 1} ${budget.qaPasses === 2 ? "correction" : "corrections"})`,
        );
        expect(roster).toContain(`Vision's review of up to ${budget.qaMaxFrames} frames`);
        expect(roster).toContain(`Research compares up to ${budget.researchCandidates} candidates`);
        expect(roster).toContain(`up to ${budget.analysisFramesPerSource} frames per source`);
      } finally {
        await fixture.cleanup();
      }
    },
  );

  it("uses the custom budget clamped to its ranges, the chat's choice over the global default, and the default once cleared", async () => {
    const fixture = await createRuntimeFixture();
    try {
      await fixture.settings.update({
        executionQuality: { preset: "best", custom: { ...EXECUTION_BUDGETS.balanced } },
      });
      const chat = await fixture.chats.create({}, []);
      const run = async (prompt: string) => {
        await fixture.turns.start(chat.id, { prompt });
        await settled(fixture, chat.id);
        return fixture.chats.get(chat.id)?.turns.at(-1)?.execution;
      };

      expect(await run("one")).toEqual({ preset: "best", budget: EXECUTION_BUDGETS.best });

      await fixture.chats.update(chat.id, { executionQuality: quality(4, { qaMaxFrames: 30 }) });
      expect(await run("two")).toMatchObject({
        preset: "custom",
        budget: { qaPasses: 4, qaMaxFrames: 30, specialistThinking: "configured" },
      });

      // A hand-edited out-of-range custom budget is clamped, never trusted.
      await fixture.chats.update(chat.id, {
        executionQuality: quality(99, { critiqueRounds: 0, researchCandidates: 1000 }),
      });
      expect(await run("three")).toMatchObject({
        budget: { qaPasses: 5, critiqueRounds: 1, researchCandidates: 24 },
      });

      await fixture.chats.update(chat.id, { executionQuality: null });
      expect(await run("four")).toEqual({ preset: "best", budget: EXECUTION_BUDGETS.best });
    } finally {
      await fixture.cleanup();
    }
  });

  describe("specialist thinking policy", () => {
    it.each([
      ["economy", "high", "low"],
      ["economy", null, "low"],
      ["economy", "minimal", "minimal"],
      ["configured", "medium", "medium"],
      ["configured", null, null],
      ["thorough", "low", "high"],
      ["thorough", null, "high"],
      ["thorough", "max", "max"],
    ] as const)(
      "%s with a configured effort of %s runs a delegated specialist at %s",
      async (policy, configured, expected) => {
        const fixture = await createRuntimeFixture();
        try {
          const chat = await fixture.chats.create({}, ["editor"]);
          await fixture.chats.update(chat.id, {
            executionQuality: quality(0, { specialistThinking: policy }),
            agentOverrides: {
              editor: { model: null, thinking: configured, allowedModels: [] },
            },
          });
          script(fixture, {
            director: async (_input, session) => {
              await session.callTool("delegate", { agent: "editor", title: "Cut", task: "Cut it" });
              await session.callTool("wait_for_agents", {});
              return "completed";
            },
          });
          await fixture.turns.start(chat.id, { prompt: "Cut the intro" });
          await settled(fixture, chat.id);

          expect(fixture.chats.get(chat.id)?.runs[0]?.thinking).toBe(expected);
          expect(fixture.backend.sessionsOf("editor")[0]?.prompts[0]?.thinking).toBe(expected);
        } finally {
          await fixture.cleanup();
        }
      },
    );

    it("applies the policy to the Vision run of a QA review as well", async () => {
      const fixture = await createRuntimeFixture();
      try {
        const chatId = await qaChat(fixture, quality(1, { specialistThinking: "economy" }));
        fixture.qa.checkResults = [cleanCheck()];
        const director = directorScript(fixture);
        script(fixture, { director: director.run, vision: visionScript([]) });
        await fixture.turns.start(chatId, { prompt: "Tighten the intro" });
        await settled(fixture, chatId);
        const visionRun = fixture.chats.get(chatId)?.runs.find((run) => run.agent === "vision");
        expect(visionRun?.thinking).toBe("low");
        expect(fixture.backend.sessionsOf("vision")[0]?.prompts[0]?.thinking).toBe("low");
      } finally {
        await fixture.cleanup();
      }
    });
  });

  describe("research candidates", () => {
    it.each([
      [undefined, 4],
      [2, 2],
      [20, 4],
    ])(
      "search_assets with limit %s searches with limit %s under the Fast budget",
      async (limit, expected) => {
        const fixture = await createRuntimeFixture();
        try {
          const chat = await fixture.chats.create({}, ["research"]);
          await fixture.chats.update(chat.id, {
            executionQuality: { preset: "fast", custom: { ...EXECUTION_BUDGETS.balanced } },
          });
          let task = "";
          script(fixture, {
            director: async (_input, session) => {
              await session.callTool("delegate", {
                agent: "research",
                title: "Find",
                task: "Find waves",
              });
              await session.callTool("wait_for_agents", {});
              return "completed";
            },
            research: async (input, session) => {
              task = input.text;
              await session.callTool("search_assets", {
                query: "ocean waves",
                mediaKind: "video",
                ...(limit !== undefined && { limit }),
              });
              return "completed";
            },
          });
          await fixture.turns.start(chat.id, { prompt: "Find ocean footage" });
          await settled(fixture, chat.id);

          expect(fixture.research.searchRequests).toHaveLength(1);
          expect(fixture.research.searchRequests[0]?.limit).toBe(expected);
          expect(task).toContain("Compare at most 4 candidates per search");
        } finally {
          await fixture.cleanup();
        }
      },
    );
  });

  describe("long-form analysis frames", () => {
    it("caps the frames inspect_frames may extract per source in a turn, counting each time once", async () => {
      const fixture = await createRuntimeFixture();
      try {
        // No Vision in the team: the Director looks at frames itself.
        const chat = await fixture.chats.create({}, []);
        await fixture.chats.update(chat.id, {
          executionQuality: { preset: "fast", custom: { ...EXECUTION_BUDGETS.balanced } },
        });
        const results: HostToolResult[] = [];
        script(fixture, {
          director: async (_input, session) => {
            const look = async (source: string, times: number[]) =>
              results.push(await session.callTool("inspect_frames", { source, times }));
            await look(SAMPLE_SOURCE, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
            await look(SAMPLE_SOURCE, [1, 2, 3, 20, 21, 22, 23, 24]);
            await look(SAMPLE_SOURCE, [1, 2, 3, 20, 21, 22, 23]);
            await look(SAMPLE_SOURCE, [30]);
            await look("assets/other.mp4", [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
            return "completed";
          },
        });
        await fixture.turns.start(chat.id, { prompt: "Look at the talk" });
        await settled(fixture, chat.id);

        expect(results.map((result) => Boolean(result.isError))).toEqual([
          false,
          true,
          false,
          true,
          false,
        ]);
        expect(results[1]?.text).toContain("12 of 16 frames were already inspected");
        expect(results[1]?.text).toContain("Execution Quality budget");
        expect(results[1]?.text).toContain("at most 4 new frames");
        expect(results[3]?.text).toContain("Work from the frames you already saw");
        expect(fixture.analysis.frameRequests.map((request) => request.source)).toEqual([
          SAMPLE_SOURCE,
          SAMPLE_SOURCE,
          "assets/other.mp4",
        ]);
      } finally {
        await fixture.cleanup();
      }
    });
  });

  describe("render review budget", () => {
    it("lets only Vision review, refuses outside a review, and enforces frames, rounds and 12 per call", async () => {
      const fixture = await createRuntimeFixture();
      try {
        const chatId = await qaChat(fixture, quality(1, { qaMaxFrames: 5, critiqueRounds: 2 }));
        fixture.qa.checkResults = [
          cleanCheck({
            issues: [qaDraft()],
            samples: Array.from({ length: 8 }, (_, index) => ({
              time: index + 1,
              reason: "coverage" as const,
              context: `sample ${index + 1}`,
            })),
          }),
        ];
        const results: Array<[string, HostToolResult]> = [];
        let task = "";
        const director = directorScript(fixture);
        script(fixture, {
          director: director.run,
          vision: async (input, session) => {
            task = input.text;
            const inspect = async (label: string, times: number[]) =>
              results.push([label, await session.callTool("inspect_render", { times })]);
            await inspect(
              "thirteen",
              Array.from({ length: 13 }, (_, index) => index * 0.5),
            );
            await inspect("past the end", [99]);
            await inspect("first look", [1, 2, 3]);
            await inspect("too many left", [4, 5, 6]);
            await inspect("second look", [4, 5]);
            await inspect("third round", [6]);
            results.push([
              "bad finding",
              await session.callTool("report_render_findings", {
                findings: [finding({ kind: "not_a_kind" })],
              }),
            ]);
            results.push([
              "after the end",
              await session.callTool("report_render_findings", {
                findings: [finding({ start: 40, end: 41 })],
              }),
            ]);
            results.push([
              "report",
              await session.callTool("report_render_findings", {
                findings: [finding({ kind: "black_frames", subject: null, start: 6, end: 6.4 })],
              }),
            ]);
            return "completed";
          },
        });
        await fixture.turns.start(chatId, { prompt: "Tighten the intro" });
        await settled(fixture, chatId);

        const byLabel = Object.fromEntries(results);
        expect(byLabel["thirteen"]).toMatchObject({ isError: true });
        expect(byLabel["thirteen"]?.text).toContain("at most 12 frames per call");
        expect(byLabel["past the end"]?.text).toContain("after the end of the render (12 s)");
        expect(byLabel["first look"]).toMatchObject({ images: [{}, {}, {}] });
        expect(byLabel["first look"]?.text).toContain("Budget left: 2 frames, 1 rounds.");
        expect(byLabel["too many left"]?.text).toContain(
          "only 2 of 5 remain in this review's budget",
        );
        expect(byLabel["second look"]?.isError).toBeUndefined();
        expect(byLabel["third round"]?.text).toContain("Critique rounds used: 2 of 2");
        expect(byLabel["bad finding"]?.text).toContain("findings[0].kind must be one of");
        expect(byLabel["after the end"]?.text).toContain("after the end of the render");
        expect(byLabel["report"]?.text).toContain("Recorded 1 finding");

        // The refusals cost no budget: only the two accepted looks reached the service.
        expect(fixture.qa.frameRequests).toEqual([
          { render: "renders/final.mp4", times: [1, 2, 3] },
          { render: "renders/final.mp4", times: [4, 5] },
        ]);
        expect(fixture.qa.reports[0]?.vision).toMatchObject({
          status: "ran",
          frames: 5,
          rounds: 2,
        });
        // Findings carry the source the runtime gives them, whatever the model says.
        expect(fixture.qa.reports[0]?.issues.map((issue) => [issue.kind, issue.source])).toEqual([
          ["black_frames", "render"],
          ["black_frames", "vision"],
        ]);
        // Only the first 5 planned samples reach Vision (the turn's frame budget), with the budget stated.
        expect(task).toContain("5 frames in total, at most 2 inspect_render calls");
        expect(task).toContain("- 5.0 s · coverage · sample 5");
        expect(task).not.toContain("sample 6");
        expect(task).toContain("Already found by the deterministic checks");
      } finally {
        await fixture.cleanup();
      }
    });

    it("gives the tools to Vision only, and refuses them when no review is open", async () => {
      const fixture = await createRuntimeFixture();
      try {
        const chat = await fixture.chats.create({}, ["editor", "vision"]);
        let outside: HostToolResult | null = null;
        let reportOutside: HostToolResult | null = null;
        script(fixture, {
          director: async (_input, session) => {
            await session.callTool("delegate", { agent: "vision", title: "Look", task: "Look" });
            await session.callTool("wait_for_agents", {});
            return "completed";
          },
          vision: async (_input, session) => {
            outside = await session.callTool("inspect_render", { times: [1] });
            reportOutside = await session.callTool("report_render_findings", { findings: [] });
            return "completed";
          },
        });
        await fixture.turns.start(chat.id, { prompt: "Look at the project" });
        await settled(fixture, chat.id);

        expect(toolNames(fixture, "vision")).toEqual(
          expect.arrayContaining(["inspect_render", "report_render_findings"]),
        );
        for (const session of [
          ...fixture.backend.sessionsOf("director"),
          ...fixture.backend.sessionsOf("editor"),
        ]) {
          const names = session.input.hostTools.map((tool) => tool.name);
          expect(names).not.toContain("inspect_render");
          expect(names).not.toContain("report_render_findings");
        }
        expect(outside).toMatchObject({
          isError: true,
          text: expect.stringContaining("works only during a Render QA review"),
        });
        expect(reportOutside).toMatchObject({ isError: true });
        expect(fixture.qa.frameRequests).toEqual([]);
      } finally {
        await fixture.cleanup();
      }
    });
  });
});
