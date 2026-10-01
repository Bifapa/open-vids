import type { AgentErrorCode } from "@hyperframes/agent-protocol";
import { t, type TranslationKey } from "../i18n";
import { AgentApiError, type AgentFailureCode } from "./agentClient";

/** Plain-language wording per failure code, as keys: translated when the message is built, never at import. */
const PLAIN_LANGUAGE_KEYS = {
  network: "agent.error.network",
  runtime_unavailable: "agent.error.runtime_unavailable",
  unauthorized: "agent.error.unauthorized",
  project_busy: "agent.error.project_busy",
  chat_busy: "agent.error.chat_busy",
  checkpoint_unavailable: "agent.error.checkpoint_unavailable",
  model_unavailable: "agent.error.model_unavailable",
  turn_not_active: "agent.error.turn_not_active",
  chat_not_found: "agent.error.chat_not_found",
  turn_not_found: "agent.error.turn_not_found",
  revert_conflict: "agent.error.revert_conflict",
  revert_unavailable: "agent.error.revert_unavailable",
  agent_failed: "agent.error.agent_failed",
  invalid_request: "agent.error.invalid_request",
  internal: "agent.error.internal",
  bad_response: "agent.error.bad_response",
} as const satisfies Partial<Record<AgentFailureCode, TranslationKey>>;

function isPlainLanguageCode(code: AgentFailureCode): code is keyof typeof PLAIN_LANGUAGE_KEYS {
  return code in PLAIN_LANGUAGE_KEYS;
}

/** Turns a failed call into a sentence a user can act on; the raw message is a last resort. */
export function describeAgentFailure(code: AgentFailureCode, fallback?: string): string {
  if (isPlainLanguageCode(code)) return t(PLAIN_LANGUAGE_KEYS[code]);
  return fallback ?? t("agent.error.generic");
}

export function describeAgentError(error: unknown): string {
  if (error instanceof AgentApiError) return describeAgentFailure(error.code, error.message);
  return describeAgentFailure("internal");
}

/** Errors a `turn.failed` event carries; same wording as the call that would have raised them. */
export function describeTurnError(code: AgentErrorCode, message: string): string {
  return code === "agent_failed" || code === "internal"
    ? message || describeAgentFailure(code)
    : describeAgentFailure(code, message);
}

/**
 * The runtime's refusal to start a turn because no provider has credentials ("No authenticated OMP model is
 * available. Sign in with OMP or configure a provider API key."). It means "connect a model", not "something broke".
 */
export function isNoModelMessage(message: string): boolean {
  return /no authenticated omp model is available/i.test(message);
}
