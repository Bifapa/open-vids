import type { StoryError, StoryErrorCode } from "@hyperframes/agent-protocol";

/** A refused story request: carries the wire error the route answers with. Nothing was written when one is thrown. */
export class StoryFailure extends Error {
  readonly error: StoryError;

  constructor(
    code: StoryErrorCode,
    message: string,
    opIndex?: number,
    params?: Record<string, string | number>,
  ) {
    super(message);
    this.name = "StoryFailure";
    this.error = {
      code,
      message,
      ...(opIndex !== undefined && { opIndex }),
      ...(params !== undefined && { params }),
    };
  }

  atOperation(opIndex: number): StoryFailure {
    return new StoryFailure(this.error.code, this.error.message, opIndex, this.error.params);
  }
}

export function isStoryFailure(value: unknown): value is StoryFailure {
  return value instanceof StoryFailure;
}

/** HTTP status of a story error. */
export function storyStatus(error: StoryError): 400 | 404 | 409 {
  switch (error.code) {
    case "invalid_request":
    case "unsupported":
      return 400;
    case "no_story":
    case "unknown_node":
    case "unknown_asset":
    case "unknown_preset":
      return 404;
    case "locked":
    case "user_decision":
    case "conflict":
    case "not_analyzed":
      return 409;
  }
}
