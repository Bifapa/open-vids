import type { QaError, QaErrorCode } from "@hyperframes/agent-protocol";
import { isAnalysisFailure } from "../analysis/errors.js";

/** A refusal or failure of the QA service, carrying the protocol error it answers with. */
export class QaFailure extends Error {
  readonly error: QaError;

  constructor(code: QaErrorCode, message: string) {
    super(message);
    this.name = "QaFailure";
    this.error = { code, message };
  }
}

export function isQaFailure(value: unknown): value is QaFailure {
  return value instanceof QaFailure;
}

/** HTTP status of a QA error (499: the client went away). */
export function qaStatus(error: QaError): 400 | 404 | 499 | 500 | 503 {
  switch (error.code) {
    case "invalid_request":
      return 400;
    case "not_found":
      return 404;
    case "unavailable":
      return 503;
    case "cancelled":
      return 499;
    case "failed":
      return 500;
  }
}

/** Any failure of the work under a QA request as a QA failure: cancelled and unavailable keep their meaning. */
export function asQaFailure(error: unknown): QaFailure {
  if (isQaFailure(error)) return error;
  if (isAnalysisFailure(error)) {
    const { code, message } = error.error;
    if (code === "cancelled" || code === "unavailable") return new QaFailure(code, message);
    return new QaFailure("failed", message);
  }
  return new QaFailure("failed", error instanceof Error ? error.message : String(error));
}
