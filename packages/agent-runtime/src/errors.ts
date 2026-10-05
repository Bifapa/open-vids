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

const PROVIDER_FAILURE_CODES: readonly AgentErrorCode[] = [
  "provider_auth",
  "rate_limited",
  "provider_overloaded",
  "context_overflow",
];

/** The code a failed turn or run carries: the provider failure class the backend recognised, else `agent_failed`. */
export function failureCode(error: unknown): AgentErrorCode {
  return error instanceof RuntimeError && PROVIDER_FAILURE_CODES.includes(error.code)
    ? error.code
    : "agent_failed";
}
