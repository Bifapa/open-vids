import type {
  QaCheckRequest,
  QaCheckResponse,
  QaErrorCode,
  QaFinishRequest,
  QaFinishResponse,
  QaFramesRequest,
  QaFramesResponse,
  QaReport,
  QaReportInput,
  QaStateResponse,
} from "@hyperframes/agent-protocol";

/**
 * Autonomous render QA as the runtime sees it: the Studio server's QA service (`/api/projects/:id/qa/*`). A host is
 * bound to one project. The service owns everything that needs the project or the render file (the fingerprint,
 * the deterministic checks, frame extraction, the durable reports); the runtime owns the loop and Vision's review.
 * Every call is cancellable through its signal.
 */
export interface QaHost {
  /** The project's current fingerprint (content signature of everything a render depends on). */
  state(signal: AbortSignal): Promise<QaStateResponse>;
  /** Runs the deterministic checks on a finished render and plans the frames Vision should look at. */
  check(request: QaCheckRequest, signal: AbortSignal): Promise<QaCheckResponse>;
  /** Extracts frames of a finished render (at most `QA_LIMITS.framesPerRequest` per call). */
  frames(request: QaFramesRequest, signal: AbortSignal): Promise<QaFramesResponse>;
  /** Stores one pass as a durable report; the service assigns its id. */
  saveReport(input: QaReportInput, signal: AbortSignal): Promise<QaReport>;
  /**
   * Ends the turn's QA session: the service deletes the intermediate preview renders QA made for it (and their
   * frames) except `request.keep`, and applies its report retention. The runtime treats it as best-effort.
   */
  finishSession(
    sessionId: string,
    request: QaFinishRequest,
    signal: AbortSignal,
  ): Promise<QaFinishResponse>;
}

/** Failures that do not come from the QA service's validation: transport and cancellation. */
export type QaToolErrorCode = QaErrorCode | "studio_unavailable" | "aborted";

/** A QA failure the loop (or Vision) can act on: a stable code and a message. */
export class QaToolError extends Error {
  readonly code: QaToolErrorCode;

  constructor(code: QaToolErrorCode, message: string) {
    super(message);
    this.name = "QaToolError";
    this.code = code;
  }
}
