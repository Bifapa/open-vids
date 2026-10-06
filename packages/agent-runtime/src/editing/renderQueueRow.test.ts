import { describe, expect, it } from "vitest";
import { createRuntimeFixture, waitUntil } from "../testing/runtimeFixture.js";

describe("render_video's chat row while the render waits in Studio's render queue", () => {
  it("says where the render stands (as a locale code with parameters), and goes back to Rendering once it runs", async () => {
    const fixture = await createRuntimeFixture();
    try {
      fixture.editing.renderProgressScript = [
        { progress: 0, stage: null, queue: { position: 2, holder: "Promo" } },
        { progress: 0, stage: null, queue: { position: 1, holder: "Promo" } },
        { progress: 0, stage: null, queue: { position: 1, holder: null } },
        { progress: 30, stage: "capture" },
      ];
      const chat = await fixture.chats.create({}, []);
      fixture.backend.promptScript = async (_input, session) => {
        await session.callTool("render_video", { quality: "draft" });
        return "completed";
      };
      await fixture.turns.start(chat.id, { prompt: "Render a draft" });
      await waitUntil(() => fixture.turns.activeTurn === null, "the turn to end");

      const rows = fixture.chats
        .events(chat.id)
        .flatMap((event) => (event.type === "activity.updated" ? [event.activity] : []))
        .filter((activity) => activity.labelCode?.startsWith("rendering_video"));
      // Up to and including the call's own closing row (a later turn step may start its own render).
      const closing = rows.findIndex((row) => row.status === "done");
      const shown = rows
        .slice(0, closing + 1)
        .map((row) => [row.labelCode, row.labelParams ?? null, row.progress ?? null]);
      expect(shown).toEqual([
        ["rendering_video", null, null],
        ["rendering_video", null, 0],
        // Queued: the place is a code and parameters, the percent stays 0.
        ["rendering_video_queued_behind", { position: 2, project: "Promo" }, 0],
        ["rendering_video_queued_behind", { position: 1, project: "Promo" }, 0],
        ["rendering_video_queued", { position: 1 }, 0],
        ["rendering_video", null, 30],
        ["rendering_video", null, 100],
        ["rendering_video", null, null],
      ]);
    } finally {
      await fixture.cleanup();
    }
  });
});
