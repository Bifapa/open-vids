import type { AgentErrorCode } from "@hyperframes/agent-protocol";
import { AgentApiError, type AgentFailureCode } from "./agentClient";

const PLAIN_LANGUAGE: Partial<Record<AgentFailureCode, string>> = {
  network: "Can't reach the agent right now. Your project is untouched.",
  runtime_unavailable: "The agent isn't running right now. Your project is untouched.",
  unauthorized: "Studio isn't allowed to talk to the agent. Restart Studio and try again.",
  project_busy:
    "Another chat is working on this project. Wait for it to finish, or stop it, then try again.",
  chat_busy: "This chat is already working. Your message wasn't sent.",
  checkpoint_unavailable:
    "The agent couldn't start because Studio couldn't set up a safe undo point for this run. Nothing was changed.",
  model_unavailable: "This model isn't available right now. Pick another model and try again.",
  turn_not_active: "The agent had already finished, so it couldn't take that message.",
  chat_not_found: "This chat no longer exists.",
  turn_not_found: "That run no longer exists.",
  revert_conflict: "Some files changed after this run, so they can't be reverted cleanly.",
  revert_unavailable: "This run can't be reverted.",
  agent_failed: "The agent ran into a problem and stopped.",
  invalid_request: "The agent couldn't understand that request.",
  internal: "Something went wrong inside the agent.",
  bad_response: "The agent sent something Studio didn't understand.",
};

/** Turns a failed call into a sentence a user can act on; the raw message is a last resort. */
export function describeAgentFailure(code: AgentFailureCode, fallback?: string): string {
  return PLAIN_LANGUAGE[code] ?? fallback ?? "Something went wrong.";
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
