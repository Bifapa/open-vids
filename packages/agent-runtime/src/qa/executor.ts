import {
  QA_LIMITS,
  isRecord,
  parseQaIssueDraft,
  sameQaIssue,
  type AgentId,
  type QaAcceptedList,
  type QaCheckRequest,
  type QaCheckResponse,
  type QaFramesResponse,
  type QaFinishRequest,
  type QaFinishResponse,
  type QaIssueDraft,
  type QaReport,
  type QaReportInput,
  type QaSample,
  type QaTimelineCheckRequest,
} from "@hyperframes/agent-protocol";
import type { HostToolResult } from "../backend.js";
import { errorMessage } from "../errors.js";
import { QaToolError, type QaHost } from "./host.js";
import { QA_TOOL_NAMES, isQaToolName, type QaToolName } from "./tools.js";

/** The most findings one review may report. */
const MAX_FINDINGS = 30;
/** Frames are matched to the planned sample they were requested for within this distance, seconds. */
const SAMPLE_MATCH_SECONDS = 0.5;

export interface TurnQaOptions {
  host: QaHost;
  /** The turn's abort signal: aborting the turn aborts every in-flight check, frame extraction and report. */
  turnSignal: AbortSignal;
}

/** What Vision's review of one pass may use. */
export interface QaReviewInput {
  /** Who runs the review: Vision, or the Director when Vision is off in the chat. Only they may use its tools. */
  reviewer: "vision" | "director";
  pass: number;
  /** Project-relative path of the render under review. */
  render: string;
  /** Seconds of the render. */
  duration: number;
  samples: readonly QaSample[];
  /** Most frames Vision may look at in this review (`ExecutionBudget.qaMaxFrames`). */
  maxFrames: number;
  /** Most `inspect_render` calls (`ExecutionBudget.critiqueRounds`). */
  critiqueRounds: number;
}

/** What the review produced, read when it closes. */
export interface QaReviewOutcome {
  findings: QaIssueDraft[];
  /** Vision called `report_render_findings` (an empty list counts: it looked and found nothing). */
  reported: boolean;
  frames: number;
  rounds: number;
}

interface ReviewState extends QaReviewInput {
  framesUsed: number;
  rounds: number;
  findings: QaIssueDraft[];
  reported: boolean;
}

const refuse = (text: string): HostToolResult => ({ text, isError: true });

function argsRecord(args: unknown): Record<string, unknown> {
  if (args === undefined || args === null) return {};
  if (!isRecord(args)) throw new QaToolError("invalid_request", "arguments must be a JSON object");
  return args;
}

const seconds = (value: number): string => `${Number(value.toFixed(1))} s`;

/**
 * The QA service calls and Vision's QA tools of one running turn. Like the other turn executors it tracks its
 * in-flight calls so {@link shutdown} can stop them before the checkpoint closes: after it resolves nothing this
 * executor started is running and no new call is accepted.
 *
 * The tools exist only for Vision and only while a review is open ({@link openReview} … {@link closeReview}): the
 * runtime opens a review for the run it starts itself, with the budget of the turn's Execution Quality, so neither the
 * Director nor Vision can widen it or review on its own.
 */
export class TurnQa {
  private accepting = true;
  private readonly stop = new AbortController();
  private readonly inflight = new Set<Promise<unknown>>();
  private review: ReviewState | null = null;

  constructor(private readonly options: TurnQaOptions) {}

  // ── Service calls (the QA loop) ────────────────────────────────────────────

  /** The project's current fingerprint. */
  async fingerprint(signal?: AbortSignal): Promise<string> {
    return (await this.track(signal, (combined) => this.options.host.state(combined))).fingerprint;
  }

  check(request: QaCheckRequest, signal?: AbortSignal): Promise<QaCheckResponse> {
    return this.track(signal, (combined) => this.options.host.check(request, combined));
  }

  /** The timeline-derived checks alone (no render involved). */
  checkTimeline(request: QaTimelineCheckRequest, signal?: AbortSignal): Promise<QaCheckResponse> {
    return this.track(signal, (combined) => this.options.host.checkTimeline(request, combined));
  }

  /** The issues the user marked intentional in this project. */
  accepted(signal?: AbortSignal): Promise<QaAcceptedList> {
    return this.track(signal, (combined) => this.options.host.accepted(combined));
  }

