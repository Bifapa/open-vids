import { SPECIALIST_IDS, type AgentId } from "@hyperframes/agent-protocol";

/** An agent id (or `user`) from untrusted text, or null. */
export function agentIdOf(value: unknown): AgentId | "user" | null {
  if (value === "user" || value === "director" || value === "jev") return value;
  return SPECIALIST_IDS.find((id) => id === value) ?? null;
}
