import { describe, expect, it } from "vitest";
import type { ChatMessage, QuestionRequest } from "@hyperframes/agent-protocol";
import { qaChat, quality, script, settled } from "../qa/harness.js";
import { researchPolicy } from "../testing/research.js";
import { createRuntimeFixture, waitUntil, type RuntimeFixture } from "../testing/runtimeFixture.js";

async function finishTurn(fixture: RuntimeFixture, chatId: string): Promise<void> {
  await waitUntil(() => {
    const last = fixture.chats.get(chatId)?.turns.at(-1);
    return last !== undefined && last.status !== "running";
  }, "turn completion");
}

const textOf = (message: ChatMessage | undefined): string =>
  message?.parts.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("") ?? "";

/** Holds the turn's setup at the research policy read until the returned function is called. */
function holdSetup(fixture: RuntimeFixture): () => void {
  const gate = Promise.withResolvers<void>();
  fixture.research.policy = async () => {
    await gate.promise;
    return researchPolicy();
  };
  return () => gate.resolve();
}

/** The first Director prompt of the turn that carried `userText`. */
function firstPromptWith(fixture: RuntimeFixture, userText: string): string {
  const session = fixture.backend.sessionsOf("director").at(-1);
  return session?.prompts.find((prompt) => prompt.text.includes(userText))?.text ?? "";
}

describe("steering", () => {
  it("queues steering sent while the turn is still being set up and opens the first prompt with it", async () => {
    const fixture = await createRuntimeFixture();
    try {
      const chat = await fixture.chats.create({}, []);
      const release = holdSetup(fixture);
      fixture.backend.promptScript = async () => "completed";
      const turn = await fixture.turns.start(chat.id, { prompt: "Tighten the intro" });
      // Not rejected as turn_not_active and not waiting for the model: answered at once.
      const messageId = await fixture.turns.steer(chat.id, turn.id, { text: "Keep the logo" });
      expect(messageId).toBeTruthy();
      expect(fixture.backend.sessionsOf("director")).toHaveLength(0);
      release();
      await finishTurn(fixture, chat.id);

      const session = fixture.backend.sessionsOf("director").at(-1);
      expect(session?.steering).toEqual([]);
      const prompt = firstPromptWith(fixture, "Tighten the intro");
      expect(prompt).toContain("<user-steering>\nKeep the logo");
      expect(fixture.chats.get(chat.id)?.turns.at(-1)?.status).toBe("completed");
    } finally {
      await fixture.cleanup();
    }
  });

  it("queues steering the model refuses for the next prompt instead of failing the turn", async () => {
    const fixture = await createRuntimeFixture();
    try {
      const chat = await fixture.chats.create({}, []);
      const insidePrompt = Promise.withResolvers<void>();
      const finishPrompt = Promise.withResolvers<void>();
      fixture.backend.steerError = new Error("the provider dropped the stream");
      fixture.backend.promptScript = async (input) => {
        if (input.text.includes("Tighten the intro")) {
          insidePrompt.resolve();
          await finishPrompt.promise;
        }
        return "completed";
      };
      const turn = await fixture.turns.start(chat.id, { prompt: "Tighten the intro" });
      await insidePrompt.promise;
      await expect(
        fixture.turns.steer(chat.id, turn.id, { text: "Use the blue title" }),
      ).resolves.toBeTruthy();
      finishPrompt.resolve();
      await finishTurn(fixture, chat.id);

      expect(fixture.chats.get(chat.id)?.turns.at(-1)?.status).toBe("completed");
      const prompts = fixture.backend.sessionsOf("director").at(-1)?.prompts ?? [];
      expect(
        prompts.some((prompt) => prompt.text.includes("<user-steering>\nUse the blue title")),
      ).toBe(true);
    } finally {
      await fixture.cleanup();
    }
  });
});

describe("Stop during setup", () => {
  it("ends the turn before the Director's session is opened", async () => {
    const fixture = await createRuntimeFixture();
    try {
      const chat = await fixture.chats.create({}, []);
      const release = holdSetup(fixture);
      fixture.backend.promptScript = async () => "completed";
      const turn = await fixture.turns.start(chat.id, { prompt: "Tighten the intro" });
      fixture.turns.abort(chat.id, turn.id);
      release();
      await finishTurn(fixture, chat.id);
      expect(fixture.chats.get(chat.id)?.turns.at(-1)?.status).toBe("aborted");
      expect(fixture.backend.sessionsOf("director")).toHaveLength(0);
      expect(fixture.turns.activeTurn).toBeNull();
    } finally {
      await fixture.cleanup();
    }
  });
});

