import { useEffect, useSyncExternalStore } from "react";
import type { ActionResult } from "../agent/agentSettingsSlice";
import type { AgentState, AgentStore } from "../agent/agentStore";
import type { StoryStore } from "./storyStore";

/** What the Story panel needs from the project's agent store (absent while it is being created). */
export interface StoryAgent {
  available: boolean;
  /** A turn runs somewhere in this project. */
  busy: boolean;
  /** A request of the panel's own (or the chat's) is on its way. */
  pending: boolean;
  /** Whether the open chat lets the Director delegate to Research; null with no chat open (a new one decides). */
  researchEnabled: boolean | null;
  runStoryAction: AgentState["runStoryAction"];
  /** Opens the chat in story mode, creating one when none is open. */
  planWithAi(): Promise<ActionResult>;
}

/** Why the agent cannot take a story action now, or null when it can. */
export function agentBlocker(agent: StoryAgent): string | null {
  if (!agent.available) return "The agent is unavailable";
  if (agent.busy) return "The agent is working";
  if (agent.pending) return "Starting…";
  return null;
}

/** Why Research cannot be asked to find material now, or null when it can. */
export function researchBlocker(agent: StoryAgent): string | null {
  const busy = agentBlocker(agent);
  if (busy) return busy;
  if (agent.researchEnabled === false) {
    return "Research is turned off in this chat: turn it on in the chat's Agents menu";
  }
  return null;
}

const noSubscription = () => () => {};

export function useStoryAgent(agentStore: AgentStore | null): StoryAgent {
  const subscribe = agentStore ? agentStore.subscribe : noSubscription;
  const available = useSyncExternalStore(
    subscribe,
    () => agentStore?.getState().availability === "ready",
  );
  const busy = useSyncExternalStore(subscribe, () => agentStore?.getState().activeTurn != null);
  const pending = useSyncExternalStore(subscribe, () => agentStore?.getState().pending != null);
  const researchEnabled = useSyncExternalStore(subscribe, () => {
    const chat = agentStore?.getState().chat;
    return chat ? chat.chat.enabledAgents.includes("research") : null;
  });
  return {
    available: agentStore !== null && available,
    busy,
    pending,
    researchEnabled,
    runStoryAction: async (action, options) =>
      agentStore
        ? agentStore.getState().runStoryAction(action, options)
        : { ok: false, message: "The agent is not ready yet." },
    planWithAi: async () => {
      if (!agentStore) return { ok: false, message: "The agent is not ready yet." };
      if (!agentStore.getState().chatId) await agentStore.getState().newChat();
      if (!agentStore.getState().chatId) {
        return {
          ok: false,
          message: agentStore.getState().notice?.message ?? "Couldn't open a chat.",
        };
      }
      return { ok: true };
    },
  };
}

/**
 * Keeps the story in step with agent turns: read-only while any turn runs on the project, reloaded when it ends
 * (the agent may have edited, built or rebuilt the story, or edited the timeline its sync report compares).
 */
export function useStoryAgentSync(agentStore: AgentStore | null, story: StoryStore): void {
  useEffect(() => {
    if (!agentStore) return;
    let busy = agentStore.getState().activeTurn !== null;
    story.getState().setAgentBusy(busy);
    return agentStore.subscribe((state) => {
      const now = state.activeTurn !== null;
      if (now === busy) return;
      busy = now;
      story.getState().setAgentBusy(now);
      if (!now) void story.getState().reload();
    });
  }, [agentStore, story]);
}
