import type { AnalysisError, AnalysisErrorCode } from "@hyperframes/agent-protocol";

/** A refusal or failure of the analysis service, carrying the protocol error it answers with. */
export class AnalysisFailure extends Error {
  readonly error: AnalysisError;

  constructor(code: AnalysisErrorCode, message: string) {
    super(message);
    this.name = "AnalysisFailure";
    this.error = { code, message };
  }
}

export function isAnalysisFailure(value: unknown): value is AnalysisFailure {
  return value instanceof AnalysisFailure;
}

/** HTTP status of an analysis error. */
export function analysisStatus(error: AnalysisError): 400 | 404 | 409 | 499 | 500 | 503 {
  switch (error.code) {
    case "invalid_request":
      return 400;
    case "unknown_source":
    case "unknown_plan":
    case "not_analyzed":
      return 404;
    case "stale":
    case "conflict":
      return 409;
    case "unavailable":
      return 503;
    case "cancelled":
      return 499;
    case "failed":
      return 500;
  }
}