describe("work left over when the follow-up cap is reached", () => {
  it("tells the user which delegated runs were stopped when the turn ended", async () => {
    // No render QA here: its closing prompt would wait on the run that never ends.
    const fixture = await createRuntimeFixture({ qa: undefined, stopGraceMs: 50 });
    try {
      const chatId = (await fixture.chats.create({}, ["editor"])).id;
      let delegations = 0;
      script(fixture, {
        director: async (input, session) => {
          if (input.text.includes("<render-qa")) return "completed";
          // Every prompt starts one more task and ends without collecting it; the fourth never finishes.
          delegations += 1;
          await session.callTool("delegate", {
            agent: "editor",
            title: `Task ${delegations}`,
            task: input.text.slice(0, 20),
          });
          return "completed";
        },
        editor: async (input) => {
          if (delegations < 4) return "completed";
          const aborted = Promise.withResolvers<void>();
          input.signal.addEventListener("abort", () => aborted.resolve(), { once: true });
          await aborted.promise;
          return "aborted";
        },
      });
      await fixture.turns.start(chatId, { prompt: "Tighten the intro" });
      await settled(fixture, chatId);

      const state = fixture.chats.get(chatId);
      expect(state?.turns.at(-1)?.status).toBe("completed");
      const assistant = state?.messages.find((message) => message.role === "assistant");
      expect(textOf(assistant)).toContain("still working when this turn finished");
      expect(textOf(assistant)).toContain('"Task 4"');
    } finally {
      await fixture.cleanup();
    }
  });
});

