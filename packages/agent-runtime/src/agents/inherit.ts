import { SPECIALIST_IDS, type AgentId, type SpecialistId } from "@hyperframes/agent-protocol";

/** The specialists that are off in this chat: their work falls to the Director. */
export function disabledSpecialists(enabled: readonly SpecialistId[]): SpecialistId[] {
  return SPECIALIST_IDS.filter((id) => !enabled.includes(id));
}

/**
 * The tools of a tool family an agent gets, with the Director inheriting what a disabled specialist would have had:
 * turning a specialist off moves its work to the Director instead of losing it. `base` answers for one agent as if every
 * specialist were on (each family's own gating by turn, phase and policy stays inside it). Jev never inherits.
 */
export function withInheritedTools<T extends string>(
  agent: AgentId,
  enabled: readonly SpecialistId[],
  base: (agent: AgentId) => T[],
): T[] {
  if (agent !== "director") return base(agent);
  const tools = new Set<T>(base("director"));
  for (const specialist of disabledSpecialists(enabled)) {
    for (const tool of base(specialist)) tools.add(tool);
  }
  return [...tools];
}
