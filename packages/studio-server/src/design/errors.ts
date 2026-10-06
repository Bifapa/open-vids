import type { DesignError, DesignErrorCode } from "@hyperframes/agent-protocol";

/** A refused design-library request: carries the wire error the route answers with. Nothing was written. */
export class DesignFailure extends Error {
  readonly error: DesignError;

  constructor(code: DesignErrorCode, message: string, issues?: string[]) {
    super(message);
    this.name = "DesignFailure";
    this.error = { code, message, ...(issues && issues.length > 0 && { issues }) };
  }
}

export function isDesignFailure(value: unknown): value is DesignFailure {
  return value instanceof DesignFailure;
}

/** HTTP status of a design error. */
export function designStatus(error: DesignError): 400 | 404 | 409 | 422 | 502 | 503 {
  switch (error.code) {
    case "invalid_request":
      return 400;
    case "invalid_system":
      return 422;
    case "not_found":
      return 404;
    case "conflict":
      return 409;
    case "asset_unavailable":
      return 502;
    case "busy":
    case "unavailable":
      return 503;
  }
}
