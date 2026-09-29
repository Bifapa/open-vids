import type { EditError, EditErrorCode } from "@hyperframes/agent-protocol";

/** A refused edit: carries the wire error the route returns. Nothing was written when one is thrown. */
export class EditFailure extends Error {
  readonly error: EditError;

  constructor(code: EditErrorCode, message: string, opIndex?: number) {
    super(message);
    this.name = "EditFailure";
    this.error = { code, message, ...(opIndex !== undefined && { opIndex }) };
  }

  atOperation(opIndex: number): EditFailure {
    return new EditFailure(this.error.code, this.error.message, opIndex);
  }
}

export function isEditFailure(value: unknown): value is EditFailure {
  return value instanceof EditFailure;
}