  saveReport(input: QaReportInput, signal?: AbortSignal): Promise<QaReport> {
    return this.track(signal, (combined) => this.options.host.saveReport(input, combined));
  }

  /**
   * Ends the turn's QA session on the service (deleting its intermediate preview renders). Best-effort and abort-safe:
   * it runs even when the turn was stopped (the turn's signal is deliberately not part of it; only {@link shutdown}
   * and the host's own timeout stop it), and a failure is swallowed: cleanup never fails a turn.
   */
  async finishSession(
    sessionId: string,
    request: QaFinishRequest,
  ): Promise<QaFinishResponse | null> {
    if (!this.accepting) return null;
    const call = this.options.host.finishSession(sessionId, request, this.stop.signal);
    this.inflight.add(call);
    try {
      return await call;
    } catch {
      // the service's retention deletes what this left behind sooner or later
      return null;
    } finally {
      this.inflight.delete(call);
    }
  }

  private track<T>(
    signal: AbortSignal | undefined,
    operation: (combined: AbortSignal) => Promise<T>,
  ): Promise<T> {
    if (!this.accepting)
      return Promise.reject(new QaToolError("aborted", "The turn is finishing; QA is closed."));
    const combined = AbortSignal.any([
      ...(signal ? [signal] : []),
      this.options.turnSignal,
      this.stop.signal,
    ]);
    const call = operation(combined);
    this.inflight.add(call);
    void call.then(
      () => this.inflight.delete(call),
      () => this.inflight.delete(call),
    );
    return call;
  }

  // ── Reviews ────────────────────────────────────────────────────────────────

  /** Opens the review Vision's tools work in. Only one review is open at a time. */
  openReview(input: QaReviewInput): void {
    this.review = { ...input, framesUsed: 0, rounds: 0, findings: [], reported: false };
  }

  /** Closes the review (Vision's tools refuse from now on) and returns what it produced. */
  closeReview(): QaReviewOutcome {
    const review = this.review;
    this.review = null;
    return {
      findings: review?.findings ?? [],
      reported: review?.reported ?? false,
      frames: review?.framesUsed ?? 0,
      rounds: review?.rounds ?? 0,
    };
  }

  // ── Vision's tools ─────────────────────────────────────────────────────────

  execute(
    caller: AgentId,
    name: string,
    args: unknown,
    callSignal: AbortSignal,
  ): Promise<HostToolResult> {
    if (!this.accepting) return Promise.resolve(refuse("The turn is finishing; QA is closed."));
    if (!isQaToolName(name)) return Promise.resolve(refuse(`Unknown QA tool ${name}.`));
    if (caller !== "vision" && caller !== "director")
      return Promise.resolve(refuse(`${name} is not available to you in this turn.`));
    const review = this.review;
    if (!review)
      return Promise.resolve(
        refuse(
          `${name} works only during a Render QA review; there is none in progress, so there is nothing to ${name === QA_TOOL_NAMES.inspect ? "look at" : "report"}.`,
        ),
      );
    if (caller !== review.reviewer)
      return Promise.resolve(refuse(`${name} is not available to you in this turn.`));
    const call = this.track(callSignal, (signal) => this.run(name, args, review, signal)).catch(
      (error: unknown): HostToolResult => {
        if (error instanceof QaToolError) return refuse(`${error.code}: ${error.message}`);
        return refuse(`internal: ${errorMessage(error, "The QA call failed")}`);
      },
    );
    return call;
  }

  /** Stops accepting calls, cancels running ones, and waits for every started call to end. */
  async shutdown(): Promise<void> {
    this.accepting = false;
    this.review = null;
    this.stop.abort();
    await Promise.allSettled([...this.inflight]);
  }

  private async run(
    name: QaToolName,
    args: unknown,
    review: ReviewState,
    signal: AbortSignal,
  ): Promise<HostToolResult> {
    if (name === QA_TOOL_NAMES.inspect) return this.inspect(args, review, signal);
    return this.report(args, review);
  }

