import type {
  CodedMessageParams,
  ResearchError,
  ResearchErrorCode,
} from "@hyperframes/agent-protocol";

/** A refused or failed research request: carries the wire error the route answers with. */
export class ResearchFailure extends Error {
  readonly error: ResearchError;

  constructor(code: ResearchErrorCode, message: string, params?: CodedMessageParams) {
    super(message);
    this.name = "ResearchFailure";
    this.error = { code, message, ...(params && { params }) };
  }
}

export function isResearchFailure(value: unknown): value is ResearchFailure {
  return value instanceof ResearchFailure;
}

/** HTTP status of a research error. */
export function researchStatus(
  error: ResearchError,
): 400 | 403 | 404 | 409 | 410 | 413 | 415 | 429 | 502 {
  switch (error.code) {
    case "invalid_request":
    case "unknown_source":
      return 400;
    case "blocked_by_policy":
    case "restricted_license":
      return 403;
    case "unknown_candidate":
    case "unknown_node":
    case "unknown_asset":
    case "unknown_project":
    case "no_story":
      return 404;
    case "conflict":
    case "cancelled":
    case "locked":
      return 409;
    case "unavailable":
      return 410;
    case "too_large":
      return 413;
    case "not_media":
    case "unsupported":
      return 415;
    case "rate_limited":
      return 429;
    case "network":
    case "provider_error":
      return 502;
  }
}
