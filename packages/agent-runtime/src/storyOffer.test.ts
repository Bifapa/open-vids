import { describe, expect, it } from "vitest";
import { ChatService } from "./chats.js";
import type { StartTurnRequest, StoryOffer, StoryOfferPart } from "@hyperframes/agent-protocol";
import type { ScriptedSession } from "./testing/backend.js";
import type { HostToolResult } from "./backend.js";
import { isQaClosing } from "./qa/harness.js";
import { chapterNode, storyGraph, storyView } from "./testing/story.js";
import { createRuntimeFixture, waitUntil, type RuntimeFixture } from "./testing/runtimeFixture.js";

async function finishTurn(fixture: RuntimeFixture, chatId: string): Promise<void> {
  await waitUntil(() => {
    const last = fixture.chats.get(chatId)?.turns.at(-1);
    return last !== undefined && last.status !== "running";
  }, "turn completion");
}

const toolNames = (session: ScriptedSession | undefined) =>
  session?.input.hostTools.map((tool) => tool.name) ?? [];

/** The Story Mode offer the chat is showing (there is at most one pending), from its message part. */
function offerOf(fixture: RuntimeFixture, chatId: string): { turnId: string; offer: StoryOffer } {
  const state = fixture.chats.get(chatId);
  for (const message of state?.messages ?? []) {
    if (message.role !== "assistant") continue;
    for (const part of message.parts) {
      const offer = part.type === "story-offer" ? (part as StoryOfferPart).offer : null;
      if (offer) return { turnId: message.turnId, offer };
    }
  }
  throw new Error("no Story Mode offer in the chat");
}

const CHAPTER_SCRIPT: Array<{
  title: string;
  summary?: string;
  durationSeconds?: number;
  material?: string;
}> = [
  { title: "Старт ракеты" },
  { title: "Туманность Карина", summary: "фото из архива" },
  { title: "Финал с титрами", durationSeconds: 12, material: "музыка" },
];

/** Runs one turn whose Director offers the three chapters above. */
async function runOfferTurn(fixture: RuntimeFixture, chatId: string): Promise<void> {
  fixture.backend.promptScript = async (_input, session) => {
    await session.callTool("offer_story_mode", { chapters: CHAPTER_SCRIPT });
    return "completed";
  };
  await fixture.turns.start(chatId, {
    prompt:
      "Сделай ролик: сначала покажи старт ракеты, потом фото туманности Карина, затем финал с титрами и музыкой",
  });
  await finishTurn(fixture, chatId);
}

