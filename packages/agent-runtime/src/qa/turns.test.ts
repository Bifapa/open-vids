import { describe, expect, it } from "vitest";
import { QA_LIMITS } from "@hyperframes/agent-protocol";
import { EditingError } from "../editing/host.js";
import { createRuntimeFixture, waitUntil, type RuntimeFixture } from "../testing/runtimeFixture.js";
import { cleanCheck, qaDraft } from "../testing/qa.js";
import {
  directorScript,
  finding,
  qaChat,
  qaTimeline,
  quality,
  script,
  settled,
  untilAborted,
  visionScript,
} from "./harness.js";
import { QaToolError } from "./host.js";

const BLACK = qaDraft();
const AWKWARD = qaDraft({
  kind: "awkward_cut",
  severity: "warning",
  check: "timeline.flash_clip",
  source: "timeline",
  start: 8,
  end: 8.2,
  clipIds: ["c9"],
  subject: "c9",
  message: "A 0.2 s flash clip.",
  suggestion: "Remove or lengthen it.",
});
const MISSING = qaDraft({
  kind: "missing_broll",
  severity: "warning",
  check: "timeline.missing_file",
  source: "timeline",
  start: 2,
  end: 4,
  clipIds: ["c5"],
  subject: "c5",
  message: "The B-roll file is missing on disk.",
});
const BLACK_SUBJECT = qaDraft({ subject: "c2" });

const phasesOf = (fixture: RuntimeFixture, chatId: string) =>
  fixture.chats.get(chatId)?.turns[0]?.qa?.passes.map((pass) => pass.phase);

