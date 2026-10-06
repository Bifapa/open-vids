import { useEffect, useSyncExternalStore } from "react";
import { t } from "../i18n";
import type { ActionResult } from "../agent/agentSettingsSlice";
import type { AgentStore } from "../agent/agentStore";
import type { DesignTurnSpec } from "../agent/designTurn";
import type { DesignStore } from "./designStore";

/** What the design surface needs from the project's agent store (absent while it is being created). */
export interface DesignAgent {
  available: boolean;
  /** A turn runs somewhere in this project. */
  busy: boolean;
  /** A request of the surface's own (or the chat's) is on its way. */
  pending: boolean;
  run(spec: DesignTurnSpec): Promise<ActionResult>;
}

/** Why the agent cannot take a design turn now, or null when it can. */
export function designAgentBlocker(agent: DesignAgent): string | null {
  if (!agent.available) return t("studio.design.agent.unavailable");
  if (agent.busy) return t("studio.design.agent.working");
  if (agent.pending) return t("studio.design.agent.starting");
  return null;
}

const noSubscription = () => () => {};

export function useDesignAgent(agentStore: AgentStore | null): DesignAgent {
  const subscribe = agentStore ? agentStore.subscribe : noSubscription;
  const available = useSyncExternalStore(
    subscribe,
    () => agentStore?.getState().availability === "ready",
  );
  const busy = useSyncExternalStore(subscribe, () => agentStore?.getState().activeTurn != null);
  const pending = useSyncExternalStore(subscribe, () => agentStore?.getState().pending != null);
  return {
    available: agentStore !== null && available,
    busy,
    pending,
    run: async (spec) =>
      agentStore
        ? agentStore.getState().runDesignAction(spec)
        : { ok: false, message: t("studio.design.agent.notReady") },
  };
}

/**
 * Keeps the design state in step with agent turns: when any turn ends the library and the project's attachment are
 * read again (the agent may have saved a system, or attached or updated one with its own tools).
 */
export function useDesignAgentSync(agentStore: AgentStore | null, design: DesignStore): void {
  useEffect(() => {
    if (!agentStore) return;
    let busy = agentStore.getState().activeTurn !== null;
    return agentStore.subscribe((state) => {
      const now = state.activeTurn !== null;
      if (now === busy) return;
      busy = now;
      if (!now) void design.getState().refresh();
    });
  }, [agentStore, design]);
}
