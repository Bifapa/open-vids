import type { AgentErrorCode } from "@hyperframes/agent-protocol";

export class RuntimeError extends Error {
  constructor(
    readonly code: AgentErrorCode,
    message: string,
    readonly status: number,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "RuntimeError";
  }
}

export function errorMessage(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message.trim()) return error.message;
  if (typeof error === "string" && error.trim()) return error;
  return fallback;
}
