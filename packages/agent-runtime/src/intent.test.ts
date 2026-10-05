import { describe, expect, it } from "vitest";
import { intentRefusal, savesWebsiteFiles } from "./intent.js";
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

describe("turn intent (Edit / Ask) and plan approval", () => {
  it("lets an Edit turn act and an Ask turn only answer", async () => {
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
          operations: [{ op: "remove_clip", clip: "a" }],
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
    } finally {
      await fixture.cleanup();
    }
  });

  it("offers propose_plan for big (the default), refuses project changes after a proposal, and never waits", async () => {
    const fixture = await createRuntimeFixture();
    try {
      const chat = await fixture.chats.create({}, []);
      let calls: {
        proposed: string;
        edit: string;
        render: string;
        write: string | null;
        read: string | null;
      } | null = null;
      fixture.backend.promptScript = async (_input, session) => {
        const proposed = await session.callTool("propose_plan", {
          steps: [
            { title: "Build the intro with the logo", agent: "motion" },
            { title: "Assemble the three best moments", agent: "editor" },
            { title: "Add music and titles" },
          ],
        });
        // After the proposal every project-changing call is refused for the rest of the turn.
        const edit = await session.callTool("edit_timeline", {
          operations: [{ op: "remove_clip", clip: "a" }],
        });
        const render = await session.callTool("render_video", { composition: "index.html" });
        calls = {
          proposed: proposed.text,
          edit: edit.text,
          render: render.text,
          write: session.input.fileWriteRefusal?.("write") ?? null,
          read: session.input.fileWriteRefusal?.("read") ?? null,
        };
        return "completed";
      };
      await fixture.turns.start(chat.id, { prompt: "Make a 30 second teaser from the talk" });
      await finishTurn(fixture, chat.id);
      const session = fixture.backend.sessionsOf("director").at(-1);
      expect(toolNames(session)).toContain("propose_plan");
      expect(session?.prompts.at(-1)?.text).toContain("<plan-approval>");
      expect(session?.prompts.at(-1)?.text).toContain("more than two steps");
      expect(calls).not.toBeNull();
      expect(calls!.proposed).toContain("Plan proposed");
      expect(calls!.edit).toContain("plan proposal");
      expect(calls!.render).toContain("plan proposal");
      expect(calls!.write).toContain("plan proposal");
      expect(calls!.read).toBeNull();
      expect(fixture.editing.applyRequests).toHaveLength(0);
      expect(fixture.editing.renderRequests).toHaveLength(0);
      const turn = fixture.chats.get(chat.id)?.turns.at(-1);
      expect(turn).toMatchObject({ status: "completed", intent: "edit" });
      expect(turn?.plan?.proposal).toBe(true);
      expect(turn?.plan?.steps.map((step) => step.title)).toEqual([
        "Build the intro with the logo",
        "Assemble the three best moments",
        "Add music and titles",
      ]);
      expect(turn?.plan?.steps.every((step) => step.status === "pending")).toBe(true);
    } finally {
      await fixture.cleanup();
    }
  });

  it("proposes before every project-changing request under always, and never proposes under never", async () => {
    const fixture = await createRuntimeFixture();
    try {
      const chat = await fixture.chats.create({}, []);
      fixture.backend.promptScript = async () => "completed";

      await fixture.settings.update({ autonomy: { planApproval: "always" } });
      await fixture.turns.start(chat.id, { prompt: "Make the title red" });
      await finishTurn(fixture, chat.id);
      const always = fixture.backend.sessionsOf("director").at(-1);
      expect(toolNames(always)).toContain("propose_plan");
      expect(always?.prompts.at(-1)?.text).toContain("before every request that changes");
      expect(toolNames(always)).toContain("edit_timeline");

      await fixture.settings.update({ autonomy: { planApproval: "never" } });
      let stalePropose: string | null = null;
      fixture.backend.promptScript = async () => {
        // A reused session keeps the propose tool it was opened with; the runtime refuses the call.
        stalePropose = (await always!.callTool("propose_plan", { steps: [{ title: "One" }] })).text;
        return "completed";
      };
      await fixture.turns.start(chat.id, { prompt: "Make the title red" });
      await finishTurn(fixture, chat.id);
      const never = fixture.backend.sessionsOf("director").at(-1);
      expect(toolNames(never)).not.toContain("propose_plan");
      expect(never?.prompts.at(-1)?.text).not.toContain("<plan-approval>");
      expect(stalePropose).toContain("not available in this turn");
    } finally {
      await fixture.cleanup();
    }
  });

  it("carries the approved steps into the execute turn, which never proposes and may act", async () => {
    const fixture = await createRuntimeFixture();
    try {
      const chat = await fixture.chats.create({}, []);
      // First turn: a proposal (never mind that no project-changing call follows).
      fixture.backend.promptScript = async (_input, session) => {
        await session.callTool("propose_plan", {
          steps: [
            { title: "Set the format", agent: "editor" },
            { title: "Cut the intro", agent: "editor" },
          ],
        });
        return "completed";
      };
      await fixture.turns.start(chat.id, { prompt: "Make a teaser" });
      await finishTurn(fixture, chat.id);
      const proposalTurn = fixture.chats.get(chat.id)?.turns.at(-1);
      expect(proposalTurn?.plan?.proposal).toBe(true);
      const proposalSession = fixture.backend.sessionsOf("director").at(-1);

      // The user pressed «Выполнить»: the runtime resolves the proposal and hands the steps over.
      let calls: { edit: string; stalePropose: string; write: string | null } | null = null;
      fixture.backend.promptScript = async (_input, session) => {
        const edit = await session.callTool("edit_timeline", {
          operations: [{ op: "remove_clip", clip: "a" }],
        });
        const stalePropose = await proposalSession!.callTool("propose_plan", {
          steps: [{ title: "Another plan" }],
        });
        calls = {
          edit: edit.text,
          stalePropose: stalePropose.text,
          write: session.input.fileWriteRefusal?.("write") ?? null,
        };
        return "completed";
      };
      await fixture.turns.start(chat.id, {
        prompt: "Carry out the plan",
        executePlan: { turnId: proposalTurn!.id },
      });
      await finishTurn(fixture, chat.id);
      const execute = fixture.backend.sessionsOf("director").at(-1);
      expect(toolNames(execute)).not.toContain("propose_plan");
      const prompt = execute?.prompts.at(-1)?.text ?? "";
      expect(prompt).toContain("<approved-plan>");
      expect(prompt).toContain("1. Set the format (editor)");
      expect(prompt).toContain("2. Cut the intro (editor)");
      expect(prompt).not.toContain("<plan-approval>");
      expect(calls).not.toBeNull();
      expect(calls!.stalePropose).toContain("not available in this turn");
      expect(calls!.write).toBeNull();
      expect(fixture.editing.applyRequests).toHaveLength(1);
      expect(fixture.chats.get(chat.id)?.turns.at(-1)?.intent).toBe("edit");

      // An execute request for a turn without a proposal is refused.
      await expect(
        fixture.turns.start(chat.id, { prompt: "Again", executePlan: { turnId: "nope" } }),
      ).rejects.toMatchObject({ code: "invalid_request" });
    } finally {
      await fixture.cleanup();
    }
  });

  it("never offers a plan proposal in story-mode turns (the graph is the plan)", async () => {
    const fixture = await createRuntimeFixture();
    try {
      const chat = await fixture.chats.create({}, []);
      fixture.backend.promptScript = async () => "completed";
      await fixture.turns.start(chat.id, { prompt: "Review the story", storyAction: "review" });
      await finishTurn(fixture, chat.id);
      const session = fixture.backend.sessionsOf("director").at(-1);
      expect(toolNames(session)).not.toContain("propose_plan");
      expect(session?.prompts.at(-1)?.text).not.toContain("<plan-approval>");
      expect(fixture.chats.get(chat.id)?.turns.at(-1)).toMatchObject({
        intent: "edit",
        storyAction: "review",
      });
    } finally {
      await fixture.cleanup();
    }
  });
});

