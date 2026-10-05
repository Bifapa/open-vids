import type { AssistantPart } from "@hyperframes/agent-protocol";
import { describe, expect, it } from "vitest";
import type { BackendPromptInput } from "../backend.js";
import { createRuntimeFixture, type RuntimeFixture } from "../testing/runtimeFixture.js";
import { cleanCheck, qaDraft } from "../testing/qa.js";
import { QaToolError } from "./host.js";
import { qaChat, quality, script, settled, visionScript } from "./harness.js";

const PENDING = "</render-qa-pending>";

const say = (input: BackendPromptInput, text: string) =>
  input.onEvent({ type: "text.delta", delta: text });

/** The Director's own reply: its text parts in order, with whether each is an interim note. */
function replyParts(fixture: RuntimeFixture, chatId: string) {
  const reply = fixture.chats
    .get(chatId)
    ?.messages.find((message) => message.role === "assistant" && !message.runId);
  const parts: AssistantPart[] = reply?.role === "assistant" ? reply.parts : [];
  return parts.flatMap((part) =>
    part.type === "text" ? [{ text: part.text, interim: part.interim === true }] : [],
  );
}

const interimEvents = (fixture: RuntimeFixture, chatId: string) =>
  fixture.chats.events(chatId).filter((event) => event.type === "assistant.parts.interim");

/** A Director that says "Done!" after its work (changing the project), corrects, and writes the final report. */
function chattyDirector(fixture: RuntimeFixture, change = true) {
  const prompts: string[] = [];
  return {
    prompts,
    run: async (input: BackendPromptInput) => {
      prompts.push(input.text);
      if (input.text.includes("<render-qa-final")) say(input, "Final report.");
      else if (input.text.includes("<render-qa-skipped"))
        say(input, "Built, but not rendered or checked.");
      else if (input.text.includes("<render-qa pass=")) {
        say(input, "Fixing the gap.");
        fixture.qa.bump();
      } else {
        say(input, "Done! The video is ready.");
        if (change) fixture.qa.bump();
      }
      return "completed" as const;
    },
  };
}

