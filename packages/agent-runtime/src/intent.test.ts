import { describe, expect, it } from "vitest";
import type { ScriptedSession } from "./testing/backend.js";
import { createRuntimeFixture, waitUntil, type RuntimeFixture } from "./testing/runtimeFixture.js";

async function finishTurn(fixture: RuntimeFixture, chatId: string): Promise<void> {
  await waitUntil(() => {
    const last = fixture.chats.get(chatId)?.turns.at(-1);
    return last !== undefined && last.status !== "running";
  }, "turn completion");
}

const toolNames = (session: ScriptedSession | undefined) =>
  session?.input.hostTools.map((tool) => tool.name) ?? [];

describe("turn intent (Plan / Edit / Ask)", () => {
  it("never lets a Plan or Ask turn change the project, and lets an Edit turn act", async () => {
    const fixture = await createRuntimeFixture();
    try {
      // No specialists: the Director holds the editing tools itself.
      const chat = await fixture.chats.create({}, []);
      fixture.backend.promptScript = async () => "completed";

      // Edit (the default): the project-changing tools are there.
      await fixture.turns.start(chat.id, { prompt: "Tighten the intro" });
      await finishTurn(fixture, chat.id);
      const editSession = fixture.backend.sessionsOf("director").at(-1);
      expect(toolNames(editSession)).toEqual(
        expect.arrayContaining(["edit_timeline", "render_video", "inspect_timeline"]),
      );
      expect(fixture.chats.get(chat.id)?.turns.at(-1)?.intent).toBe("edit");

      // Ask: no project-changing tool is offered, file writes are refused, and so is a stale session's edit tool.
      let refusals: { write: string | null; read: string | null; staleEdit: string } | null = null;
      fixture.backend.promptScript = async (_input, session) => {
        const staleEdit = await editSession!.callTool("edit_timeline", {
          operations: [{ op: "remove_clip", clipId: "a" }],
        });
        refusals = {
          write: session.input.fileWriteRefusal?.("write") ?? null,
          read: session.input.fileWriteRefusal?.("read") ?? null,
          staleEdit: staleEdit.text,
        };
        return "completed";
      };
      await fixture.turns.start(chat.id, { prompt: "What is at 00:00:12?", intent: "ask" });
      await finishTurn(fixture, chat.id);
      const askSession = fixture.backend.sessionsOf("director").at(-1);
      expect(toolNames(askSession)).toContain("inspect_timeline");
      expect(toolNames(askSession)).not.toEqual(expect.arrayContaining(["edit_timeline"]));
      expect(toolNames(askSession)).not.toContain("render_video");
      expect(askSession?.prompts.at(-1)?.text).toContain("<turn-intent>\nAsk:");
      expect(refusals).toMatchObject({ read: null });
      expect(refusals!.write).toContain("Ask turn");
      expect(refusals!.staleEdit).toContain("Ask turn");
      expect(fixture.editing.applyRequests).toHaveLength(0);
      expect(fixture.chats.get(chat.id)?.turns.at(-1)?.intent).toBe("ask");

      // Plan, taken from the chat's intent: the plan tool stays, editing goes, the prompt asks for a proposal.
      await fixture.chats.update(chat.id, { intent: "plan" });
      fixture.backend.promptScript = async () => "completed";
      await fixture.turns.start(chat.id, { prompt: "Make a 30 second teaser" });
      await finishTurn(fixture, chat.id);
      const planSession = fixture.backend.sessionsOf("director").at(-1);
      expect(toolNames(planSession)).toContain("update_plan");
      expect(toolNames(planSession)).not.toContain("edit_timeline");
      expect(planSession?.prompts.at(-1)?.text).toContain("<turn-intent>\nPlan:");
      expect(fixture.chats.get(chat.id)?.turns.at(-1)?.intent).toBe("plan");

      // Outside a turn nothing is refused (the guard only speaks for the running turn).
      expect(planSession?.input.fileWriteRefusal?.("write")).toBeNull();

      // A story action always acts, whatever the chat's intent.
      await fixture.turns.start(chat.id, { prompt: "Build the story", storyAction: "build" });
      await finishTurn(fixture, chat.id);
      expect(fixture.chats.get(chat.id)?.turns.at(-1)).toMatchObject({
        intent: "edit",
        storyAction: "build",
      });
    } finally {
      await fixture.cleanup();
    }
  });
});
