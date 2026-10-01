import type {
  QaCheckRequest,
  QaCheckResponse,
  QaFramesRequest,
  QaFramesResponse,
  QaFinishRequest,
  QaFinishResponse,
  QaIssueDraft,
  QaReport,
  QaReportInput,
  QaStateResponse,
} from "@hyperframes/agent-protocol";
import { qaCounts } from "@hyperframes/agent-protocol";
import { QaToolError, type QaHost } from "../qa/host.js";
import { FAKE_JPEG } from "./analysis.js";

/** A clean check of a render: every check ran, no issues, three frames to look at. */
export function cleanCheck(overrides: Partial<QaCheckResponse> = {}): QaCheckResponse {
  return {
    fingerprint: "fp-check",
    composition: "index.html",
    timelineVersion: "v1",
    duration: 12,
    checks: [
      { id: "render", status: "ran", detail: null },
      { id: "black_frames", status: "ran", detail: null },
      { id: "frozen_frames", status: "ran", detail: null },
      { id: "audio", status: "ran", detail: null },
      { id: "timeline", status: "ran", detail: null },
      { id: "layout", status: "ran", detail: null },
    ],
    issues: [],
    samples: [
      { time: 1, reason: "cut", context: "track 0 video assets/talk.mp4 (clip c1)" },
      { time: 5, reason: "broll", context: "track 1 video assets/city.mp4 (clip c2)" },
      { time: 9, reason: "coverage", context: "track 0 video assets/talk.mp4 (clip c3)" },
    ],
    ...overrides,
  };
}

/** A deterministic issue as the service reports it. */
export function qaDraft(overrides: Partial<QaIssueDraft> = {}): QaIssueDraft {
  return {
    kind: "black_frames",
    severity: "error",
    source: "render",
    check: "blackdetect",
    start: 4,
    end: 5,
    clipIds: ["c2"],
    subject: null,
    message: "Black picture for 1 s.",
    fixable: true,
    owner: "editor",
    suggestion: "Fill the gap with B-roll or close it.",
    ...overrides,
  };
}

/**
 * Deterministic in-memory QA host for runtime tests and embedding harnesses. The project's `fingerprint` is whatever
 * a test sets (a Director script "changes the project" by assigning a new one); `checkResults` are served in order (the
 * last repeats), each a response, a function of the request and the call number, or an error. Like the real service a
 * check and a frame extraction honour aborts, and can be held open with `checkGate` / `framesGate`.
 */
export class FakeQaHost implements QaHost {
  fingerprint = "fp-0";
  stateError: QaToolError | null = null;
  checkResults: Array<
    | QaCheckResponse
    | QaToolError
    | ((request: QaCheckRequest, call: number) => QaCheckResponse | QaToolError)
  > = [];
  /** While set, `check` records the request and waits for it (or for an abort) before answering. */
  checkGate: Promise<void> | null = null;
  /** While set, `frames` waits for it (or for an abort) before answering. */
  framesGate: Promise<void> | null = null;
  framesError: QaToolError | null = null;
  saveError: QaToolError | null = null;
  /** A failing cleanup (the turn must not notice). */
  finishError: Error | null = null;
  readonly finishRequests: Array<{ sessionId: string; request: QaFinishRequest }> = [];
  /** Whether the signal each `finishSession` call was given was already aborted when the call was made. */
  readonly finishAbortedAtCall: boolean[] = [];
  /** While set, a held `check`/`frames` call that is aborted waits for it before it rejects (a slow cancellation). */
  cancelDelay: Promise<void> | null = null;

  private changes = 0;
  stateCalls = 0;
  readonly checkRequests: QaCheckRequest[] = [];
  readonly frameRequests: QaFramesRequest[] = [];
  readonly reports: QaReport[] = [];
  /** The signal each `check` and `frames` call was given. */
  readonly checkSignals: AbortSignal[] = [];
  checkCancelled = 0;
  framesCancelled = 0;

  /** The project changes: its fingerprint becomes one it never had (`fp-1`, `fp-2`, …). */
  bump(): string {
    this.changes += 1;
    this.fingerprint = `fp-${this.changes}`;
    return this.fingerprint;
  }

  async state(signal: AbortSignal): Promise<QaStateResponse> {
    signal.throwIfAborted();
    this.stateCalls += 1;
    if (this.stateError) throw this.stateError;
    return { fingerprint: this.fingerprint };
  }

  async check(request: QaCheckRequest, signal: AbortSignal): Promise<QaCheckResponse> {
    if (signal.aborted) throw new QaToolError("aborted", "The check was cancelled.");
    this.checkRequests.push(request);
    this.checkSignals.push(signal);
    if (this.checkGate) {
      await this.held(this.checkGate, signal, () => (this.checkCancelled += 1));
    }
    const call = this.checkRequests.length;
    const queued =
      this.checkResults[Math.min(call, this.checkResults.length) - 1] ??
      cleanCheck({ composition: request.composition ?? "index.html" });
    const result = typeof queued === "function" ? queued(request, call) : queued;
    if (result instanceof QaToolError) throw result;
    return structuredClone(result);
  }

  async frames(request: QaFramesRequest, signal: AbortSignal): Promise<QaFramesResponse> {
    if (signal.aborted) throw new QaToolError("aborted", "Extracting frames was cancelled.");
    this.frameRequests.push(request);
    if (this.framesGate) {
      await this.held(this.framesGate, signal, () => (this.framesCancelled += 1));
    }
    if (this.framesError) throw this.framesError;
    return {
      frames: request.times.map((time) => ({
        time,
        mimeType: "image/jpeg",
        data: FAKE_JPEG,
        cached: false,
      })),
    };
  }

  async saveReport(input: QaReportInput, signal: AbortSignal): Promise<QaReport> {
    signal.throwIfAborted();
    if (this.saveError) throw this.saveError;
    const report: QaReport = {
      ...structuredClone(input),
      id: `qa-report-${this.reports.length + 1}`,
      schemaVersion: 1,
      createdAt: 1_700_000_000_000 + this.reports.length,
      counts: qaCounts(input.issues, input.resolved),
      current: input.fingerprint === this.fingerprint,
    };
    this.reports.push(report);
    return structuredClone(report);
  }

  async finishSession(
    sessionId: string,
    request: QaFinishRequest,
    signal: AbortSignal,
  ): Promise<QaFinishResponse> {
    this.finishRequests.push({ sessionId, request: structuredClone(request) });
    this.finishAbortedAtCall.push(signal.aborted);
    if (this.finishError) throw this.finishError;
    return { removedRenders: [], removedReports: 0 };
  }

  private held(gate: Promise<void>, signal: AbortSignal, onCancel: () => void): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      signal.addEventListener(
        "abort",
        () => {
          onCancel();
          void (this.cancelDelay ?? Promise.resolve()).then(() =>
            reject(new QaToolError("aborted", "The operation was cancelled.")),
          );
        },
        { once: true },
      );
      void gate.then(resolve);
    });
  }
}