  private async inspect(
    args: unknown,
    review: ReviewState,
    signal: AbortSignal,
  ): Promise<HostToolResult> {
    const { times: raw } = argsRecord(args);
    if (!Array.isArray(raw) || raw.length === 0)
      throw new QaToolError("invalid_request", "times must be a non-empty array of seconds");
    const times: number[] = [];
    for (const value of raw) {
      if (typeof value !== "number" || !Number.isFinite(value) || value < 0)
        throw new QaToolError("invalid_request", "every time must be a number of seconds ≥ 0");
      if (value > review.duration + 0.05)
        throw new QaToolError(
          "invalid_request",
          `${seconds(value)} is after the end of the render (${seconds(review.duration)}).`,
        );
      const rounded = Math.round(value * 1000) / 1000;
      if (!times.includes(rounded)) times.push(rounded);
    }
    if (times.length > QA_LIMITS.framesPerRequest)
      throw new QaToolError(
        "invalid_request",
        `at most ${QA_LIMITS.framesPerRequest} frames per call, you asked for ${times.length}.`,
      );
    if (review.rounds >= review.critiqueRounds)
      return refuse(
        `Critique rounds used: ${review.rounds} of ${review.critiqueRounds} (the turn's Execution Quality budget). Report your findings now with report_render_findings.`,
      );
    const left = review.maxFrames - review.framesUsed;
    if (left <= 0)
      return refuse(
        `Frame budget used: ${review.framesUsed} of ${review.maxFrames} frames (the turn's Execution Quality budget). Report your findings now with report_render_findings.`,
      );
    if (times.length > left)
      return refuse(
        `You asked for ${times.length} frames but only ${left} of ${review.maxFrames} remain in this review's budget. Ask for at most ${left}.`,
      );
    // Parallel calls of one message run concurrently: reserve the budget before awaiting so they cannot all pass the
    // checks above. A failed call gives its reservation back.
    review.framesUsed += times.length;
    review.rounds += 1;
    let response: QaFramesResponse;
    try {
      response = await this.options.host.frames({ render: review.render, times }, signal);
    } catch (error) {
      review.framesUsed -= times.length;
      review.rounds -= 1;
      throw error;
    }
    const { frames } = response;
    // The service may return fewer frames than asked for: only the ones Vision actually got count.
    review.framesUsed += frames.length - times.length;
    const rows = frames.map((frame, index) => {
      const sample = review.samples.find(
        (candidate) => Math.abs(candidate.time - frame.time) <= SAMPLE_MATCH_SECONDS,
      );
      return `${index + 1}. ${seconds(frame.time)}${sample ? ` — ${sample.reason}: ${sample.context}` : ""}`;
    });
    return {
      text: `${frames.length} frames of ${review.render}, attached in this order:\n${rows.join("\n")}\nBudget left: ${review.maxFrames - review.framesUsed} frames, ${review.critiqueRounds - review.rounds} rounds.`,
      images: frames.map((frame) => ({ mimeType: frame.mimeType, data: frame.data })),
    };
  }

  private report(args: unknown, review: ReviewState): HostToolResult {
    const { findings: raw } = argsRecord(args);
    if (!Array.isArray(raw))
      throw new QaToolError(
        "invalid_request",
        "findings must be an array (empty when nothing is wrong)",
      );
    const drafts: QaIssueDraft[] = [];
    for (const [index, entry] of raw.entries()) {
      // The caller describes the problem; where it came from is the runtime's to say.
      const parsed = parseQaIssueDraft(
        isRecord(entry) ? { ...entry, source: "vision", check: "vision" } : entry,
        `findings[${index}]`,
      );
      if (!parsed.ok) throw new QaToolError("invalid_request", parsed.message);
      const draft = parsed.value;
      if (draft.end > review.duration + 0.05)
        throw new QaToolError(
          "invalid_request",
          `findings[${index}] ends at ${seconds(draft.end)}, after the end of the render (${seconds(review.duration)}).`,
        );
      if (!drafts.some((known) => sameQaIssue(known, draft))) drafts.push(draft);
    }
    const fresh = drafts.filter(
      (draft) => !review.findings.some((known) => sameQaIssue(known, draft)),
    );
    if (review.findings.length + fresh.length > MAX_FINDINGS)
      throw new QaToolError(
        "invalid_request",
        `at most ${MAX_FINDINGS} findings per review; keep the most important ones.`,
      );
    review.findings.push(...fresh);
    review.reported = true;
    return {
      text:
        review.findings.length === 0
          ? "Recorded: nothing wrong found. The review is complete; finish with one sentence."
          : `Recorded ${fresh.length} ${fresh.length === 1 ? "finding" : "findings"} (${review.findings.length} in total). The review is complete; finish with a one-sentence summary.`,
    };
  }
}
