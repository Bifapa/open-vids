import { describe, expect, it } from "vitest";
import { createRuntimeFixture, waitUntil, type RuntimeFixture } from "../testing/runtimeFixture.js";
import { directorScript, qaChat, quality, script, settled, visionScript } from "./harness.js";

function pendingCard(fixture: RuntimeFixture, chatId: string) {
  const parts = (fixture.chats.get(chatId)?.messages ?? []).flatMap((message) =>
    message.role === "assistant" ? message.parts : [],
  );
  const part = parts.find(
    (entry) => entry.type === "permission" && entry.permission.state === "pending",
  );
  return part?.type === "permission" ? part.permission : null;
}

describe("Render QA after a long render the user allowed on the card", () => {
  async function longTurn(allow: boolean): Promise<{
    renderRequests: number;
    timelineChecks: number;
    scope: string | undefined;
  }> {
    const fixture = await createRuntimeFixture();
    try {
      fixture.editing.timelineResult = {
        ...fixture.editing.timelineResult,
        composition: { path: "index.html", width: 1920, height: 1080, duration: 400 },
      };
      const chatId = await qaChat(fixture, quality(1));
      const director = directorScript(fixture, {
        first: async (session) => {
          fixture.qa.bump();
          const rendering = session.callTool("render_video", {});
          await waitUntil(() => pendingCard(fixture, chatId) !== null, "the long render card");
          const turnId = fixture.turns.activeTurn?.turnId ?? "";
          await fixture.turns.answerPermission(
            chatId,
            turnId,
            pendingCard(fixture, chatId)?.id ?? "",
            allow ? "once" : "deny",
          );
          await rendering;
        },
      });
      script(fixture, { director: director.run, vision: visionScript([]) });
      await fixture.turns.start(chatId, { prompt: "Tighten the talk" });
      await settled(fixture, chatId);
      return {
        renderRequests: fixture.editing.renderRequests.length,
        timelineChecks: fixture.qa.timelineCheckRequests.length,
        scope: fixture.chats.get(chatId)?.turns[0]?.qa?.scope,
      };
    } finally {
      await fixture.cleanup();
    }
  }

  it("checks the render instead of settling for the timeline alone", async () => {
    const allowed = await longTurn(true);
    expect(allowed.renderRequests).toBeGreaterThan(0);
    expect(allowed.timelineChecks).toBe(0);
    expect(allowed.scope).not.toBe("timeline");
  });

  it("still checks the timeline alone when the user declined the render", async () => {
    const declined = await longTurn(false);
    expect(declined.renderRequests).toBe(0);
    expect(declined.timelineChecks).toBe(1);
    expect(declined.scope).toBe("timeline");
  });
});