describe("request_input", () => {
  function questionOf(fixture: RuntimeFixture, chatId: string): QuestionRequest | null {
    const message = fixture.chats.get(chatId)?.messages.find((entry) => entry.role === "assistant");
    const part = message?.parts.find((entry) => entry.type === "question");
    return part?.type === "question" ? part.question : null;
  }

  it("waits for the user's answer and hands it to the model", async () => {
    const fixture = await createRuntimeFixture();
    try {
      const chat = await fixture.chats.create({}, []);
      let answer = "";
      fixture.backend.promptScript = async (input, session) => {
        if (!input.text.includes("Cut it")) return "completed";
        answer = (
          await session.callTool("request_input", {
            question: "Keep the long take or the short one?",
            options: ["Long", "Short", "Long"],
          })
        ).text;
        return "completed";
      };
      const turn = await fixture.turns.start(chat.id, { prompt: "Cut it" });
      await waitUntil(() => questionOf(fixture, chat.id)?.state === "pending", "the question");
      const asked = questionOf(fixture, chat.id);
      expect(asked).toMatchObject({
        agent: "director",
        text: "Keep the long take or the short one?",
        options: ["Long", "Short"],
      });
      const response = await fixture.turns.answerQuestion(
        chat.id,
        turn.id,
        asked?.id ?? "",
        "Short",
      );
      expect(response.question).toMatchObject({ state: "answered", answer: "Short" });
      await finishTurn(fixture, chat.id);
      expect(answer).toBe("The user answered: Short");
      // A second answer, or one for a question that does not exist, is refused.
      await expect(
        fixture.turns.answerQuestion(chat.id, turn.id, asked?.id ?? "", "Long"),
      ).rejects.toMatchObject({ code: "turn_not_active" });
    } finally {
      await fixture.cleanup();
    }
  });

  it("expires an unanswered question when the turn is stopped, and the call returns", async () => {
    const fixture = await createRuntimeFixture();
    try {
      const chat = await fixture.chats.create({}, []);
      let result = { text: "", isError: false };
      fixture.backend.promptScript = async (input, session) => {
        if (!input.text.includes("Cut it")) return "completed";
        const call = await session.callTool("request_input", { question: "Which one?" });
        result = { text: call.text, isError: call.isError === true };
        return "completed";
      };
      const turn = await fixture.turns.start(chat.id, { prompt: "Cut it" });
      await waitUntil(() => questionOf(fixture, chat.id)?.state === "pending", "the question");
      fixture.turns.abort(chat.id, turn.id);
      await finishTurn(fixture, chat.id);
      expect(questionOf(fixture, chat.id)?.state).toBe("expired");
      expect(result.isError).toBe(true);
      expect(result.text).toContain("did not answer");
      await expect(
        fixture.turns.answerQuestion(chat.id, turn.id, questionOf(fixture, chat.id)?.id ?? "", "x"),
      ).rejects.toMatchObject({ code: "turn_not_active" });
    } finally {
      await fixture.cleanup();
    }
  });

  it("lets a specialist ask, attributing the question to it", async () => {
    const fixture = await createRuntimeFixture();
    try {
      const chatId = await qaChat(fixture, quality(0), ["editor"]);
      let editorAnswer = "";
      script(fixture, {
        director: async (input, session) => {
          if (!input.text.includes("Cut it")) return "completed";
          await session.callTool("delegate", { agent: "editor", title: "Cut", task: "cut it" });
          await session.callTool("wait_for_agents", {});
          return "completed";
        },
        editor: async (_input, session) => {
          editorAnswer = (await session.callTool("request_input", { question: "Which take?" }))
            .text;
          return "completed";
        },
      });
      const turn = await fixture.turns.start(chatId, { prompt: "Cut it" });
      await waitUntil(() => questionOf(fixture, chatId)?.state === "pending", "the question");
      expect(questionOf(fixture, chatId)?.agent).toBe("editor");
      await fixture.turns.answerQuestion(
        chatId,
        turn.id,
        questionOf(fixture, chatId)?.id ?? "",
        "Take 2",
      );
      await settled(fixture, chatId);
      expect(editorAnswer).toBe("The user answered: Take 2");
    } finally {
      await fixture.cleanup();
    }
  });

  it("expires the question of a run the user cancels, and the call returns while the turn goes on", async () => {
    const fixture = await createRuntimeFixture();
    try {
      const chatId = await qaChat(fixture, quality(0), ["editor"]);
      let editorResult = { text: "", isError: false };
      script(fixture, {
        director: async (input, session) => {
          if (!input.text.includes("Cut it")) return "completed";
          await session.callTool("delegate", { agent: "editor", title: "Cut", task: "cut it" });
          await session.callTool("wait_for_agents", {});
          return "completed";
        },
        editor: async (input, session) => {
          // A real harness hands the tool call the signal of the prompt it belongs to.
          const call = await session.callTool(
            "request_input",
            { question: "Which take?" },
            input.signal,
          );
          editorResult = { text: call.text, isError: call.isError === true };
          return "completed";
        },
      });
      const turn = await fixture.turns.start(chatId, { prompt: "Cut it" });
      await waitUntil(() => questionOf(fixture, chatId)?.state === "pending", "the question");
      const runId = fixture.chats.get(chatId)?.runs[0]?.id ?? "";
      await fixture.turns.cancelRun(chatId, turn.id, runId);
      expect(questionOf(fixture, chatId)?.state).toBe("expired");
      await settled(fixture, chatId);
      expect(editorResult.isError).toBe(true);
      expect(editorResult.text).toContain("did not answer");
      expect(fixture.chats.get(chatId)?.turns[0]?.status).toBe("completed");
    } finally {
      await fixture.cleanup();
    }
  });
});

