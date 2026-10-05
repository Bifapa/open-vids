import { describe, expect, it } from "vitest";
import { EditingError } from "../editing/host.js";
import { createRuntimeFixture, type RuntimeFixture } from "../testing/runtimeFixture.js";
import { cleanCheck, qaDraft } from "../testing/qa.js";
import { directorScript, qaChat, quality, script, settled, visionScript } from "./harness.js";

const FIXABLE = qaDraft({ subject: "c2" });

describe("the Director's closing prompts", () => {
  it("names a render of another composition as unchecked instead of denying it", async () => {
    const fixture = await createRuntimeFixture();
    try {
      const chatId = await qaChat(fixture, quality(2));
      const director = directorScript(fixture, {
        // No edit: the Director only renders a sub-composition, which QA does not check.
        first: async (session) => {
          await session.callTool("render_video", { composition: "compositions/intro.html" });
        },
      });
      script(fixture, { director: director.run, vision: visionScript([]) });
      await fixture.turns.start(chatId, { prompt: "Render the intro" });
      await settled(fixture, chatId);

      expect(fixture.chats.get(chatId)?.turns[0]?.qa).toBeUndefined();
      expect(director.seen.closings).toHaveLength(1);
      const closing = director.seen.closings[0] ?? "";
      expect(closing).toContain("compositions/intro.html");
      expect(closing).toContain("was NOT checked");
      expect(closing).not.toContain("nothing was rendered");
      expect(closing).not.toContain("it did not happen");
    } finally {
      await fixture.cleanup();
    }
  });

  it("reports a failed last render and marks the older one as made before the last change", async () => {
    const fixture = await createRuntimeFixture();
    try {
      fixture.editing.renderQueue = [
        { ...fixture.editing.renderResult, path: "renders/qa-a.mp4" },
        new EditingError("render_failed", "second failure"),
      ];
      fixture.qa.checkResults = [cleanCheck({ issues: [FIXABLE] })];
      const chatId = await qaChat(fixture, quality(2));
      const director = directorScript(fixture);
      script(fixture, { director: director.run, vision: visionScript([]) });
      await fixture.turns.start(chatId, { prompt: "Tighten the intro" });
      await settled(fixture, chatId);

      const final = director.seen.finals[0] ?? "";
      expect(final).toContain("The last render failed: second failure");
      expect(final).toContain("renders/qa-a.mp4");
      expect(final).toContain("was made before the last change");
      expect(final).not.toContain("It is the current state of the project");
    } finally {
      await fixture.cleanup();
    }
  });

  it("keeps the user's steering when no closing prompt is sent", async () => {
    const fixture = await createRuntimeFixture();
    try {
      // Render QA is off: the project changed, QA is skipped and the Director was never told a check would follow.
      const chatId = await qaChat(fixture, quality(0));
      const director = directorScript(fixture);
      script(fixture, { director: director.run });
      const run = holdSteeringAtQaStart(fixture, "Also keep the logo visible");
      await fixture.turns.start(chatId, { prompt: "Tighten the intro" });
      await settled(fixture, chatId);

      expect(director.seen.closings).toEqual([]);
      expect(run.captured?.pendingSteering).toEqual(["Also keep the logo visible"]);
    } finally {
      await fixture.cleanup();
    }
  });
});

/**
 * Queues `text` as steering the moment the turn's Director has gone idle and the QA loop asks for the project's
 * fingerprint: the steering arrives after the Director's last prompt, as when the user writes during QA.
 */
function holdSteeringAtQaStart(fixture: RuntimeFixture, text: string) {
  const held: { captured: { pendingSteering: string[] } | null } = { captured: null };
  const state = fixture.qa.state.bind(fixture.qa);
  fixture.qa.state = async (signal) => {
    const run = fixture.turns["ctx"].active;
    if (run?.directorIdle && held.captured === null) {
      run.pendingSteering.push(text);
      held.captured = run;
    }
    return state(signal);
  };
  return held;
}
