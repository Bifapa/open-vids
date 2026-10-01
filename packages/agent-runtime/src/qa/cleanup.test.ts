import { describe, expect, it } from "vitest";
import type { RenderOutput } from "../editing/host.js";
import { EditingError } from "../editing/host.js";
import { createRuntimeFixture, waitUntil, type RuntimeFixture } from "../testing/runtimeFixture.js";
import { cleanCheck, qaDraft } from "../testing/qa.js";
import { directorScript, qaChat, quality, script, settled, visionScript } from "./harness.js";
import { QaToolError } from "./host.js";

const FIXABLE = qaDraft({ subject: "c2" });

const output = (fixture: RuntimeFixture, name: string): RenderOutput => ({
  ...fixture.editing.renderResult,
  path: `renders/${name}.mp4`,
});

/** A turn whose passes each render to their own file. */
async function runTurn(
  fixture: RuntimeFixture,
  budget: number,
  setup: (chatId: string) => void = () => {},
) {
  const chatId = await qaChat(fixture, quality(budget));
  setup(chatId);
  const director = directorScript(fixture);
  script(fixture, { director: director.run, vision: visionScript([]) });
  const turn = await fixture.turns.start(chatId, { prompt: "Tighten the intro" });
  await settled(fixture, chatId);
  return { chatId, turn, director };
}