describe("intentRefusal for website saves", () => {
  const SAVE_CALLS = [
    ["read_website", { url: "https://linear.app", save: true }],
    ["get_website_file", { url: "https://linear.app/a.svg", mode: "save" }],
  ] as const;
  const READ_CALLS = [
    ["read_website", { url: "https://linear.app" }],
    ["get_website_file", { url: "https://linear.app/a.css", mode: "read" }],
  ] as const;

  it("refuses saving a website's files after a plan proposal or a Story offer, and still lets reads through", () => {
    for (const [name, args] of SAVE_CALLS) {
      expect(intentRefusal("edit", name, true, false, args), `${name} after a plan`).toContain(
        "plan proposal",
      );
      expect(intentRefusal("edit", name, false, true, args), `${name} after an offer`).toContain(
        "offered Story Mode",
      );
      expect(intentRefusal("edit", name, false, false, args), `${name} in a plain turn`).toBeNull();
    }
    for (const [name, args] of READ_CALLS) {
      expect(intentRefusal("edit", name, true, true, args), name).toBeNull();
    }
  });

  it("reads a whitespace-padded mode the way the executor does, so it cannot slip past the gates", () => {
    for (const mode of ["save ", " save", "\tsave\n"]) {
      const args = { url: "https://linear.app/a.svg", mode };
      expect(savesWebsiteFiles("get_website_file", args), JSON.stringify(mode)).toBe(true);
      expect(intentRefusal("edit", "get_website_file", true, false, args)).toContain(
        "plan proposal",
      );
    }
    for (const mode of ["savee", "unsave", 1, null]) {
      expect(savesWebsiteFiles("get_website_file", { url: "https://linear.app/a", mode })).toBe(
        false,
      );
    }
  });
});