describe("Story Mode offers in chat", () => {
  it("reloads a chat whose log holds a Story Mode offer, with the offer card intact", async () => {
    const fixture = await createRuntimeFixture();
    try {
      const chat = await fixture.chats.create({}, []);
      await runOfferTurn(fixture, chat.id);
      const before = offerOf(fixture, chat.id);
      const loaded = await fixture.store.load(chat.id);
      expect(loaded.events.some((event) => event.type === "storyOffer.updated")).toBe(true);

      const reopened = await ChatService.open(fixture.scope, fixture.store, { now: fixture.now });
      expect(reopened.get(chat.id)).toEqual(fixture.chats.get(chat.id));
      expect(offerOf({ ...fixture, chats: reopened }, chat.id)).toEqual(before);
    } finally {
      await fixture.cleanup();
    }
  });

  it("offers Story Mode from a normal Edit turn and refuses every project-changing call after the offer", async () => {
    const fixture = await createRuntimeFixture();
    try {
      const chat = await fixture.chats.create({}, []);
      let calls: {
        offered: string;
        edit: string;
        render: string;
        write: string | null;
        propose: string;
      } | null = null;
      fixture.backend.promptScript = async (input, session) => {
        if (!input.text.includes("Сделай ролик")) return "completed";
        const offered = await session.callTool("offer_story_mode", { chapters: CHAPTER_SCRIPT });
        // After the offer nothing in the project changes for the rest of the turn.
        const edit = await session.callTool("edit_timeline", {
          operations: [{ op: "remove_clip", clip: "a" }],
        });
        const render = await session.callTool("render_video", {});
        const propose = await session.callTool("propose_plan", {
          steps: [{ title: "Another plan" }],
        });
        calls = {
          offered: offered.text,
          edit: edit.text,
          render: render.text,
          write: session.input.fileWriteRefusal?.("write") ?? null,
          propose: propose.text,
        };
        return "completed";
      };
      await fixture.turns.start(chat.id, {
        prompt: "Сделай ролик: сначала старт ракеты, потом Карина и финал",
      });
      await finishTurn(fixture, chat.id);
      const session = fixture.backend.sessionsOf("director").at(-1);
      expect(toolNames(session)).toContain("offer_story_mode");
      expect(session?.prompts.find((p) => p.text.includes("Сделай ролик"))?.text).toContain(
        "<story-offer>",
      );
      expect(calls).not.toBeNull();
      expect(calls!.offered).toContain("Story Mode offer with 3 chapters");
      expect(calls!.edit).toContain("already offered Story Mode");
      expect(calls!.render).toContain("already offered Story Mode");
      expect(calls!.write).toContain("already offered Story Mode");
      expect(calls!.propose).toContain("Story Mode is already offered in this turn");
      expect(fixture.editing.applyRequests).toHaveLength(0);
      expect(fixture.editing.renderRequests).toHaveLength(0);
      // The card is pending, with the chapters in the user's own words and order…
      const { turnId, offer } = offerOf(fixture, chat.id);
      expect(turnId).toBe(fixture.chats.get(chat.id)?.turns.at(-1)?.id);
      expect(offer.state).toBe("pending");
      expect(offer.chapters.map((chapter) => chapter.title)).toEqual([
        "Старт ракеты",
        "Туманность Карина",
        "Финал с титрами",
      ]);
      // …and it stays answerable after its own turn ends.
      await expect(
        fixture.turns.answerStoryOffer(chat.id, turnId, offer.id, "accept"),
      ).resolves.toMatchObject({ offer: { state: "accepted" } });
    } finally {
      await fixture.cleanup();
    }
  });

  it("withholds the offer in a declined chat, with chapters in the graph, in story-mode and in Ask turns", async () => {
    const fixture = await createRuntimeFixture();
    try {
      fixture.backend.promptScript = async () => "completed";

      // A declined chat never offers again, and the Director is told in words.
      const declinedChat = await fixture.chats.create({}, []);
      await runOfferTurn(fixture, declinedChat.id);
      const declinedOffer = offerOf(fixture, declinedChat.id);
      await fixture.turns.answerStoryOffer(
        declinedChat.id,
        declinedOffer.turnId,
        declinedOffer.offer.id,
        "decline",
      );
      fixture.backend.promptScript = async () => "completed";
      await fixture.turns.start(declinedChat.id, {
        prompt: "Без Story — монтируй сразу",
        mode: "normal",
        intent: "edit",
      });
      await finishTurn(fixture, declinedChat.id);
      const declined = fixture.backend.sessionsOf("director").at(-1);
      expect(declined?.prompts.find((p) => p.text.includes("Без Story"))?.text).toContain(
        "<story-declined>",
      );

      // A story that already has chapters is no longer offered at all.
      const storyChat = await fixture.chats.create({ title: "Has a story" }, []);
      fixture.story.viewResult = storyView(storyGraph({ nodes: [chapterNode("ch1")] }));
      await fixture.turns.start(storyChat.id, { prompt: "Add a chapter about the engine" });
      await finishTurn(fixture, storyChat.id);
      const withChapters = fixture.backend.sessionsOf("director").at(-1);
      expect(
        withChapters?.prompts.find((p) => p.text.includes("Add a chapter"))?.text,
      ).not.toContain("<story-offer>");

      // Story-mode and Ask turns never get the offer either: the prompt does not carry the block, and a call to
      // offer_story_mode (the Director's session keeps the tool in its stable list) is refused without a card.
      fixture.story.viewResult = storyView(null);
      const attempt = async (chatId: string, request: StartTurnRequest) => {
        const seen: { prompt?: string; refusal?: HostToolResult } = {};
        fixture.backend.promptScript = async (input, session) => {
          if (isQaClosing(input)) return "completed";
          seen.prompt ??= input.text;
          seen.refusal ??= await session.callTool("offer_story_mode", { chapters: CHAPTER_SCRIPT });
          return "completed";
        };
        await fixture.turns.start(chatId, request);
        await finishTurn(fixture, chatId);
        return seen;
      };
      const storyModeChat = await fixture.chats.create({ title: "Story mode" }, []);
      const reviewed = await attempt(storyModeChat.id, {
        prompt: "Review the story",
        storyAction: "review",
      });
      expect(reviewed.prompt).not.toContain("<story-offer>");
      expect(reviewed.refusal).toMatchObject({
        isError: true,
        text: expect.stringContaining("Offering Story Mode is not available in this turn"),
      });
      expect(() => offerOf(fixture, storyModeChat.id)).toThrow("no Story Mode offer");

      const askChat = await fixture.chats.create({ title: "Ask" }, []);
      const asked = await attempt(askChat.id, { prompt: "What is in the story?", intent: "ask" });
      expect(asked.prompt).not.toContain("<story-offer>");
      expect(asked.refusal).toMatchObject({ isError: true });
      expect(() => offerOf(fixture, askChat.id)).toThrow("no Story Mode offer");
    } finally {
      await fixture.cleanup();
    }
  });

  it("carries an execute-plan turn past the offer (the approved plan is carried out)", async () => {
    const fixture = await createRuntimeFixture();
    try {
      const chat = await fixture.chats.create({}, []);
      fixture.backend.promptScript = async (_input, session) => {
        await session.callTool("propose_plan", { steps: [{ title: "Cut the intro" }] });
        return "completed";
      };
      await fixture.turns.start(chat.id, { prompt: "Make a teaser" });
      await finishTurn(fixture, chat.id);
      const proposal = fixture.chats.get(chat.id)?.turns.at(-1);

      await fixture.turns.start(chat.id, {
        prompt: "Carry out the plan",
        executePlan: { turnId: proposal!.id },
      });
      await finishTurn(fixture, chat.id);
      const execute = fixture.backend.sessionsOf("director").at(-1);
      // The tool list is the same in every turn; this turn's prompt carries no offer block.
      expect(
        execute?.prompts.find((p) => p.text.includes("Carry out the plan"))?.text,
      ).not.toContain("<story-offer>");
    } finally {
      await fixture.cleanup();
    }
  });

  it("writes an accepted offer as AI chapters linked in order, and refuses a graph that gained chapters", async () => {
    const fixture = await createRuntimeFixture();
    try {
      const chat = await fixture.chats.create({}, []);
      await runOfferTurn(fixture, chat.id);
      const { turnId, offer } = offerOf(fixture, chat.id);

      const accepted = await fixture.turns.answerStoryOffer(chat.id, turnId, offer.id, "accept");
      expect(accepted.offer.state).toBe("accepted");
      expect(fixture.story.editRequests).toHaveLength(1);
      const request = fixture.story.editRequests[0];
      expect(request?.baseVersion).toBeUndefined();
      expect(request?.operations).toEqual([
        {
          op: "add_node",
          ref: "chapter-1",
          node: { kind: "chapter", title: "Старт ракеты" },
        },
        {
          op: "add_node",
          ref: "chapter-2",
          node: { kind: "chapter", title: "Туманность Карина", description: "фото из архива" },
        },
        {
          op: "add_node",
          ref: "chapter-3",
          node: {
            kind: "chapter",
            title: "Финал с титрами",
            estimatedDuration: 12,
            bRoll: "музыка",
          },
        },
        { op: "connect", from: "@chapter-1", to: "@chapter-2" },
        { op: "connect", from: "@chapter-2", to: "@chapter-3" },
        {
          op: "add_node",
          ref: "need-1",
          node: {
            kind: "missing",
            title: "Музыка · Финал с титрами",
            mediaKind: "music",
            need: "музыка (Финал с титрами)",
            neededDuration: 12,
          },
        },
        { op: "attach", node: "@need-1", chapter: "@chapter-3", placement: "throughout" },
      ]);
      expect(offerOf(fixture, chat.id).offer).toMatchObject({
        id: offer.id,
        state: "accepted",
        answeredAt: expect.any(Number),
      });

      // The graph gained a chapter meanwhile: a second offer's accept cannot apply any more.
      const second = await fixture.chats.create({ title: "Second" }, []);
      await runOfferTurn(fixture, second.id);
      const pending = offerOf(fixture, second.id);
      fixture.story.viewResult = storyView(
        storyGraph({ nodes: [chapterNode("ch1")] }),
        "sha256:later",
      );
      await expect(
        fixture.turns.answerStoryOffer(second.id, pending.turnId, pending.offer.id, "accept"),
      ).rejects.toMatchObject({ code: "story_offer_conflict" });
      expect(fixture.story.editRequests).toHaveLength(1);
      expect(offerOf(fixture, second.id).offer.state).toBe("pending");
    } finally {
      await fixture.cleanup();
    }
  });

  it("records a decline, marks the offer, and expires a pending offer only when a new turn starts", async () => {
    const fixture = await createRuntimeFixture();
    try {
      const chat = await fixture.chats.create({}, []);
      await runOfferTurn(fixture, chat.id);
      const declinedOffer = offerOf(fixture, chat.id);
      const declined = await fixture.turns.answerStoryOffer(
        chat.id,
        declinedOffer.turnId,
        declinedOffer.offer.id,
        "decline",
      );
      expect(declined.offer.state).toBe("declined");
      expect(fixture.chats.get(chat.id)?.chat.storyDeclined).toBe(true);
      // A declined offer is answered once: it cannot be accepted afterwards.
      await expect(
        fixture.turns.answerStoryOffer(
          chat.id,
          declinedOffer.turnId,
          declinedOffer.offer.id,
          "accept",
        ),
      ).rejects.toMatchObject({ code: "turn_not_active" });

      // A pending offer outlives its own turn, and a new user turn is what expires it.
      const second = await fixture.chats.create({ title: "Second" }, []);
      await runOfferTurn(fixture, second.id);
      const pending = offerOf(fixture, second.id);
      expect(pending.offer.state).toBe("pending");
      fixture.backend.promptScript = async () => "completed";
      await fixture.turns.start(second.id, { prompt: "Actually, trim the pauses first" });
      await finishTurn(fixture, second.id);
      expect(offerOf(fixture, second.id).offer).toMatchObject({
        id: pending.offer.id,
        state: "expired",
      });
      await expect(
        fixture.turns.answerStoryOffer(second.id, pending.turnId, pending.offer.id, "accept"),
      ).rejects.toMatchObject({ code: "turn_not_active" });
    } finally {
      await fixture.cleanup();
    }
  });
});
