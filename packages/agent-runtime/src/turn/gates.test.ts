import { describe, expect, it } from "vitest";
import { ChangeTally } from "./changes.js";
import { phaseGateRefusal } from "./gates.js";
import { createRuntimeFixture, waitUntil, type RuntimeFixture } from "../testing/runtimeFixture.js";

async function finishTurn(fixture: RuntimeFixture, chatId: string): Promise<void> {
  await waitUntil(() => {
    const last = fixture.chats.get(chatId)?.turns.at(-1);
    return last !== undefined && last.status !== "running";
  }, "turn completion");
}

const open = { qaPhase: null, planProposed: false, storyOffered: false } as const;

describe("phase gates", () => {
  it("lets either offer through in an ordinary turn", () => {
    expect(phaseGateRefusal(open, "propose_plan")).toBeNull();
    expect(phaseGateRefusal(open, "offer_story_mode")).toBeNull();
    expect(phaseGateRefusal(open, "request_input")).toBeNull();
  });

  it("refuses a Story Mode offer after a plan proposal, and a proposal after an offer", () => {
    expect(phaseGateRefusal({ ...open, planProposed: true }, "offer_story_mode")).toContain(
      "plan proposal",
    );
    expect(phaseGateRefusal({ ...open, storyOffered: true }, "propose_plan")).toContain(
      "already offered",
    );
  });

  it("refuses proposals, offers and questions in every Render QA phase", () => {
    for (const qaPhase of ["correction", "final", "review"] as const) {
      const state = { ...open, qaPhase };
      expect(phaseGateRefusal(state, "propose_plan"), qaPhase).toContain("Render QA");
      expect(phaseGateRefusal(state, "offer_story_mode"), qaPhase).toContain("Render QA");
      expect(phaseGateRefusal(state, "request_input"), qaPhase).toContain("Render QA");
    }
  });

  it("keeps long analysis jobs out of the final report but lets it read results", () => {
    const final = { ...open, qaPhase: "final" } as const;
    expect(phaseGateRefusal(final, "analyze_media")).toContain("final report");
    expect(phaseGateRefusal(final, "inspect_frames")).toContain("final report");
    expect(phaseGateRefusal(final, "read_analysis")).toBeNull();
    expect(phaseGateRefusal({ ...open, qaPhase: "correction" }, "analyze_media")).toBeNull();
  });
});

describe("phase gates in a turn", () => {
  it("refuses a Story Mode offer once the turn proposed a plan", async () => {
    const fixture = await createRuntimeFixture();
    try {
      const chat = await fixture.chats.create({}, []);
      let offer = "";
      fixture.backend.promptScript = async (input, session) => {
        if (!input.text.includes("Make a teaser")) return "completed";
        await session.callTool("propose_plan", { steps: [{ title: "Cut" }, { title: "Titles" }] });
        offer = (
          await session.callTool("offer_story_mode", {
            chapters: [{ title: "One" }, { title: "Two" }, { title: "Three" }],
          })
        ).text;
        return "completed";
      };
      await fixture.turns.start(chat.id, { prompt: "Make a teaser" });
      await finishTurn(fixture, chat.id);
      expect(offer).toContain("plan proposal");
      const hasOffer = fixture.chats
        .get(chat.id)
        ?.messages.some(
          (message) =>
            message.role === "assistant" && message.parts.some((p) => p.type === "story-offer"),
        );
      expect(hasOffer).toBe(false);
    } finally {
      await fixture.cleanup();
    }
  });
});