describe("the long-render card of a cancelled run", () => {
  it("is expired and its render call returns, while the turn goes on", async () => {
    const fixture = await createRuntimeFixture();
    try {
      fixture.editing.timelineResult = {
        ...fixture.editing.timelineResult,
        composition: { path: "index.html", width: 1920, height: 1080, duration: 1_200 },
      };
      const chatId = await qaChat(fixture, quality(0), ["editor"]);
      const cardOf = () =>
        (fixture.chats.get(chatId)?.messages ?? [])
          .flatMap((message) => (message.role === "assistant" ? message.parts : []))
          .flatMap((part) => (part.type === "permission" ? [part.permission] : []))[0];
      let rendered = { text: "", isError: false };
      script(fixture, {
        director: async (input, session) => {
          if (!input.text.includes("Cut it")) return "completed";
          await session.callTool("delegate", { agent: "editor", title: "Cut", task: "cut it" });
          await session.callTool("wait_for_agents", {});
          return "completed";
        },
        editor: async (input, session) => {
          const call = await session.callTool("render_video", {}, input.signal);
          rendered = { text: call.text, isError: call.isError === true };
          return "completed";
        },
      });
      const turn = await fixture.turns.start(chatId, { prompt: "Cut it" });
      await waitUntil(() => cardOf()?.state === "pending", "the long render card");
      expect(cardOf()).toMatchObject({ kind: "long_render", agent: "editor" });
      await fixture.turns.cancelRun(chatId, turn.id, fixture.chats.get(chatId)?.runs[0]?.id ?? "");
      expect(cardOf()?.state).toBe("expired");
      await settled(fixture, chatId);
      expect(rendered.isError).toBe(true);
      expect(fixture.editing.renderRequests).toEqual([]);
      expect(fixture.chats.get(chatId)?.turns[0]?.status).toBe("completed");
    } finally {
      await fixture.cleanup();
    }
  });
});

describe("turn change summary", () => {
  it("counts what the turn's tools applied, by kind, and leaves refused and dry-run calls out", async () => {
    const fixture = await createRuntimeFixture();
    try {
      const chat = await fixture.chats.create({}, []);
      fixture.backend.promptScript = async (input, session) => {
        if (!input.text.includes("Build it")) return "completed";
        await session.callTool("edit_timeline", {
          operations: [
            { op: "add_clip", asset: "assets/a.mp4", start: 0, track: 0 },
            { op: "add_clip", asset: "assets/b.mp4", start: 4, track: 0 },
            { op: "set_canvas", width: 1080, height: 1920 },
          ],
        });
        await session.callTool("edit_timeline", {
          operations: [{ op: "remove_clip", clip: "c1" }],
          dryRun: true,
        });
        // A refused batch (no such operation) changes nothing.
        await session.callTool("edit_timeline", { operations: [{ op: "no_such_op" }] });
        return "completed";
      };
      await fixture.turns.start(chat.id, { prompt: "Build it" });
      await finishTurn(fixture, chat.id);
      const turn = fixture.chats.get(chat.id)?.turns.at(-1);
      expect(turn?.changes).toEqual([
        { kind: "add_clip", count: 2 },
        { kind: "canvas", count: 1 },
      ]);
    } finally {
      await fixture.cleanup();
    }
  });

  it("reports no changes for a turn that only read", async () => {
    const fixture = await createRuntimeFixture();
    try {
      const chat = await fixture.chats.create({}, []);
      fixture.backend.promptScript = async (_input, session) => {
        await session.callTool("inspect_timeline", {});
        return "completed";
      };
      await fixture.turns.start(chat.id, { prompt: "What is on the timeline?" });
      await finishTurn(fixture, chat.id);
      expect(fixture.chats.get(chat.id)?.turns.at(-1)?.changes).toBeUndefined();
    } finally {
      await fixture.cleanup();
    }
  });
});

describe("stable Director session", () => {
  it("keeps one session across Ask and Edit turns and reopens it when the project's context files change", async () => {
    const fixture = await createRuntimeFixture({ sessionIdleMs: 60_000 });
    try {
      const chat = await fixture.chats.create({}, []);
      fixture.backend.promptScript = async () => "completed";
      await fixture.turns.start(chat.id, { prompt: "Tighten the intro" });
      await finishTurn(fixture, chat.id);
      await fixture.turns.start(chat.id, { prompt: "What is at 0:12?", intent: "ask" });
      await finishTurn(fixture, chat.id);
      await fixture.turns.start(chat.id, { prompt: "Tighten the outro" });
      await finishTurn(fixture, chat.id);
      expect(fixture.backend.sessionsOf("director")).toHaveLength(1);

      fixture.backend.contextHashValue = "context-2";
      await fixture.turns.start(chat.id, { prompt: "Tighten it once more" });
      await finishTurn(fixture, chat.id);
      expect(fixture.backend.sessionsOf("director")).toHaveLength(2);
      expect(fixture.backend.sessionsOf("director")[0]?.disposed).toBe(true);
    } finally {
      await fixture.cleanup();
    }
  });
});
