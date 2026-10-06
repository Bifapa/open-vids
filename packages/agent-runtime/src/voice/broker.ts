import { randomUUID } from "node:crypto";
import type {
  AgentId,
  AnswerVoicePilotRequest,
  AnswerVoiceSetupRequest,
  VoicePilotRequest,
  VoicePreset,
  VoiceSetupRequest,
} from "@hyperframes/agent-protocol";
import { RuntimeError, errorMessage } from "../errors.js";

/** What a card needs to wait for the user: an id, a state it leaves once answered, and when it was answered. */
interface Card {
  id: string;
  state: string;
  answeredAt?: number;
}

interface Entry<T extends Card> {
  card: T;
  waiters: Array<(card: T) => void>;
}

/**
 * The cards of one kind a turn shows and waits on, with the rules the question broker has: no timer of its own (the
 * end of the turn expires what is pending), the asking call's own signal expires its card alone, an answer counts
 * whether or not the chat could show it.
 */
class Cards<T extends Card> {
  private readonly entries = new Map<string, Entry<T>>();
  private closed = false;

  constructor(
    private readonly label: string,
    private readonly publish: (card: T) => Promise<void>,
    private readonly expired: (card: T, at: number) => T,
    private readonly now: () => number,
  ) {}

  /** Publishes `card` and resolves with it once answered or expired. */
  async open(card: T, signal?: AbortSignal): Promise<T> {
    signal?.throwIfAborted();
    if (this.closed) return this.expired(card, this.now());
    const entry: Entry<T> = { card, waiters: [] };
    this.entries.set(card.id, entry);
    const waiter = new Promise<T>((resolve) => entry.waiters.push(resolve));
    try {
      await this.publish(card);
    } catch (error) {
      this.entries.delete(card.id);
      this.settle(entry, this.expired(card, this.now()));
      throw new RuntimeError(
        "runtime_unavailable",
        errorMessage(error, `The ${this.label} could not be shown in the chat`),
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

  /** The entry an answer applies to: unknown is `invalid_request`, one no longer pending `turn_not_active`. */
  pending(id: string): Entry<T> {
    const entry = this.entries.get(id);
    if (!entry)
      throw new RuntimeError("invalid_request", `This turn has no such ${this.label}`, 400);
    if (entry.card.state !== "pending")
      throw new RuntimeError("turn_not_active", `This ${this.label} is no longer pending`, 409);
    return entry;
  }

  /** Records the answer, shows it and returns the waiting call with it. */
  async answer(entry: Entry<T>, updated: T): Promise<T> {
    entry.card = updated;
    try {
      await this.publish(updated);
    } finally {
      // The answer counts whether or not the chat could show it: the waiting call must not hang on a failed append.
      this.settle(entry, updated);
    }
    return updated;
  }

  async expireAll(): Promise<void> {
    this.closed = true;
    for (const entry of [...this.entries.values()]) await this.expire(entry);
  }

  private async expire(entry: Entry<T>): Promise<void> {
    if (entry.card.state !== "pending") return;
    const updated = this.expired(entry.card, this.now());
    entry.card = updated;
    await this.publish(updated).catch(() => undefined);
    this.settle(entry, updated);
  }

  private settle(entry: Entry<T>, card: T): void {
    for (const resolve of entry.waiters.splice(0)) resolve(card);
  }
}

export interface VoiceBrokerOptions {
  /** Whether a saved preset of this id exists (the host's `getPreset`): an answer naming another is refused. */
  getPreset: (id: string, signal: AbortSignal) => Promise<VoicePreset | null>;
  /** Appends or updates the setup card's part in the main conversation's message and streams it to the chat. */
  publishSetup: (setup: VoiceSetupRequest) => Promise<void>;
  /** Same for the pilot card. */
  publishPilot: (pilot: VoicePilotRequest) => Promise<void>;
  /** The turn's signal: stopping the turn expires what is pending, so waiting calls return. */
  signal?: AbortSignal;
  now?: () => number;
  ids?: () => string;
}

/** What a setup card is opened with: the agent's own words (the runtime fills the rest). */
export interface VoiceSetupAsk {
  agent: AgentId;
  language: string | null;
  sampleText: string;
  suggestion: string;
}

/** What a pilot card is opened with: the take to listen to and what is left after it. */
export type VoicePilotAsk = Pick<
  VoicePilotRequest,
  "agent" | "lineId" | "text" | "file" | "start" | "end" | "remainingLines" | "remainingUsdCost"
>;

/**
 * The two cards of the voiceover flow, cloned from the question broker with a structured answer. A voice-setup card
 * waits for a saved preset (or "Not now"); a pilot card waits for the verdict on the first generated line. Like
 * questions, neither has a timer: the end of the turn (finish, Stop, failure) expires what is still pending, so no call
 * hangs. A setup answer names a preset the host must know — anything else is refused without touching the card, so the
 * user can pick again.
 */
export class VoiceBroker {
  private readonly setups: Cards<VoiceSetupRequest>;
  private readonly pilots: Cards<VoicePilotRequest>;
  private readonly now: () => number;
  private readonly ids: () => string;
  private readonly signal: AbortSignal;

  constructor(private readonly options: VoiceBrokerOptions) {
    this.now = options.now ?? Date.now;
    this.ids = options.ids ?? randomUUID;
    this.signal = options.signal ?? new AbortController().signal;
    this.setups = new Cards(
      "voice setup",
      options.publishSetup,
      (setup, at) => ({ ...setup, state: "expired", answeredAt: at }),
      this.now,
    );
    this.pilots = new Cards(
      "voice pilot",
      options.publishPilot,
      (pilot, at) => ({ ...pilot, state: "expired", answeredAt: at }),
      this.now,
    );
    options.signal?.addEventListener("abort", () => void this.expireAll(), { once: true });
  }

  /** Shows the setup card and resolves with it once the user answered or the card expired. */
  askSetup(input: VoiceSetupAsk, signal?: AbortSignal): Promise<VoiceSetupRequest> {
    return this.setups.open(
      { id: this.ids(), ...input, state: "pending", requestedAt: this.now() },
      signal,
    );
  }

  /**
   * The user's answer to a setup card: a saved preset (`presetId` must exist) or a decline. An unknown card is
   * `invalid_request`, one no longer pending `turn_not_active`, an unknown preset `invalid_request` (the card stays
   * pending).
   */
  async answerSetup(id: string, answer: AnswerVoiceSetupRequest): Promise<VoiceSetupRequest> {
    const entry = this.setups.pending(id);
    if ("decline" in answer)
      return this.setups.answer(entry, {
        ...entry.card,
        state: "declined",
        answeredAt: this.now(),
      });
    const preset = await this.options
      .getPreset(answer.presetId, this.signal)
      .catch((error: unknown) => {
        throw new RuntimeError(
          "runtime_unavailable",
          errorMessage(error, "Studio could not look up the voice preset"),
          503,
        );
      });
    if (!preset) throw new RuntimeError("invalid_request", "This voice preset does not exist", 400);
    // The preset lookup yielded: the card may have expired or been answered meanwhile.
    this.setups.pending(id);
    return this.setups.answer(entry, {
      ...entry.card,
      state: "answered",
      presetId: preset.id,
      presetName: preset.name,
      answeredAt: this.now(),
    });
  }

  /** Shows the pilot card and resolves with it once the user answered or the card expired. */
  askPilot(input: VoicePilotAsk, signal?: AbortSignal): Promise<VoicePilotRequest> {
    return this.pilots.open(
      { id: this.ids(), ...input, state: "pending", requestedAt: this.now() },
      signal,
    );
  }

  /** The user's verdict on the pilot line: continue with the rest, or change it with a note for the agent. */
  async answerPilot(id: string, answer: AnswerVoicePilotRequest): Promise<VoicePilotRequest> {
    const entry = this.pilots.pending(id);
    return this.pilots.answer(
      entry,
      answer.decision === "approve"
        ? { ...entry.card, state: "approved", answeredAt: this.now() }
        : {
            ...entry.card,
            state: "changes",
            feedback: answer.feedback,
            answeredAt: this.now(),
          },
    );
  }

  /** The turn ended: every pending card becomes expired and its waiting call returns. Safe to repeat. */
  async expireAll(): Promise<void> {
    await this.setups.expireAll();
    await this.pilots.expireAll();
  }
}
