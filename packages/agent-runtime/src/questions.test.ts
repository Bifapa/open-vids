import { describe, expect, it } from "vitest";
import type { QuestionRequest } from "@hyperframes/agent-protocol";
import { QuestionBroker } from "./questions.js";

function broker() {
  const published: QuestionRequest[] = [];
  let id = 0;
  const instance = new QuestionBroker({
    publish: async (question) => {
      published.push(question);
    },
    now: () => 1_700_000_000_000 + published.length,
    ids: () => `q-${++id}`,
  });
  const ask = (text: string, signal?: AbortSignal) =>
    instance.ask({ agent: "vision", text, options: [] }, signal);
  return { published, instance, ask };
}

describe("the question broker", () => {
  it("resolves a question with the user's answer", async () => {
    const { published, instance, ask } = broker();
    const waiting = ask("Which logo?");
    await Promise.resolve();
    expect(published).toMatchObject([{ id: "q-1", state: "pending" }]);
    await instance.answer("q-1", "the blue one");
    await expect(waiting).resolves.toMatchObject({ state: "answered", answer: "the blue one" });
  });

  it("expires only the question whose asking call is cancelled and returns that call", async () => {
    const { published, instance, ask } = broker();
    const cancel = new AbortController();
    const cancelled = ask("Which logo?", cancel.signal);
    const staying = ask("Which music?");
    await Promise.resolve();

    cancel.abort();
    await expect(cancelled).resolves.toMatchObject({ id: "q-1", state: "expired" });
    expect(published.filter((question) => question.state === "expired")).toMatchObject([
      { id: "q-1" },
    ]);
    // The card is no longer answerable, and the other question is untouched.
    await expect(instance.answer("q-1", "late")).rejects.toMatchObject({ status: 409 });
    await instance.answer("q-2", "the jazz one");
    await expect(staying).resolves.toMatchObject({ state: "answered" });
  });

  it("refuses a call that was already cancelled before it asked", async () => {
    const { published, ask } = broker();
    await expect(ask("Which logo?", AbortSignal.abort())).rejects.toThrow();
    expect(published).toEqual([]);
  });

  it("does not let a later abort touch a question that was answered", async () => {
    const { published, instance, ask } = broker();
    const cancel = new AbortController();
    const waiting = ask("Which logo?", cancel.signal);
    await Promise.resolve();
    await instance.answer("q-1", "blue");
    await waiting;
    cancel.abort();
    await Promise.resolve();
    expect(published.map((question) => question.state)).toEqual(["pending", "answered"]);
  });
});