describe("plan staleness", () => {
  async function proposePlan(fixture: RuntimeFixture, chatId: string) {
    fixture.backend.promptScript = async (input, session) => {
      if (!input.text.includes("Make a teaser")) return "completed";
      await session.callTool("propose_plan", {
        steps: [{ title: "Set format" }, { title: "Cut" }],
      });
      return "completed";
    };
    const turn = await fixture.turns.start(chatId, { prompt: "Make a teaser" });
    await finishTurn(fixture, chatId);
    return turn.id;
  }

  it("records the project fingerprint at the proposal", async () => {
    const fixture = await createRuntimeFixture();
    try {
      const chat = await fixture.chats.create({}, []);
      fixture.qa.fingerprint = "fp-at-proposal";
      const turnId = await proposePlan(fixture, chat.id);
      const proposal = fixture.chats.get(chat.id)?.turns.find((turn) => turn.id === turnId)?.plan;
      expect(proposal?.proposal).toBe(true);
      expect(proposal?.projectFingerprint).toBe("fp-at-proposal");
    } finally {
      await fixture.cleanup();
    }
  });

  it("tells the Director to adapt when the project changed after the proposal, and nothing when it did not", async () => {
    const fixture = await createRuntimeFixture();
    try {
      const chat = await fixture.chats.create({}, []);
      const turnId = await proposePlan(fixture, chat.id);
      fixture.backend.promptScript = async () => "completed";

      await fixture.turns.start(chat.id, { prompt: "Carry on", executePlan: { turnId } });
      await finishTurn(fixture, chat.id);
      const session = fixture.backend.sessionsOf("director").at(-1);
      const unchanged = session?.prompts.find((prompt) => prompt.text.includes("Carry on"))?.text;
      expect(unchanged).toContain("<approved-plan>");
      expect(unchanged).not.toContain("The project changed after this plan was proposed");

      fixture.qa.bump();
      await fixture.turns.start(chat.id, { prompt: "Carry out again", executePlan: { turnId } });
      await finishTurn(fixture, chat.id);
      const stale = session?.prompts.find((prompt) =>
        prompt.text.includes("Carry out again"),
      )?.text;
      expect(stale).toContain("The project changed after this plan was proposed");
    } finally {
      await fixture.cleanup();
    }
  });
});

describe("file writes in the change summary", () => {
  it("counts a harness write only once the tool guard reports it passed every check", async () => {
    // Render QA would prompt the Director again after a write attempt; this test is about the change summary alone.
    const fixture = await createRuntimeFixture({ qa: undefined });
    try {
      const chat = await fixture.chats.create({}, []);
      const refusals: Array<string | null> = [];
      fixture.backend.promptScript = async (_input, session) => {
        // The turn's own rules let the write through, but the guard has not said the rest of its chain passed.
        const check = session.input.fileWriteRefusal;
        refusals.push(check ? check("write") : "no file write check");
        session.input.noteFileWrite?.("read");
        return "completed";
      };
      await fixture.turns.start(chat.id, { prompt: "Edit the notes" });
      await finishTurn(fixture, chat.id);
      expect(refusals).toEqual([null]);
      expect(fixture.chats.get(chat.id)?.turns.at(-1)?.changes).toBeUndefined();

      fixture.backend.promptScript = async (_input, session) => {
        session.input.noteFileWrite?.("write");
        return "completed";
      };
      await fixture.turns.start(chat.id, { prompt: "Edit the notes again" });
      await finishTurn(fixture, chat.id);
      expect(fixture.chats.get(chat.id)?.turns.at(-1)?.changes).toEqual([
        { kind: "file_edit", count: 1 },
      ]);
    } finally {
      await fixture.cleanup();
    }
  });
});

describe("ChangeTally", () => {
  it("groups timeline operations into the kinds the footer shows and ignores failures and dry runs", () => {
    const tally = new ChangeTally();
    const ok = { text: "ok" };
    tally.noteToolCall(
      "edit_timeline",
      {
        operations: [
          { op: "add_clip" },
          { op: "add_text" },
          { op: "split_clip" },
          { op: "apply_captions" },
          { op: "set_volume_automation" },
          { op: "set_locked" },
        ],
      },
      ok,
    );
    tally.noteToolCall("edit_timeline", { operations: [{ op: "remove_clip" }], dryRun: true }, ok);
    tally.noteToolCall(
      "edit_timeline",
      { operations: [{ op: "remove_clip" }] },
      { text: "x", isError: true },
    );
    tally.noteToolCall("import_asset", { candidate: "c1" }, ok);
    tally.noteToolCall("edit_story", { operations: [{}, {}, {}] }, ok);
    tally.noteToolCall("build_story", {}, ok);
    tally.noteToolCall("read_website", { url: "https://example.com", save: true }, ok);
    tally.noteToolCall("read_website", { url: "https://example.com" }, ok);
    tally.noteFileWrite();
    expect(tally.list()).toEqual([
      { kind: "add_clip", count: 2 },
      { kind: "trim_clip", count: 1 },
      { kind: "captions", count: 1 },
      { kind: "audio", count: 1 },
      { kind: "update_clip", count: 1 },
      { kind: "import", count: 1 },
      { kind: "story_edit", count: 3 },
      { kind: "story_build", count: 1 },
      { kind: "web_save", count: 1 },
      { kind: "file_edit", count: 1 },
    ]);
  });
});