describe("the Director's reply before render QA", () => {
  it("ends the first prompt with the interim instruction and marks the pre-QA text, not the final report", async () => {
    const fixture = await createRuntimeFixture();
    try {
      const chatId = await qaChat(fixture, quality(2));
      fixture.qa.checkResults = [
        cleanCheck({ issues: [qaDraft({ subject: "c2" })] }),
        cleanCheck(),
      ];
      const director = chattyDirector(fixture);
      script(fixture, { director: director.run, vision: visionScript([]) });
      await fixture.turns.start(chatId, { prompt: "Tighten the intro" });
      await settled(fixture, chatId);

      expect(director.prompts).toHaveLength(3);
      expect(director.prompts[0]?.trimEnd().endsWith(PENDING)).toBe(true);
      expect(director.prompts[0]).toContain("NOT say or imply");
      expect(director.prompts[1]).not.toContain("render-qa-pending");
      expect(director.prompts[2]).not.toContain("render-qa-pending");
      expect(director.prompts[2]).toContain("This is your final answer to the user");

      // The correction reply ("Fixing the gap.") is progress too: only the final report answers the user.
      expect(replyParts(fixture, chatId)).toEqual([
        { text: "Done! The video is ready.", interim: true },
        { text: "Fixing the gap.", interim: true },
        { text: "Final report.", interim: false },
      ]);
      // Marked when QA started — after the text, before the first render — and again before the final report.
      const events = fixture.chats.events(chatId);
      const marks = interimEvents(fixture, chatId);
      expect(marks).toHaveLength(2);
      const markIndex = events.findIndex((event) => event.type === "assistant.parts.interim");
      const firstPass = events.findIndex(
        (event) => event.type === "qa.updated" && event.qa.passes.length > 0,
      );
      expect(markIndex).toBeGreaterThan(-1);
      expect(markIndex).toBeLessThan(firstPass);

      // The durable log reads back to the same reply.
      const loaded = await fixture.store.load(chatId);
      const stored = loaded.state?.messages.find(
        (message) => message.role === "assistant" && !message.runId,
      );
      expect(
        stored?.role === "assistant"
          ? stored.parts.flatMap((part) => (part.type === "text" ? [part.interim === true] : []))
          : [],
      ).toEqual([true, true, false]);
    } finally {
      await fixture.cleanup();
    }
  });

  it("adds the instruction to the follow-up prompts before QA, not to the ones after", async () => {
    const fixture = await createRuntimeFixture();
    try {
      const chatId = await qaChat(fixture, quality(1), ["editor", "vision"]);
      const prompts: string[] = [];
      script(fixture, {
        director: async (input, session) => {
          prompts.push(input.text);
          if (input.text.includes("<render-qa-final")) say(input, "Final report.");
          else if (session.prompts.length === 1) {
            await session.callTool("delegate", { agent: "editor", title: "Trim", task: "Trim" });
            fixture.qa.bump();
            say(input, "Started the editor.");
          } else say(input, "Trimmed, all done!");
          return "completed";
        },
        editor: async (input) => {
          say(input, "Trimmed to 3 s.");
          return "completed";
        },
        vision: visionScript([]),
      });
      await fixture.turns.start(chatId, { prompt: "Trim" });
      await settled(fixture, chatId);

      expect(prompts).toHaveLength(3);
      expect(prompts[1]).toContain("<delegated-results>");
      expect(prompts[1]?.trimEnd().endsWith(PENDING)).toBe(true);
      expect(prompts[2]).toContain("<render-qa-final");
      expect(prompts[2]).not.toContain("render-qa-pending");
      expect(replyParts(fixture, chatId)).toEqual([
        { text: "Started the editor.", interim: true },
        { text: "Trimmed, all done!", interim: true },
        { text: "Final report.", interim: false },
      ]);
    } finally {
      await fixture.cleanup();
    }
  });

  it("leaves a turn that only answered untouched: nothing was attempted, so nothing is closed", async () => {
    const fixture = await createRuntimeFixture();
    try {
      const chatId = await qaChat(fixture, quality(2));
      const director = chattyDirector(fixture, false);
      script(fixture, { director: director.run });
      await fixture.turns.start(chatId, { prompt: "What is in the project?" });
      await settled(fixture, chatId);

      // QA applies to the turn, so the Director was told a check follows; it never started, so nothing is marked.
      expect(director.prompts[0]?.trimEnd().endsWith(PENDING)).toBe(true);
      expect(director.prompts).toHaveLength(1);
      expect(fixture.chats.get(chatId)?.turns[0]?.qa).toBeUndefined();
      expect(replyParts(fixture, chatId)).toEqual([
        { text: "Done! The video is ready.", interim: false },
      ]);
      expect(interimEvents(fixture, chatId)).toEqual([]);
    } finally {
      await fixture.cleanup();
    }
  });

  it("asks for a closing answer, and marks the reply before it interim, when an edit did not change the project", async () => {
    const fixture = await createRuntimeFixture();
    try {
      // Without an Editor the Director edits itself; the edit is refused, so the project stays as it was.
      const chatId = await qaChat(fixture, quality(2), ["vision"]);
      const prompts: string[] = [];
      script(fixture, {
        director: async (input, session) => {
          prompts.push(input.text);
          if (input.text.includes("<render-qa-skipped")) {
            say(input, "Nothing changed: the edit was refused.");
          } else {
            await session.callTool("edit_timeline", { operations: [] });
            say(input, "Done! The video is ready.");
          }
          return "completed";
        },
      });
      await fixture.turns.start(chatId, { prompt: "Tighten the intro" });
      await settled(fixture, chatId);

      // The Director was told a check follows; nothing changed, so none will. Its reply may have promised one (or
      // reported an edit that did not land): it answers once more.
      expect(prompts).toHaveLength(2);
      expect(prompts[1]).toContain("<render-qa-skipped>");
      expect(prompts[1]).toContain("Nothing in the project changed");
      expect(fixture.chats.get(chatId)?.turns[0]?.qa).toBeUndefined();
      expect(replyParts(fixture, chatId)).toEqual([
        { text: "Done! The video is ready.", interim: true },
        { text: "Nothing changed: the edit was refused.", interim: false },
      ]);
    } finally {
      await fixture.cleanup();
    }
  });

  it("asks for the final answer when QA is skipped after the project changed (QA cannot tell what changed)", async () => {
    const fixture = await createRuntimeFixture();
    try {
      const chatId = await qaChat(fixture, quality(2));
      const director = chattyDirector(fixture);
      script(fixture, {
        director: async (input, session) => {
          const outcome = await director.run(input);
          // Studio's QA service goes away after the Director's work.
          if (session.prompts.length === 1)
            fixture.qa.stateError = new QaToolError("studio_unavailable", "Studio is down");
          return outcome;
        },
      });
      await fixture.turns.start(chatId, { prompt: "Tighten the talk" });
      await settled(fixture, chatId);

      expect(fixture.chats.get(chatId)?.turns[0]?.qa).toMatchObject({ status: "skipped" });
      // The reply promised a check that is not coming: it is interim, and the real answer follows.
      expect(director.prompts.at(-1)).toContain("<render-qa-skipped>");
      expect(director.prompts.at(-1)).toContain("Studio is down");
      expect(replyParts(fixture, chatId)).toEqual([
        { text: "Done! The video is ready.", interim: true },
        { text: "Built, but not rendered or checked.", interim: false },
      ]);
      expect(fixture.editing.renderRequests).toEqual([]);
    } finally {
      await fixture.cleanup();
    }
  });

  it("checks a composition too long to render unasked on the timeline alone, and the final report says so", async () => {
    const fixture = await createRuntimeFixture();
    try {
      fixture.editing.timelineResult = {
        ...fixture.editing.timelineResult,
        composition: { path: "index.html", width: 1920, height: 1080, duration: 400 },
      };
      const chatId = await qaChat(fixture, quality(2));
      const director = chattyDirector(fixture);
      script(fixture, { director: director.run });
      await fixture.turns.start(chatId, { prompt: "Tighten the talk" });
      await settled(fixture, chatId);

      expect(fixture.chats.get(chatId)?.turns[0]?.qa).toMatchObject({
        status: "passed",
        scope: "timeline",
        passes: [{ scope: "timeline", scopeNote: { code: "too_long", params: { minutes: 6.7 } } }],
      });
      expect(fixture.editing.renderRequests).toEqual([]);
      expect(fixture.qa.checkRequests).toEqual([]);
      expect(fixture.qa.timelineCheckRequests).toHaveLength(1);
      expect(director.prompts.at(-1)).toContain("<render-qa-final");
      expect(director.prompts.at(-1)).toContain("TIMELINE only");
      expect(director.prompts.at(-1)).toContain("6.7 minutes long");
      expect(replyParts(fixture, chatId)).toEqual([
        { text: "Done! The video is ready.", interim: true },
        { text: "Final report.", interim: false },
      ]);
    } finally {
      await fixture.cleanup();
    }
  });

  it("adds no instruction and marks nothing when QA cannot apply", async () => {
    const fixture = await createRuntimeFixture();
    try {
      // Render QA off.
      const off = await qaChat(fixture, quality(0));
      const offDirector = chattyDirector(fixture);
      script(fixture, { director: offDirector.run });
      await fixture.turns.start(off, { prompt: "Change something" });
      await settled(fixture, off);
      expect(offDirector.prompts[0]).not.toContain("render-qa-pending");
      expect(replyParts(fixture, off)).toEqual([
        { text: "Done! The video is ready.", interim: false },
      ]);
      expect(interimEvents(fixture, off)).toEqual([]);

      // A story turn QA never runs in.
      const story = await qaChat(fixture, quality(2));
      const storyDirector = chattyDirector(fixture);
      script(fixture, { director: storyDirector.run });
      await fixture.turns.start(story, { prompt: "Review the story", storyAction: "review" });
      await settled(fixture, story);
      expect(storyDirector.prompts[0]).not.toContain("render-qa-pending");
      expect(interimEvents(fixture, story)).toEqual([]);
    } finally {
      await fixture.cleanup();
    }
  });
});