describe("render QA in a turn", () => {
  it("renders, checks, reviews, corrects and verifies: lifecycle, reports and the qa.updated sequence", async () => {
    const fixture = await createRuntimeFixture();
    try {
      const chatId = await qaChat(fixture, quality(2));
      fixture.qa.checkResults = [cleanCheck({ issues: [BLACK_SUBJECT] }), cleanCheck()];
      const director = directorScript(fixture);
      script(fixture, { director: director.run, vision: visionScript([]) });

      const turn = await fixture.turns.start(chatId, { prompt: "Tighten the intro" });
      await settled(fixture, chatId);

      expect(fixture.chats.get(chatId)?.turns[0]).toMatchObject({
        id: turn.id,
        status: "completed",
        execution: { preset: "custom", budget: { qaPasses: 2 } },
        qa: {
          status: "passed",
          preset: "custom",
          passLimit: 2,
          reason: null,
          passes: [
            {
              pass: 1,
              phase: "corrected",
              reportId: "qa-report-1",
              renderPath: "renders/final.mp4",
              vision: "ran",
              counts: { issues: 1, new: 1, fixable: 1 },
            },
            { pass: 2, phase: "done", reportId: "qa-report-2", counts: { issues: 0, fixed: 1 } },
          ],
        },
      });
      expect(qaTimeline(fixture, chatId)).toEqual([
        "running|",
        "running|1:rendering",
        "running|1:checking",
        "running|1:reviewing",
        "running|1:done",
        "running|1:correcting",
        "running|1:corrected",
        "running|1:corrected,2:rendering",
        "running|1:corrected,2:checking",
        "running|1:corrected,2:reviewing",
        "running|1:corrected,2:done",
        "passed|1:corrected,2:done",
      ]);

      // Preview renders, each followed by the checks with the turn's frame budget.
      expect(fixture.editing.renderRequests).toEqual([{ quality: "draft" }, { quality: "draft" }]);
      expect(fixture.qa.checkRequests).toEqual([
        {
          render: "renders/final.mp4",
          composition: "index.html",
          framesPerMinute: 12,
          maxFrames: 24,
        },
        {
          render: "renders/final.mp4",
          composition: "index.html",
          framesPerMinute: 12,
          maxFrames: 24,
        },
      ]);

      // The stored reports chain: what pass 2 fixed is recorded against pass 1's issue.
      const [first, second] = fixture.qa.reports;
      expect(first).toMatchObject({
        sessionId: turn.id,
        turnId: turn.id,
        chatId,
        pass: 1,
        passLimit: 2,
        fingerprint: "fp-1",
        previousReportId: null,
        render: { path: "renders/final.mp4", quality: "draft", width: 1920 },
        renderError: null,
        vision: { status: "ran", frames: 2, rounds: 1, reason: null },
        issues: [{ id: "p1-1", status: "new", firstSeenPass: 1, kind: "black_frames" }],
        resolved: [],
      });
      expect(second).toMatchObject({
        pass: 2,
        fingerprint: "fp-2",
        previousReportId: "qa-report-1",
        issues: [],
        resolved: [{ id: "p1-1", status: "fixed" }],
      });
      expect(first?.checks.map((check) => check.id)).toEqual([
        "render",
        "black_frames",
        "frozen_frames",
        "audio",
        "timeline",
        "layout",
        "vision",
      ]);

      // Director prompts: the work, one correction, the final report — the Vision runs never re-prompt it.
      const prompts = fixture.backend.sessionsOf("director")[0]?.prompts.map((p) => p.text) ?? [];
      expect(prompts).toHaveLength(3);
      expect(director.seen.corrections).toHaveLength(1);
      expect(director.seen.corrections[0]).toContain('<render-qa pass="1" limit="2">');
      expect(director.seen.corrections[0]).toContain("[p1-1]");
      expect(director.seen.corrections[0]).toContain("Fill the gap with B-roll");
      expect(director.seen.finals).toHaveLength(1);
      expect(director.seen.finals[0]).toContain('<render-qa-final outcome="passed">');
      expect(director.seen.finals[0]).toContain("Fixed during QA (1)");
      expect(director.seen.finals[0]).toContain("renders/final.mp4");

      const runs = fixture.chats.get(chatId)?.runs ?? [];
      expect(runs.map((run) => [run.agent, run.title, run.status])).toEqual([
        ["vision", "Render QA · pass 1", "completed"],
        ["vision", "Render QA · pass 2", "completed"],
      ]);
      expect(fixture.checkpoints.windows[0]?.ended).toBe(true);
    } finally {
      await fixture.cleanup();
    }
  });

  it("records `skipped` when Render QA is off and the project changed, and stays silent when nothing changed", async () => {
    const fixture = await createRuntimeFixture();
    try {
      const off = await qaChat(fixture, quality(0));
      const director = directorScript(fixture);
      script(fixture, { director: director.run });
      await fixture.turns.start(off, { prompt: "Change something" });
      await settled(fixture, off);
      expect(fixture.chats.get(off)?.turns[0]?.qa).toMatchObject({
        status: "skipped",
        reason: "Render QA is off",
        passLimit: 0,
        passes: [],
      });
      expect(qaTimeline(fixture, off)).toEqual(["skipped|"]);
      expect(fixture.editing.renderRequests).toEqual([]);
      expect(fixture.qa.checkRequests).toEqual([]);
      expect(fixture.backend.sessionsOf("director")[0]?.prompts).toHaveLength(1);

      // A turn that changes nothing is never checked, however many passes are allowed.
      const idle = await qaChat(fixture, quality(3));
      script(fixture, {
        director: async () => "completed",
      });
      await fixture.turns.start(idle, { prompt: "What is in the project?" });
      await settled(fixture, idle);
      expect(fixture.chats.get(idle)?.turns[0]?.qa).toBeUndefined();
      expect(qaTimeline(fixture, idle)).toEqual([]);
      expect(fixture.editing.renderRequests).toEqual([]);
      expect(fixture.qa.reports).toEqual([]);
    } finally {
      await fixture.cleanup();
    }
  });

  it.each([1, 2, 5])(
    "never renders, checks or corrects more than the pass limit allows (%i)",
    async (limit) => {
      const fixture = await createRuntimeFixture();
      try {
        const chatId = await qaChat(fixture, quality(limit));
        // The issue never goes away, and every correction does change the project.
        fixture.qa.checkResults = [cleanCheck({ issues: [BLACK_SUBJECT] })];
        const director = directorScript(fixture);
        script(fixture, { director: director.run, vision: visionScript([]) });

        await fixture.turns.start(chatId, { prompt: "Fix the intro" });
        await settled(fixture, chatId);

        expect(fixture.editing.renderRequests).toHaveLength(limit);
        expect(fixture.qa.checkRequests).toHaveLength(limit);
        expect(fixture.qa.reports).toHaveLength(limit);
        expect(director.seen.corrections).toHaveLength(limit - 1);
        expect(director.seen.finals).toHaveLength(1);
        expect(fixture.backend.sessionsOf("vision")[0]?.prompts).toHaveLength(limit);
        const qa = fixture.chats.get(chatId)?.turns[0]?.qa;
        expect(qa).toMatchObject({
          status: "issues_remain",
          passLimit: limit,
          reason: "The pass limit was reached.",
        });
        expect(qa?.passes).toHaveLength(limit);
        expect(director.seen.finals[0]).toContain(`after ${limit} of ${limit}`);
        // Each later pass sees the same issue still there.
        expect(fixture.qa.reports.slice(1).map((report) => report.issues[0]?.status)).toEqual(
          Array(limit - 1).fill("persisting"),
        );
      } finally {
        await fixture.cleanup();
      }
    },
  );

  it("compares passes: fixed, persisting, reappeared and new-after-correction issues, and tells the Director", async () => {
    const fixture = await createRuntimeFixture();
    try {
      const chatId = await qaChat(fixture, quality(4));
      fixture.qa.checkResults = [
        cleanCheck({ issues: [BLACK_SUBJECT, AWKWARD] }), // pass 1
        cleanCheck({ issues: [AWKWARD, MISSING] }), // pass 2: black fixed, missing new (a regression)
        cleanCheck({ issues: [BLACK_SUBJECT, MISSING] }), // pass 3: black reappeared, awkward fixed
        cleanCheck({ issues: [BLACK_SUBJECT, MISSING] }), // pass 4: both persist
      ];
      const director = directorScript(fixture);
      script(fixture, { director: director.run, vision: visionScript([]) });

      await fixture.turns.start(chatId, { prompt: "Polish the edit" });
      await settled(fixture, chatId);

      const view = (index: number) => {
        const report = fixture.qa.reports[index];
        return {
          open: report?.issues.map((i) => `${i.id}:${i.status}:${i.firstSeenPass}`),
          fixed: report?.resolved.map((i) => `${i.id}:${i.status}`),
        };
      };
      expect(view(0)).toEqual({ open: ["p1-1:new:1", "p1-2:new:1"], fixed: [] });
      expect(view(1)).toEqual({ open: ["p1-2:persisting:1", "p2-1:new:2"], fixed: ["p1-1:fixed"] });
      expect(view(2)).toEqual({
        open: ["p1-1:reappeared:1", "p2-1:persisting:2"],
        fixed: ["p1-2:fixed"],
      });
      expect(view(3)).toEqual({ open: ["p1-1:persisting:1", "p2-1:persisting:2"], fixed: [] });
      expect(fixture.qa.reports.map((report) => report.counts)).toMatchObject([
        { issues: 2, new: 2, persisting: 0, fixed: 0 },
        { issues: 2, new: 1, persisting: 1, reappeared: 0, fixed: 1 },
        { issues: 2, new: 0, persisting: 1, reappeared: 1, fixed: 1 },
        { issues: 2, new: 0, persisting: 2, reappeared: 0, fixed: 0 },
      ]);

      const [afterOne, afterTwo, afterThree] = director.seen.corrections;
      expect(afterOne).toContain("[p1-1]");
      expect(afterOne).not.toContain("NEW after the last correction");
      // Pass 2: the correction fixed p1-1, left p1-2 and broke something else.
      expect(afterTwo).toContain(
        "fixed: p1-1; still present: p1-2; reappeared: none; new after your last correction: p2-1",
      );
      expect(afterTwo).toContain("a regression your correction caused");
      expect(afterTwo).toContain("(NEW after the last correction)");
      expect(afterTwo).toContain("(still present since pass 1)");
      // Pass 3: p1-1 is back.
      expect(afterThree).toContain("reappeared: p1-1");
      expect(afterThree).toContain("(REAPPEARED: fixed earlier, back now)");

      // The final prompt names what QA fixed for good (p1-2) and what is still open.
      const final = director.seen.finals[0] ?? "";
      expect(final).toContain("Fixed during QA (1):\n- [p1-2]");
      expect(final).toContain("Still open (2):");
      expect(final).toContain("[p1-1]");
      expect(final).toContain("[p2-1]");
    } finally {
      await fixture.cleanup();
    }
  });

  it("groups open issues by owner for the Director and lists what no edit can fix separately", async () => {
    const fixture = await createRuntimeFixture();
    try {
      const chatId = await qaChat(fixture, quality(2), ["editor", "vision", "motion"]);
      fixture.qa.checkResults = [
        cleanCheck({
          issues: [
            BLACK,
            qaDraft({
              kind: "caption_collision",
              source: "layout",
              check: "layout.overlap",
              owner: "motion",
              subject: ".caption",
              start: 6,
              end: 6.5,
              clipIds: [],
              message: "Caption overlaps the lower third.",
              suggestion: "Move the caption up.",
            }),
            qaDraft({
              kind: "black_frames",
              severity: "info",
              subject: null,
              start: 11.5,
              end: 12,
              fixable: false,
              owner: null,
              message: "A fade-out at the very end.",
              suggestion: null,
            }),
          ],
        }),
        cleanCheck(),
      ];
      const director = directorScript(fixture);
      script(fixture, { director: director.run, vision: visionScript([]) });
      await fixture.turns.start(chatId, { prompt: "Add a lower third" });
      await settled(fixture, chatId);

      const correction = director.seen.corrections[0] ?? "";
      expect(correction).toMatch(/Editor:\n- \[p1-1\] error · black_frames · 4\.0–5\.0 s/);
      expect(correction).toMatch(
        /Motion Designer:\n- \[p1-2\] error · caption_collision · 6\.0–6\.5 s/,
      );
      expect(correction).toContain("Open issues that cannot be fixed by an edit");
      expect(correction).toContain("A fade-out at the very end.");
      expect(correction).toContain("Do NOT render");
      expect(correction).toContain("the final report comes after QA");
    } finally {
      await fixture.cleanup();
    }
  });

  it("stops when a correction changes nothing, instead of rendering the same project again", async () => {
    const fixture = await createRuntimeFixture();
    try {
      const chatId = await qaChat(fixture, quality(3));
      fixture.qa.checkResults = [cleanCheck({ issues: [BLACK_SUBJECT] })];
      const director = directorScript(fixture, { correction: async () => undefined });
      script(fixture, { director: director.run, vision: visionScript([]) });
      await fixture.turns.start(chatId, { prompt: "Fix the intro" });
      await settled(fixture, chatId);

      expect(fixture.editing.renderRequests).toHaveLength(1);
      expect(fixture.qa.checkRequests).toHaveLength(1);
      expect(director.seen.corrections).toHaveLength(1);
      expect(fixture.chats.get(chatId)?.turns[0]?.qa).toMatchObject({
        status: "issues_remain",
        reason: expect.stringContaining("changed nothing"),
        passes: [{ pass: 1, phase: "corrected" }],
      });
      expect(director.seen.finals[0]).toContain("changed nothing");
    } finally {
      await fixture.cleanup();
    }
  });

  it("asks for a correction whose issues persist after a real change, then ends with the pass limit", async () => {
    const fixture = await createRuntimeFixture();
    try {
      const chatId = await qaChat(fixture, quality(2));
      fixture.qa.checkResults = [cleanCheck({ issues: [AWKWARD] })];
      const director = directorScript(fixture);
      script(fixture, { director: director.run, vision: visionScript([]) });
      await fixture.turns.start(chatId, { prompt: "Fix the flash clip" });
      await settled(fixture, chatId);
      expect(fixture.qa.reports.map((report) => report.issues[0]?.status)).toEqual([
        "new",
        "persisting",
      ]);
      expect(director.seen.finals[0]).toContain("Still open (1)");
      expect(phasesOf(fixture, chatId)).toEqual(["corrected", "done"]);
    } finally {
      await fixture.cleanup();
    }
  });

  it.each([1, 2, 5])(
    "never goes beyond a pass limit of %i: that many renders and checks, one correction fewer",
    async (limit) => {
      const fixture = await createRuntimeFixture();
      try {
        const chatId = await qaChat(fixture, quality(limit));
        // The issue survives every correction, while each correction really changes the project.
        fixture.qa.checkResults = [cleanCheck({ issues: [AWKWARD] })];
        const director = directorScript(fixture);
        script(fixture, { director: director.run, vision: visionScript([]) });
        await fixture.turns.start(chatId, { prompt: "Fix the flash clip" });
        await settled(fixture, chatId);

        expect(fixture.editing.renderRequests).toHaveLength(limit);
        expect(fixture.qa.checkRequests).toHaveLength(limit);
        expect(fixture.qa.reports.map((report) => report.pass)).toEqual(
          Array.from({ length: limit }, (_, index) => index + 1),
        );
        expect(director.seen.corrections).toHaveLength(limit - 1);
        expect(director.seen.finals).toHaveLength(1);
        expect(fixture.chats.get(chatId)?.turns[0]?.qa).toMatchObject({
          status: "issues_remain",
          passLimit: limit,
          reason: "The pass limit was reached.",
        });
      } finally {
        await fixture.cleanup();
      }
    },
  );

  it("delegates the correction to the owners and waits for them like any other delegated work", async () => {
    const fixture = await createRuntimeFixture();
    try {
      const chatId = await qaChat(fixture, quality(2));
      fixture.qa.checkResults = [cleanCheck({ issues: [BLACK_SUBJECT] }), cleanCheck()];
      let editorTask = "";
      const director = directorScript(fixture, {
        correction: async (_number, session, text) => {
          expect(text).toContain("Delegate each group to its owner");
          await session.callTool("delegate", {
            agent: "editor",
            title: "Fix the black gap",
            task: "Close the gap at 4–5 s (clip c2).",
          });
          await session.callTool("wait_for_agents", {});
        },
      });
      script(fixture, {
        director: director.run,
        vision: visionScript([]),
        editor: async (input) => {
          editorTask = input.text;
          fixture.qa.fingerprint = "fp-editor";
          return "completed";
        },
      });
      await fixture.turns.start(chatId, { prompt: "Tighten the intro" });
      await settled(fixture, chatId);

      expect(editorTask).toContain("Close the gap at 4–5 s");
      expect(fixture.qa.reports[1]?.fingerprint).toBe("fp-editor");
      expect(fixture.chats.get(chatId)?.turns[0]?.qa?.status).toBe("passed");
      // The Director heard back from the Editor inside the correction: no extra follow-up prompt.
      expect(fixture.backend.sessionsOf("director")[0]?.prompts).toHaveLength(3);
    } finally {
      await fixture.cleanup();
    }
  });

  describe("render failures", () => {
    it("stores a failed render as a report with a render_failed issue, asks for a correction and verifies it", async () => {
      const fixture = await createRuntimeFixture();
      try {
        const chatId = await qaChat(fixture, quality(2));
        fixture.editing.renderQueue = [
          new EditingError("render_failed", "clip hf-9 has no readable media"),
        ];
        const director = directorScript(fixture);
        script(fixture, { director: director.run, vision: visionScript([]) });
        await fixture.turns.start(chatId, { prompt: "Add B-roll" });
        await settled(fixture, chatId);

        const [failed, ok] = fixture.qa.reports;
        expect(failed).toMatchObject({
          pass: 1,
          render: null,
          renderError: "clip hf-9 has no readable media",
          checks: [{ id: "render", status: "failed", detail: "clip hf-9 has no readable media" }],
          vision: { status: "skipped" },
          issues: [{ kind: "render_failed", severity: "error", fixable: true, owner: "editor" }],
        });
        expect(ok).toMatchObject({
          pass: 2,
          renderError: null,
          issues: [],
          resolved: [{ kind: "render_failed", status: "fixed" }],
        });
        // Nothing to check or review in the failed pass.
        expect(fixture.qa.checkRequests).toHaveLength(1);
        expect(fixture.backend.sessionsOf("vision")[0]?.prompts).toHaveLength(1);
        expect(director.seen.corrections[0]).toContain(
          "Render QA could not render the composition in pass 1 of 2: clip hf-9 has no readable media",
        );
        expect(fixture.chats.get(chatId)?.turns[0]?.qa).toMatchObject({
          status: "passed",
          passes: [
            {
              pass: 1,
              phase: "corrected",
              error: "clip hf-9 has no readable media",
              renderPath: null,
            },
            { pass: 2, phase: "done" },
          ],
        });
      } finally {
        await fixture.cleanup();
      }
    });

    it("fails QA when the render fails on the last pass", async () => {
      const fixture = await createRuntimeFixture();
      try {
        const chatId = await qaChat(fixture, quality(2));
        fixture.editing.renderQueue = [
          new EditingError("render_failed", "first failure"),
          new EditingError("render_failed", "second failure"),
        ];
        const director = directorScript(fixture);
        script(fixture, { director: director.run, vision: visionScript([]) });
        await fixture.turns.start(chatId, { prompt: "Add B-roll" });
        await settled(fixture, chatId);

        expect(fixture.qa.reports.map((report) => report.renderError)).toEqual([
          "first failure",
          "second failure",
        ]);
        expect(fixture.qa.reports[1]?.issues[0]).toMatchObject({
          kind: "render_failed",
          status: "persisting",
          id: "p1-1",
        });
        expect(director.seen.corrections).toHaveLength(1);
        expect(fixture.chats.get(chatId)?.turns[0]?.qa).toMatchObject({
          status: "failed",
          reason: "The render failed: second failure",
          passes: [{ phase: "corrected" }, { phase: "failed", error: "second failure" }],
        });
        expect(director.seen.finals[0]).toContain('outcome="failed"');
        expect(director.seen.finals[0]).toContain("There is no render of the current project");
        expect(fixture.chats.get(chatId)?.turns[0]?.status).toBe("completed");
      } finally {
        await fixture.cleanup();
      }
    });

    it("fails QA on a single-pass budget when the render fails, without a correction", async () => {
      const fixture = await createRuntimeFixture();
      try {
        const chatId = await qaChat(fixture, quality(1));
        fixture.editing.renderQueue = [new EditingError("render_failed", "boom")];
        const director = directorScript(fixture);
        script(fixture, { director: director.run, vision: visionScript([]) });
        await fixture.turns.start(chatId, { prompt: "Add B-roll" });
        await settled(fixture, chatId);
        expect(director.seen.corrections).toEqual([]);
        expect(fixture.chats.get(chatId)?.turns[0]?.qa).toMatchObject({
          status: "failed",
          passes: [{ pass: 1, phase: "failed", error: "boom" }],
        });
      } finally {
        await fixture.cleanup();
      }
    });

    it("fails QA when the checks themselves cannot run, without storing a report", async () => {
      const fixture = await createRuntimeFixture();
      try {
        const chatId = await qaChat(fixture, quality(2));
        fixture.qa.checkResults = [new QaToolError("studio_unavailable", "Studio is restarting")];
        const director = directorScript(fixture);
        script(fixture, { director: director.run, vision: visionScript([]) });
        await fixture.turns.start(chatId, { prompt: "Add B-roll" });
        await settled(fixture, chatId);
        expect(fixture.qa.reports).toEqual([]);
        expect(fixture.chats.get(chatId)?.turns[0]?.qa).toMatchObject({
          status: "failed",
          reason: expect.stringContaining("Studio is restarting"),
          passes: [{ pass: 1, phase: "failed" }],
        });
        expect(director.seen.corrections).toEqual([]);
        expect(director.seen.finals).toHaveLength(1);
      } finally {
        await fixture.cleanup();
      }
    });
  });

  describe("when Vision cannot review", () => {
    it("is not enabled: the Director reviews the render itself and the correction follows from its findings", async () => {
      const fixture = await createRuntimeFixture();
      try {
        const chatId = await qaChat(fixture, quality(2), ["editor"]);
        fixture.qa.checkResults = [cleanCheck(), cleanCheck()];
        const director = directorScript(fixture, {
          review: async (number, session) => {
            await session.callTool("inspect_render", { times: [1, 5] });
            await session.callTool("report_render_findings", {
              findings: number === 1 ? [finding({ subject: "c2" })] : [],
            });
          },
        });
        script(fixture, { director: director.run });
        await fixture.turns.start(chatId, { prompt: "Tighten the intro" });
        await settled(fixture, chatId);

        // No Vision run: the review prompt went to the Director, with the tools opened for it.
        expect(fixture.backend.sessionsOf("vision")).toEqual([]);
        expect(director.seen.reviews).toHaveLength(2);
        expect(director.seen.reviews[0]).toContain(
          "Vision is off in this chat, so you do its work yourself",
        );
        expect(director.seen.reviews[0]).toContain("inspect_render");
        expect(fixture.qa.frameRequests.map((request) => request.times)).toEqual([
          [1, 5],
          [1, 5],
        ]);
        expect(fixture.qa.reports[0]?.vision).toMatchObject({
          status: "ran",
          reviewer: "director",
          frames: 2,
          rounds: 1,
          model: null,
        });
        expect(fixture.qa.reports[0]?.issues).toMatchObject([
          { source: "vision", kind: "incorrect_broll", fixable: true },
        ]);
        expect(fixture.qa.reports[0]?.checks.at(-1)).toMatchObject({ id: "vision", status: "ran" });
        // The Director's own findings drive the correction, and the second review finds it fixed.
        expect(director.seen.corrections).toHaveLength(1);
        expect(director.seen.corrections[0]).toContain("You (Vision is off) reviewed 2 frames");
        expect(fixture.qa.reports[1]?.resolved.map((issue) => issue.id)).toEqual(["p1-1"]);
        expect(fixture.chats.get(chatId)?.turns[0]?.qa).toMatchObject({
          status: "passed",
          passes: [{ vision: "ran" }, { vision: "ran" }],
        });
      } finally {
        await fixture.cleanup();
      }
    });

    it("refuses everything but the review tools while the Director reviews, and the tools outside the review", async () => {
      const fixture = await createRuntimeFixture();
      try {
        const chatId = await qaChat(fixture, quality(1), ["editor"]);
        fixture.qa.checkResults = [cleanCheck()];
        const refused: Array<{ isError?: boolean; text: string }> = [];
        const director = directorScript(fixture, {
          first: async (session) => {
            fixture.qa.bump();
            refused.push(await session.callTool("inspect_render", { times: [1] }));
          },
          review: async (_number, session) => {
            refused.push(
              await session.callTool("delegate", { agent: "editor", title: "Fix", task: "Fix it" }),
            );
            refused.push(await session.callTool("render_video", {}));
            await session.callTool("inspect_render", { times: [1] });
            await session.callTool("report_render_findings", { findings: [] });
          },
        });
        script(fixture, { director: director.run });
        await fixture.turns.start(chatId, { prompt: "Tighten the intro" });
        await settled(fixture, chatId);

        expect(refused[0]?.text).toContain("works only during a Render QA review");
        expect(refused[1]?.text).toContain("refused during a Render QA review");
        expect(refused[2]?.text).toContain("refused during a Render QA review");
        expect(fixture.editing.applyRequests).toEqual([]);
      } finally {
        await fixture.cleanup();
      }
    });

    it("failed: the run error is recorded and the deterministic issues still drive the correction", async () => {
      const fixture = await createRuntimeFixture();
      try {
        const chatId = await qaChat(fixture, quality(2));
        fixture.qa.checkResults = [cleanCheck({ issues: [BLACK_SUBJECT] }), cleanCheck()];
        const director = directorScript(fixture);
        script(fixture, {
          director: director.run,
          vision: async () => {
            throw new Error("model exploded");
          },
        });
        await fixture.turns.start(chatId, { prompt: "Tighten the intro" });
        await settled(fixture, chatId);

        expect(fixture.qa.reports[0]?.vision).toMatchObject({
          status: "failed",
          reason: "Vision's run failed (model exploded).",
        });
        expect(fixture.qa.reports[0]?.issues).toHaveLength(1);
        expect(director.seen.corrections).toHaveLength(1);
        expect(fixture.chats.get(chatId)?.turns[0]?.status).toBe("completed");
        const visionRuns = fixture.chats.get(chatId)?.runs.filter((run) => run.agent === "vision");
        expect(visionRuns?.map((run) => run.status)).toEqual(["failed", "failed"]);
      } finally {
        await fixture.cleanup();
      }
    });

    it("finishes without reporting findings: its review does not count", async () => {
      const fixture = await createRuntimeFixture();
      try {
        const chatId = await qaChat(fixture, quality(1));
        fixture.qa.checkResults = [cleanCheck({ issues: [BLACK_SUBJECT] })];
        const director = directorScript(fixture);
        script(fixture, { director: director.run, vision: visionScript(null) });
        await fixture.turns.start(chatId, { prompt: "Tighten the intro" });
        await settled(fixture, chatId);
        expect(fixture.qa.reports[0]?.vision).toMatchObject({
          status: "failed",
          reason: "Vision finished without reporting any findings, so its review did not count.",
          frames: 2,
          rounds: 1,
        });
        expect(director.seen.finals[0]).toContain("The visual review did not happen (failed");
      } finally {
        await fixture.cleanup();
      }
    });

    it("keeps a Vision issue open when the re-check could not run, instead of marking it fixed and passing QA", async () => {
      const fixture = await createRuntimeFixture();
      try {
        const chatId = await qaChat(fixture, quality(2));
        fixture.qa.checkResults = [cleanCheck(), cleanCheck()];
        const director = directorScript(fixture);
        const first = visionScript([finding()]);
        let calls = 0;
        script(fixture, {
          director: director.run,
          vision: async (input, session) => {
            calls += 1;
            if (calls === 1) return first(input, session);
            throw new Error("provider 529 overloaded");
          },
        });
        await fixture.turns.start(chatId, { prompt: "Tighten the intro" });
        await settled(fixture, chatId);

        expect(fixture.qa.reports).toHaveLength(2);
        const second = fixture.qa.reports[1];
        expect(second?.vision.status).toBe("failed");
        expect(second?.resolved).toEqual([]);
        expect(
          second?.issues.map((issue) => `${issue.id}:${issue.status}:${issue.source}`),
        ).toEqual(["p1-1:persisting:vision"]);
        // Carried over as report-only: not fixable, so it never goes back to a correction.
        expect(second?.issues[0]).toMatchObject({ notRechecked: true, fixable: false });
        expect(second?.counts).toMatchObject({ issues: 1, persisting: 1, fixable: 0, fixed: 0 });
        expect(director.seen.corrections).toHaveLength(1);
        expect(fixture.chats.get(chatId)?.turns[0]?.qa).toMatchObject({
          status: "issues_remain",
          reasonCode: "not_rechecked",
        });
        const final = director.seen.finals[0] ?? "";
        expect(final).toContain("NOT re-checked in the last pass (1)");
        expect(final).not.toContain("Still open");
        expect(final).not.toContain("Fixed during QA");
      } finally {
        await fixture.cleanup();
      }
    });

    it("still records a Vision issue as fixed when the re-check ran and no longer reports it", async () => {
      const fixture = await createRuntimeFixture();
      try {
        const chatId = await qaChat(fixture, quality(2));
        fixture.qa.checkResults = [cleanCheck(), cleanCheck()];
        const director = directorScript(fixture);
        const first = visionScript([finding()]);
        const second = visionScript([]);
        let calls = 0;
        script(fixture, {
          director: director.run,
          vision: (input, session) => {
            calls += 1;
            return calls === 1 ? first(input, session) : second(input, session);
          },
        });
        await fixture.turns.start(chatId, { prompt: "Tighten the intro" });
        await settled(fixture, chatId);

        expect(fixture.qa.reports[1]?.resolved.map((issue) => issue.id)).toEqual(["p1-1"]);
        expect(fixture.chats.get(chatId)?.turns[0]?.qa?.status).toBe("passed");
      } finally {
        await fixture.cleanup();
      }
    });

    it("caps the merged issues at the report limit so the report can be stored, keeping the most severe", async () => {
      const fixture = await createRuntimeFixture();
      try {
        const chatId = await qaChat(fixture, quality(1));
        const flashes = Array.from({ length: QA_LIMITS.issues }, (_, index) =>
          qaDraft({
            kind: "awkward_cut",
            severity: "warning",
            check: "timeline.flash_clip",
            source: "timeline",
            start: index * 3,
            end: index * 3 + 0.2,
            clipIds: [`f${index}`],
            subject: `f${index}`,
            message: `A flash clip ${index}.`,
          }),
        );
        fixture.qa.checkResults = [cleanCheck({ issues: flashes })];
        const director = directorScript(fixture);
        script(fixture, {
          director: director.run,
          vision: visionScript([
            finding({ severity: "error" }),
            finding({ kind: "visual_mismatch", subject: "c3", severity: "warning" }),
          ]),
        });
        await fixture.turns.start(chatId, { prompt: "Tighten the intro" });
        await settled(fixture, chatId);

        const issues = fixture.qa.reports[0]?.issues ?? [];
        expect(issues).toHaveLength(QA_LIMITS.issues);
        expect(
          issues.some((issue) => issue.source === "vision" && issue.severity === "error"),
        ).toBe(true);
        expect(fixture.chats.get(chatId)?.turns[0]?.qa?.passes[0]?.phase).not.toBe("failed");
      } finally {
        await fixture.cleanup();
      }
    });

    it("merges Vision's findings with the deterministic ones, dropping duplicates of the same problem", async () => {
      const fixture = await createRuntimeFixture();
      try {
        const chatId = await qaChat(fixture, quality(1));
        fixture.qa.checkResults = [cleanCheck({ issues: [BLACK_SUBJECT] })];
        const director = directorScript(fixture);
        script(fixture, {
          director: director.run,
          vision: visionScript([
            finding(),
            // The same black frames the checks already found (same kind and subject).
            finding({ kind: "black_frames", subject: "c2", start: 4, end: 5, message: "Black." }),
          ]),
        });
        await fixture.turns.start(chatId, { prompt: "Tighten the intro" });
        await settled(fixture, chatId);
        const issues = fixture.qa.reports[0]?.issues ?? [];
        expect(issues.map((issue) => [issue.kind, issue.source, issue.check])).toEqual([
          ["black_frames", "render", "blackdetect"],
          ["incorrect_broll", "vision", "vision"],
        ]);
        expect(fixture.qa.reports[0]?.vision.status).toBe("ran");
      } finally {
        await fixture.cleanup();
      }
    });
  });

  describe("aborting", () => {
    it("during the render: no check, no report, the turn is aborted and the render cancelled", async () => {
      const fixture = await createRuntimeFixture();
      try {
        const chatId = await qaChat(fixture, quality(2));
        fixture.editing.renderGate = new Promise<void>(() => {});
        const director = directorScript(fixture);
        script(fixture, { director: director.run, vision: visionScript([]) });
        const turn = await fixture.turns.start(chatId, { prompt: "Tighten the intro" });
        await waitUntil(() => fixture.editing.renderRequests.length === 1, "the QA render");
        fixture.turns.abort(chatId, turn.id);
        await settled(fixture, chatId);

        expect(fixture.editing.renderCancelled).toBe(true);
        expect(fixture.qa.checkRequests).toEqual([]);
        expect(fixture.qa.reports).toEqual([]);
        expect(director.seen.finals).toEqual([]);
        expect(fixture.chats.get(chatId)?.turns[0]).toMatchObject({
          status: "aborted",
          qa: { status: "aborted", passes: [{ pass: 1, phase: "aborted" }] },
        });
        expect(fixture.checkpoints.windows[0]?.ended).toBe(true);
      } finally {
        await fixture.cleanup();
      }
    });

    it("during the checks: the check is cancelled, nothing is stored, and the checkpoint closes only afterwards", async () => {
      const fixture = await createRuntimeFixture();
      try {
        const chatId = await qaChat(fixture, quality(2));
        fixture.qa.checkGate = new Promise<void>(() => {});
        // The service takes a while to honour the cancellation.
        let finishCancel = () => {};
        fixture.qa.cancelDelay = new Promise<void>((resolve) => {
          finishCancel = resolve;
        });
        const director = directorScript(fixture);
        script(fixture, { director: director.run, vision: visionScript([]) });
        const turn = await fixture.turns.start(chatId, { prompt: "Tighten the intro" });
        await waitUntil(() => fixture.qa.checkRequests.length === 1, "the QA check");
        fixture.turns.abort(chatId, turn.id);
        await waitUntil(() => fixture.qa.checkCancelled === 1, "the check to be cancelled");

        // QA work is part of the turn: the checkpoint stays open until it has stopped.
        for (let turns = 0; turns < 10; turns += 1)
          await new Promise((resolve) => setImmediate(resolve));
        expect(fixture.chats.get(chatId)?.turns[0]?.status).toBe("running");
        expect(fixture.checkpoints.windows[0]?.ended).toBe(false);

        finishCancel();
        await settled(fixture, chatId);
        expect(fixture.checkpoints.windows[0]?.ended).toBe(true);
        expect(fixture.qa.reports).toEqual([]);
        expect(fixture.qa.checkSignals[0]?.aborted).toBe(true);
        expect(fixture.backend.sessionsOf("vision")).toEqual([]);
        expect(fixture.chats.get(chatId)?.turns[0]).toMatchObject({
          status: "aborted",
          qa: { status: "aborted", passes: [{ pass: 1, phase: "aborted" }] },
        });
      } finally {
        await fixture.cleanup();
      }
    });

    it("during Vision's review: the run is aborted, no report is stored for the pass", async () => {
      const fixture = await createRuntimeFixture();
      try {
        const chatId = await qaChat(fixture, quality(2));
        const director = directorScript(fixture);
        script(fixture, {
          director: director.run,
          vision: async (input, session) => {
            await session.callTool("inspect_render", { times: [1] });
            await untilAborted(input.signal);
            return "aborted";
          },
        });
        const turn = await fixture.turns.start(chatId, { prompt: "Tighten the intro" });
        await waitUntil(() => fixture.qa.frameRequests.length === 1, "Vision's first look");
        fixture.turns.abort(chatId, turn.id);
        await settled(fixture, chatId);

        expect(fixture.qa.reports).toEqual([]);
        expect(director.seen.finals).toEqual([]);
        expect(fixture.chats.get(chatId)?.runs.map((run) => run.status)).toEqual(["aborted"]);
        expect(fixture.chats.get(chatId)?.turns[0]).toMatchObject({
          status: "aborted",
          qa: { status: "aborted", passes: [{ pass: 1, phase: "aborted" }] },
        });
        expect(fixture.checkpoints.windows[0]?.ended).toBe(true);
      } finally {
        await fixture.cleanup();
      }
    });

    it("during a correction: the pass that was reported stays reported, the turn is aborted", async () => {
      const fixture = await createRuntimeFixture();
      try {
        const chatId = await qaChat(fixture, quality(3));
        fixture.qa.checkResults = [cleanCheck({ issues: [BLACK_SUBJECT] })];
        let turnId = "";
        const director = directorScript(fixture, {
          correction: async () => {
            fixture.turns.abort(chatId, turnId);
          },
        });
        script(fixture, { director: director.run, vision: visionScript([]) });
        const turn = await fixture.turns.start(chatId, { prompt: "Tighten the intro" });
        turnId = turn.id;
        await settled(fixture, chatId);
        expect(fixture.qa.reports).toHaveLength(1);
        expect(fixture.chats.get(chatId)?.turns[0]).toMatchObject({
          status: "aborted",
          qa: {
            status: "aborted",
            passes: [{ pass: 1, phase: "aborted", reportId: "qa-report-1" }],
          },
        });
        expect(fixture.editing.renderRequests).toHaveLength(1);
      } finally {
        await fixture.cleanup();
      }
    });
  });

  describe("tools refused by phase", () => {
    it("refuses render_video during a correction and everything that changes the project in the final report", async () => {
      const fixture = await createRuntimeFixture();
      try {
        // No Editor: the Director itself holds edit_timeline, build_rough_cut and render_video, and can delegate.
        const chatId = await qaChat(fixture, quality(2), ["vision"]);
        fixture.qa.checkResults = [cleanCheck({ issues: [BLACK_SUBJECT] }), cleanCheck()];
        const edit = { operations: [{ op: "set_composition", duration: 5 }] };
        const during: string[] = [];
        const after: string[] = [];
        const director = directorScript(fixture, {
          correction: async (_number, session) => {
            const render = await session.callTool("render_video", {});
            during.push(render.isError ? render.text : "rendered");
            const change = await session.callTool("edit_timeline", edit);
            during.push(change.isError ? change.text : "edited");
            fixture.qa.fingerprint = "fp-corrected";
          },
          final: async (session) => {
            for (const [name, args] of [
              ["edit_timeline", edit],
              ["render_video", {}],
              ["build_rough_cut", { plan: "cut-1" }],
              ["delegate", { agent: "vision", title: "x", task: "x" }],
            ] as const) {
              const result = await session.callTool(name, args);
              after.push(result.isError ? result.text : "allowed");
            }
            const read = await session.callTool("inspect_timeline", {});
            after.push(read.isError ? read.text : "read");
          },
        });
        script(fixture, { director: director.run, vision: visionScript([]) });
        await fixture.turns.start(chatId, { prompt: "Tighten the intro" });
        await settled(fixture, chatId);

        expect(during[0]).toContain("render_video is refused during a Render QA correction");
        expect(during[1]).toBe("edited");
        expect(fixture.editing.applyRequests).toHaveLength(1);
        expect(after.slice(0, 4).every((text) => text.includes("Render QA is over"))).toBe(true);
        expect(after[4]).toBe("read");
        // Only the two QA renders happened: nothing rendered in the correction or the final report.
        expect(fixture.editing.renderRequests).toHaveLength(2);
        expect(fixture.editing.applyRequests).toHaveLength(1);
        expect(fixture.backend.sessionsOf("vision")[0]?.prompts).toHaveLength(2);
      } finally {
        await fixture.cleanup();
      }
    });
  });

  it("carries steering sent during QA into the next Director prompt", async () => {
    const fixture = await createRuntimeFixture();
    try {
      const chatId = await qaChat(fixture, quality(2));
      fixture.qa.checkResults = [cleanCheck({ issues: [BLACK_SUBJECT] }), cleanCheck()];
      let release = () => {};
      fixture.qa.checkGate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const director = directorScript(fixture);
      script(fixture, { director: director.run, vision: visionScript([]) });
      const turn = await fixture.turns.start(chatId, { prompt: "Tighten the intro" });
      await waitUntil(() => fixture.qa.checkRequests.length === 1, "the QA check");
      await fixture.turns.steer(chatId, turn.id, { text: "Also keep the logo visible" });
      release();
      await settled(fixture, chatId);

      expect(director.seen.corrections[0]).toContain(
        "<user-steering>\nAlso keep the logo visible\n</user-steering>",
      );
      expect(director.seen.finals[0]).not.toContain("Also keep the logo visible");
      // Delivered with the prompt, not injected into a running one.
      expect(fixture.backend.sessionsOf("director")[0]?.steering).toEqual([]);
    } finally {
      await fixture.cleanup();
    }
  });

  describe("which turns are checked", () => {
    it("checks a composition over three minutes on the timeline alone, unless the user asked for a render", async () => {
      const fixture = await createRuntimeFixture();
      try {
        fixture.editing.timelineResult = {
          ...fixture.editing.timelineResult,
          composition: { path: "index.html", width: 1920, height: 1080, duration: 400 },
        };
        const chatId = await qaChat(fixture, quality(2));
        const director = directorScript(fixture);
        script(fixture, { director: director.run });
        await fixture.turns.start(chatId, { prompt: "Tighten the talk" });
        await settled(fixture, chatId);
        expect(fixture.editing.renderRequests).toEqual([]);
        expect(fixture.qa.checkRequests).toEqual([]);
        expect(fixture.qa.timelineCheckRequests).toEqual([{ composition: "index.html" }]);
        expect(fixture.chats.get(chatId)?.turns[0]?.qa).toMatchObject({
          status: "passed",
          scope: "timeline",
          passes: [
            {
              scope: "timeline",
              scopeNote: {
                code: "too_long",
                message: expect.stringContaining(
                  "6.7 minutes long and the user did not ask for a render",
                ),
              },
              renderPath: null,
              vision: "skipped",
            },
          ],
        });
        expect(fixture.qa.reports[0]).toMatchObject({
          scope: "timeline",
          render: null,
          renderError: null,
          vision: { status: "skipped", reasonCode: "vision_timeline_only" },
        });
        expect(director.seen.finals).toHaveLength(1);
        // Asked for a render: QA runs, and its render is the deliverable (standard quality, not a draft).
        fixture.qa.fingerprint = "fp-before-second-turn";
        const asked = await qaChat(fixture, quality(1));
        const askedDirector = directorScript(fixture);
        script(fixture, { director: askedDirector.run, vision: visionScript([]) });
        await fixture.turns.start(asked, { prompt: "Tighten the talk and render it" });
        await settled(fixture, asked);
        expect(fixture.editing.renderRequests).toEqual([{ quality: "standard" }]);
        expect(fixture.chats.get(asked)?.turns[0]?.qa?.status).toBe("passed");
      } finally {
        await fixture.cleanup();
      }
    });

    it("reuses the Director's own render when nothing changed after it started, and renders again after a correction", async () => {
      const fixture = await createRuntimeFixture();
      try {
        const chatId = await qaChat(fixture, quality(2));
        fixture.qa.checkResults = [cleanCheck({ issues: [BLACK_SUBJECT] }), cleanCheck()];
        const director = directorScript(fixture, {
          first: async (session) => {
            fixture.qa.fingerprint = "fp-edited";
            await session.callTool("render_video", { quality: "high" });
          },
        });
        script(fixture, { director: director.run, vision: visionScript([]) });
        await fixture.turns.start(chatId, { prompt: "Tighten the intro" });
        await settled(fixture, chatId);

        // One render by the Director (high), one after the correction in the same quality (it replaces the
        // deliverable); pass 1 reused the first.
        expect(fixture.editing.renderRequests).toEqual([{ quality: "high" }, { quality: "high" }]);
        expect(fixture.qa.checkRequests.map((request) => request.render)).toEqual([
          "renders/final.mp4",
          "renders/final.mp4",
        ]);
        expect(fixture.qa.reports[0]).toMatchObject({
          fingerprint: "fp-edited",
          render: { quality: "high" },
        });
      } finally {
        await fixture.cleanup();
      }
    });

    it("renders again when the project changed after the Director's render started", async () => {
      const fixture = await createRuntimeFixture();
      try {
        const chatId = await qaChat(fixture, quality(1));
        const director = directorScript(fixture, {
          first: async (session) => {
            fixture.qa.fingerprint = "fp-a";
            await session.callTool("render_video", {});
            fixture.qa.fingerprint = "fp-b";
          },
        });
        script(fixture, { director: director.run, vision: visionScript([]) });
        await fixture.turns.start(chatId, { prompt: "Tighten the intro" });
        await settled(fixture, chatId);
        expect(fixture.editing.renderRequests).toEqual([
          { quality: "standard" },
          { quality: "standard" },
        ]);
        expect(fixture.qa.reports[0]?.fingerprint).toBe("fp-b");
      } finally {
        await fixture.cleanup();
      }
    });

    it("checks the render a turn made even when the project itself did not change", async () => {
      const fixture = await createRuntimeFixture();
      try {
        const chatId = await qaChat(fixture, quality(2));
        fixture.qa.checkResults = [cleanCheck({ issues: [BLACK_SUBJECT] }), cleanCheck()];
        const start = fixture.qa.fingerprint;
        const director = directorScript(fixture, {
          // "Render the final video": no edit, only a render of the project as it is (the model names the main
          // composition explicitly, as real Directors do).
          first: async (session) => {
            await session.callTool("render_video", { quality: "high", composition: "index.html" });
          },
        });
        script(fixture, { director: director.run, vision: visionScript([]) });
        await fixture.turns.start(chatId, { prompt: "Render the final video in high quality" });
        await settled(fixture, chatId);

        expect(fixture.qa.reports[0]).toMatchObject({
          fingerprint: start,
          render: { origin: "turn" },
        });
        // The black stretch is corrected and the deliverable re-rendered in the user's quality.
        expect(director.seen.corrections).toHaveLength(1);
        expect(fixture.editing.renderRequests).toEqual([
          { composition: "index.html", quality: "high" },
          { quality: "high" },
        ]);
        expect(fixture.chats.get(chatId)?.turns[0]?.qa?.status).toBe("passed");
      } finally {
        await fixture.cleanup();
      }
    });

    it("stays silent when a turn neither changed nor rendered the project", async () => {
      const fixture = await createRuntimeFixture();
      try {
        const chatId = await qaChat(fixture, quality(2));
        const director = directorScript(fixture, { first: async () => undefined });
        script(fixture, { director: director.run });
        await fixture.turns.start(chatId, { prompt: "What is in my project?" });
        await settled(fixture, chatId);
        expect(fixture.chats.get(chatId)?.turns[0]?.qa).toBeUndefined();
        expect(fixture.editing.renderRequests).toEqual([]);
      } finally {
        await fixture.cleanup();
      }
    });

    it("checks a story build turn and corrects it, but only reports on a rebuild turn", async () => {
      const fixture = await createRuntimeFixture();
      try {
        fixture.qa.checkResults = [cleanCheck({ issues: [BLACK_SUBJECT] })];
        const build = await qaChat(fixture, quality(2));
        const buildDirector = directorScript(fixture);
        script(fixture, { director: buildDirector.run, vision: visionScript([]) });
        await fixture.turns.start(build, { prompt: "Build the story", storyAction: "build" });
        await settled(fixture, build);
        expect(buildDirector.seen.corrections).toHaveLength(1);
        expect(fixture.chats.get(build)?.turns[0]?.qa).toMatchObject({
          status: "issues_remain",
          passes: [{ phase: "corrected" }, { phase: "done" }],
        });

        const rebuild = await qaChat(fixture, quality(2));
        const rebuildDirector = directorScript(fixture);
        script(fixture, { director: rebuildDirector.run, vision: visionScript([]) });
        const rendersBefore = fixture.editing.renderRequests.length;
        await fixture.turns.start(rebuild, { prompt: "Rebuild the story", storyAction: "rebuild" });
        await settled(fixture, rebuild);
        expect(rebuildDirector.seen.corrections).toEqual([]);
        expect(fixture.editing.renderRequests.length - rendersBefore).toBe(1);
        expect(fixture.chats.get(rebuild)?.turns.at(-1)?.qa).toMatchObject({
          status: "issues_remain",
          reason: expect.stringContaining("report-only"),
          passes: [{ phase: "done" }],
        });
        expect(rebuildDirector.seen.finals).toHaveLength(1);
      } finally {
        await fixture.cleanup();
      }
    });

    it("never checks story plan, review or resolve turns, even when the project changed", async () => {
      const fixture = await createRuntimeFixture();
      try {
        for (const storyAction of ["review", "resolve"] as const) {
          const chatId = await qaChat(fixture, quality(2));
          const director = directorScript(fixture);
          script(fixture, { director: director.run });
          await fixture.turns.start(chatId, { prompt: "Work on the story", storyAction });
          await settled(fixture, chatId);
          expect(fixture.chats.get(chatId)?.turns[0]?.qa).toBeUndefined();
        }
        expect(fixture.editing.renderRequests).toEqual([]);
        expect(fixture.qa.reports).toEqual([]);
      } finally {
        await fixture.cleanup();
      }
    });

    it("does not start QA when the Director's turn failed", async () => {
      const fixture = await createRuntimeFixture();
      try {
        const chatId = await qaChat(fixture, quality(2));
        script(fixture, {
          director: async () => {
            fixture.qa.fingerprint = "fp-x";
            throw new Error("backend exploded");
          },
        });
        await fixture.turns.start(chatId, { prompt: "Tighten the intro" });
        await settled(fixture, chatId);
        expect(fixture.chats.get(chatId)?.turns[0]).toMatchObject({ status: "failed" });
        expect(fixture.chats.get(chatId)?.turns[0]?.qa).toBeUndefined();
        expect(fixture.editing.renderRequests).toEqual([]);
      } finally {
        await fixture.cleanup();
      }
    });

    it("records a skipped QA when Studio's QA service cannot say whether the project changed", async () => {
      const fixture = await createRuntimeFixture();
      try {
        fixture.qa.stateError = new QaToolError("studio_unavailable", "no answer");
        const chatId = await qaChat(fixture, quality(2));
        const director = directorScript(fixture);
        script(fixture, { director: director.run });
        await fixture.turns.start(chatId, { prompt: "Tighten the intro" });
        await settled(fixture, chatId);
        expect(fixture.chats.get(chatId)?.turns[0]).toMatchObject({
          status: "completed",
          qa: {
            status: "skipped",
            reason: expect.stringContaining("could not tell whether the project changed"),
          },
        });
        expect(fixture.editing.renderRequests).toEqual([]);
      } finally {
        await fixture.cleanup();
      }
    });
  });
});
