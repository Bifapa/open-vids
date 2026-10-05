import { useEffect, useSyncExternalStore } from "react";
import type { StoryAction } from "@hyperframes/agent-protocol";
import type { ActionResult } from "../agent/agentSettingsSlice";
import { t } from "../i18n";
import type { AgentState, AgentStore } from "../agent/agentStore";
import type { StoryStore } from "./storyStore";

/** What the Story panel needs from the project's agent store (absent while it is being created). */
export interface StoryAgent {
  available: boolean;
  /** A turn runs somewhere in this project. */
  busy: boolean;
  /** A request of the panel's own (or the chat's) is on its way. */
  pending: boolean;
  runStoryAction: AgentState["runStoryAction"];
  /** Opens the chat in story mode, creating one when none is open. */
  planWithAi(): Promise<ActionResult>;
}

/** Why the agent cannot take a story action now, or null when it can. */
export function agentBlocker(agent: StoryAgent): string | null {
  if (!agent.available) return t("story.agent.unavailable");
  if (agent.busy) return t("story.agent.working");
  if (agent.pending) return t("story.agent.starting");
  return null;
}

/** Why Review/Build cannot run now, or null when they can. */
export function actionBlocker(
  action: StoryAction,
  agent: StoryAgent,
  chapters: number,
): string | null {
  const busy = agentBlocker(agent);
  if (busy) return busy;
  if (chapters === 0) {
    return action === "build"
      ? t("story.toolbar.addChapterFirst")
      : t("story.toolbar.nothingToReview");
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
  return {
    available: agentStore !== null && available,
    busy,
    pending,
    runStoryAction: async (action, options) =>
      agentStore
        ? agentStore.getState().runStoryAction(action, options)
        : { ok: false, message: t("story.agent.notReady") },
    planWithAi: async () => {
      if (!agentStore) return { ok: false, message: t("story.agent.notReady") };
      if (!agentStore.getState().chatId) await agentStore.getState().newChat();
      if (!agentStore.getState().chatId) {
        return {
          ok: false,
          message: agentStore.getState().notice?.message ?? t("story.agent.chatFailed"),
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
