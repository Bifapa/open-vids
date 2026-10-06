import type { StoreApi } from "zustand/vanilla";
import type { AgentState } from "./agentStore";

/**
 * Whether a turn's plan is open or folded, as the user left it. The plan lives in two places over its life — the
 * pinned dock while the turn runs (or waits for approval), the feed after — so the choice cannot live in either
 * component's state. A turn with no entry shows its plan folded.
 */
export interface AgentPlanSlice {
  planOpen: Record<string, boolean>;
  setPlanOpen(turnId: string, open: boolean): void;
}

export function createAgentPlanSlice({
  set,
}: {
  set: StoreApi<AgentState>["setState"];
}): AgentPlanSlice {
  return {
    planOpen: {},
    setPlanOpen: (turnId, open) =>
      set((state) => ({ planOpen: { ...state.planOpen, [turnId]: open } })),
  };
}
