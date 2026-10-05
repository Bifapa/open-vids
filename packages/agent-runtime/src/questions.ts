import { randomUUID } from "node:crypto";
import type { AgentId, QuestionRequest } from "@hyperframes/agent-protocol";
import { RuntimeError, errorMessage } from "./errors.js";

export interface QuestionBrokerOptions {
  /** Appends or updates the question's part in the main conversation's message and streams it to the chat. */
  publish: (question: QuestionRequest) => Promise<void>;
  /** The turn's signal: stopping the turn expires what is pending, so waiting calls return. */
  signal?: AbortSignal;
  now?: () => number;
  ids?: () => string;
}

interface Entry {
  question: QuestionRequest;
  waiters: Array<(question: QuestionRequest) => void>;
}

/**
 * The questions agents ask the user mid-turn (`request_input`): the call waits here while the chat shows the question
 * with its answer buttons and a free-text field. Like permissions, a question has no timer of its own — the end of the
 * turn (finish, Stop, failure) expires what is still pending, so no call hangs.
 */
export class QuestionBroker {
  private readonly entries = new Map<string, Entry>();
  private readonly now: () => number;
  private readonly ids: () => string;
  private closed = false;

  constructor(private readonly options: QuestionBrokerOptions) {
    this.now = options.now ?? Date.now;
    this.ids = options.ids ?? randomUUID;
    options.signal?.addEventListener("abort", () => void this.expireAll(), { once: true });
  }

  /**
   * Publishes a new question and resolves with it once answered or expired. `signal` is the asking call's own: when it
   * aborts (the run that asked was cancelled) this question alone is expired and the call returns, while the turn and
   * the other questions go on.
   */
  async ask(
    input: { agent: AgentId; text: string; options: string[] },
    signal?: AbortSignal,
  ): Promise<QuestionRequest> {
    signal?.throwIfAborted();
    const question: QuestionRequest = {
      id: this.ids(),
      agent: input.agent,
      text: input.text,
      options: input.options,
      state: "pending",
      requestedAt: this.now(),
    };
    if (this.closed) return { ...question, state: "expired", answeredAt: this.now() };
    const entry: Entry = { question, waiters: [] };
    this.entries.set(question.id, entry);
    const waiter = new Promise<QuestionRequest>((resolve) => entry.waiters.push(resolve));
    try {
      await this.options.publish(question);
    } catch (error) {
      this.entries.delete(question.id);
      this.settle(entry, { ...question, state: "expired", answeredAt: this.now() });
      throw new RuntimeError(
        "runtime_unavailable",
        errorMessage(error, "The question could not be shown in the chat"),
        503,
      );
    }
    if (signal) {
      const expire = () => void this.expire(entry);
      if (signal.aborted) expire();
      else {
        signal.addEventListener("abort", expire, { once: true });
        void waiter.then(() => signal.removeEventListener("abort", expire));
      }
    }
    return waiter;
  }

  /** The user's answer; a question that is unknown is `invalid_request`, one no longer pending `turn_not_active`. */
  async answer(questionId: string, answer: string): Promise<QuestionRequest> {
    const entry = this.entries.get(questionId);
    if (!entry) throw new RuntimeError("invalid_request", "This turn has no such question", 400);
    if (entry.question.state !== "pending")
      throw new RuntimeError("turn_not_active", "This question is no longer pending", 409);
    const updated: QuestionRequest = {
      ...entry.question,
      state: "answered",
      answer,
      answeredAt: this.now(),
    };
    entry.question = updated;
    try {
      await this.options.publish(updated);
    } finally {
      // The answer counts whether or not the chat could show it: the waiting call must not hang on a failed append.
      this.settle(entry, updated);
    }
    return updated;
  }

  /** The turn ended: every pending question becomes expired and its waiting call returns. Safe to repeat. */
  async expireAll(): Promise<void> {
    this.closed = true;
    for (const entry of [...this.entries.values()]) await this.expire(entry);
  }

  /** Expires one question that is still pending and returns its waiting call. */
  private async expire(entry: Entry): Promise<void> {
    if (entry.question.state !== "pending") return;
    const updated: QuestionRequest = {
      ...entry.question,
      state: "expired",
      answeredAt: this.now(),
    };
    entry.question = updated;
    await this.options.publish(updated).catch(() => undefined);
    this.settle(entry, updated);
  }

  private settle(entry: Entry, question: QuestionRequest): void {
    for (const resolve of entry.waiters.splice(0)) resolve(question);
  }
}