describe("QA session cleanup in a turn", () => {
  it("passed: asks the service to keep the last pass's render and delete the rest", async () => {
    const fixture = await createRuntimeFixture();
    try {
      fixture.editing.renderQueue = [output(fixture, "qa-a"), output(fixture, "qa-b")];
      fixture.qa.checkResults = [cleanCheck({ issues: [FIXABLE] }), cleanCheck()];
      const { chatId, turn } = await runTurn(fixture, 2);

      expect(fixture.chats.get(chatId)?.turns[0]?.qa?.status).toBe("passed");
      expect(fixture.qa.reports.map((report) => report.render?.origin)).toEqual(["qa", "qa"]);
      expect(fixture.qa.finishRequests).toEqual([
        {
          sessionId: turn.id,
          request: { keep: "renders/qa-b.mp4", produced: ["renders/qa-a.mp4", "renders/qa-b.mp4"] },
        },
      ]);
    } finally {
      await fixture.cleanup();
    }
  });

  it("issues_remain: the last render stays", async () => {
    const fixture = await createRuntimeFixture();
    try {
      fixture.editing.renderQueue = [output(fixture, "qa-a"), output(fixture, "qa-b")];
      fixture.qa.checkResults = [cleanCheck({ issues: [FIXABLE] })];
      const { chatId, turn } = await runTurn(fixture, 2);

      expect(fixture.chats.get(chatId)?.turns[0]?.qa?.status).toBe("issues_remain");
      expect(fixture.qa.finishRequests).toEqual([
        {
          sessionId: turn.id,
          request: { keep: "renders/qa-b.mp4", produced: ["renders/qa-a.mp4", "renders/qa-b.mp4"] },
        },
      ]);
    } finally {
      await fixture.cleanup();
    }
  });

  it("failed: the last render that succeeded stays, even when the last pass's render failed", async () => {
    const fixture = await createRuntimeFixture();
    try {
      fixture.editing.renderQueue = [
        output(fixture, "qa-a"),
        new EditingError("render_failed", "second failure"),
      ];
      fixture.qa.checkResults = [cleanCheck({ issues: [FIXABLE] })];
      const { chatId, turn } = await runTurn(fixture, 2);

      expect(fixture.chats.get(chatId)?.turns[0]?.qa?.status).toBe("failed");
      expect(fixture.qa.finishRequests).toEqual([
        {
          sessionId: turn.id,
          request: { keep: "renders/qa-a.mp4", produced: ["renders/qa-a.mp4"] },
        },
      ]);
    } finally {
      await fixture.cleanup();
    }
  });

  it("failed: a pass whose checks could not run still leaves its render as the kept one", async () => {
    const fixture = await createRuntimeFixture();
    try {
      fixture.editing.renderQueue = [output(fixture, "qa-a")];
      fixture.qa.checkResults = [new QaToolError("unavailable", "ffmpeg is missing")];
      const { chatId, turn } = await runTurn(fixture, 2);

      expect(fixture.chats.get(chatId)?.turns[0]?.qa?.status).toBe("failed");
      expect(fixture.qa.finishRequests).toEqual([
        {
          sessionId: turn.id,
          request: { keep: "renders/qa-a.mp4", produced: ["renders/qa-a.mp4"] },
        },
      ]);
    } finally {
      await fixture.cleanup();
    }
  });

  it("never lists the Director's own render as QA's: pass 1 reuses it (origin turn) and only later passes are QA's", async () => {
    const fixture = await createRuntimeFixture();
    try {
      fixture.editing.renderQueue = [output(fixture, "mine"), output(fixture, "qa-b")];
      fixture.qa.checkResults = [cleanCheck({ issues: [FIXABLE] }), cleanCheck()];
      const chatId = await qaChat(fixture, quality(2));
      const director = directorScript(fixture, {
        first: async (session) => {
          fixture.qa.fingerprint = "fp-edited";
          await session.callTool("render_video", { quality: "high" });
        },
      });
      script(fixture, { director: director.run, vision: visionScript([]) });
      const turn = await fixture.turns.start(chatId, { prompt: "Tighten the intro" });
      await settled(fixture, chatId);

      expect(
        fixture.qa.reports.map((report) => [report.render?.path, report.render?.origin]),
      ).toEqual([
        ["renders/mine.mp4", "turn"],
        ["renders/qa-b.mp4", "qa"],
      ]);
      expect(fixture.qa.finishRequests).toEqual([
        {
          sessionId: turn.id,
          request: { keep: "renders/qa-b.mp4", produced: ["renders/qa-b.mp4"] },
        },
      ]);
    } finally {
      await fixture.cleanup();
    }
  });

  it("aborted during the checks: cleanup still runs with a fresh signal and keeps the render made so far", async () => {
    const fixture = await createRuntimeFixture();
    try {
      fixture.editing.renderQueue = [output(fixture, "qa-a")];
      fixture.qa.checkGate = new Promise<void>(() => {});
      const chatId = await qaChat(fixture, quality(2));
      const director = directorScript(fixture);
      script(fixture, { director: director.run, vision: visionScript([]) });
      const turn = await fixture.turns.start(chatId, { prompt: "Tighten the intro" });
      await waitUntil(() => fixture.qa.checkRequests.length === 1, "the QA check");
      fixture.turns.abort(chatId, turn.id);
      await settled(fixture, chatId);

      expect(fixture.chats.get(chatId)?.turns[0]?.qa?.status).toBe("aborted");
      expect(fixture.qa.reports).toEqual([]);
      // The render of the stopped pass has no report yet: the runtime names it so it is not left behind.
      expect(fixture.qa.finishRequests).toEqual([
        {
          sessionId: turn.id,
          request: { keep: "renders/qa-a.mp4", produced: ["renders/qa-a.mp4"] },
        },
      ]);
      expect(fixture.qa.finishAbortedAtCall).toEqual([false]);
    } finally {
      await fixture.cleanup();
    }
  });

  it("aborted during the first render: nothing was rendered, so nothing is kept or listed", async () => {
    const fixture = await createRuntimeFixture();
    try {
      fixture.editing.renderGate = new Promise<void>(() => {});
      const chatId = await qaChat(fixture, quality(2));
      const director = directorScript(fixture);
      script(fixture, { director: director.run, vision: visionScript([]) });
      const turn = await fixture.turns.start(chatId, { prompt: "Tighten the intro" });
      await waitUntil(() => fixture.editing.renderRequests.length === 1, "the QA render");
      fixture.turns.abort(chatId, turn.id);
      await settled(fixture, chatId);

      expect(fixture.qa.finishRequests).toEqual([{ sessionId: turn.id, request: { keep: null } }]);
    } finally {
      await fixture.cleanup();
    }
  });

  it("aborted during a correction: the reported pass's render is what stays", async () => {
    const fixture = await createRuntimeFixture();
    try {
      fixture.editing.renderQueue = [output(fixture, "qa-a")];
      fixture.qa.checkResults = [cleanCheck({ issues: [FIXABLE] })];
      const chatId = await qaChat(fixture, quality(3));
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

      expect(fixture.chats.get(chatId)?.turns[0]?.qa?.status).toBe("aborted");
      expect(fixture.qa.finishRequests).toEqual([
        {
          sessionId: turn.id,
          request: { keep: "renders/qa-a.mp4", produced: ["renders/qa-a.mp4"] },
        },
      ]);
    } finally {
      await fixture.cleanup();
    }
  });

  it("does not end a session that never started: skipped QA makes no cleanup call", async () => {
    const fixture = await createRuntimeFixture();
    try {
      const { chatId } = await runTurn(fixture, 0, () => {
        fixture.qa.bump();
      });
      expect(fixture.chats.get(chatId)?.turns[0]?.qa?.status).toBe("skipped");
      expect(fixture.qa.finishRequests).toEqual([]);
    } finally {
      await fixture.cleanup();
    }
  });

  it.each([
    ["a service error", new QaToolError("failed", "disk on fire")],
    ["an unreachable Studio", new QaToolError("studio_unavailable", "Studio is gone")],
    ["an unexpected exception", new Error("boom")],
  ])(
    "ignores a failing cleanup (%s): the turn and its QA result are unchanged",
    async (_name, error) => {
      const fixture = await createRuntimeFixture();
      try {
        fixture.editing.renderQueue = [output(fixture, "qa-a"), output(fixture, "qa-b")];
        fixture.qa.checkResults = [cleanCheck({ issues: [FIXABLE] }), cleanCheck()];
        fixture.qa.finishError = error;
        const { chatId, director } = await runTurn(fixture, 2);

        expect(fixture.qa.finishRequests).toHaveLength(1);
        expect(fixture.chats.get(chatId)?.turns[0]).toMatchObject({
          status: "completed",
          qa: { status: "passed" },
        });
        // The Director still gives its final report.
        expect(director.seen.finals).toHaveLength(1);
      } finally {
        await fixture.cleanup();
      }
    },
  );
});
