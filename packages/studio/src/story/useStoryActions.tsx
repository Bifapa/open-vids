import { useState, type ReactNode } from "react";
import { isChapter, type StoryAction, type StoryActionOptions } from "@hyperframes/agent-protocol";
import type { AgentStore } from "../agent/agentStore";
import { useDockLayoutStore } from "../components/dock/dockLayoutStore";
import { FullBuildDialog } from "./FullBuildDialog";
import { RebuildDialog } from "./RebuildDialog";
import { useStoryServices, useStoryStore } from "./storyContext";
import { fullBuildNeedsConfirm, syncBlocker } from "./storySync";
import { agentBlocker, useStoryAgent, type StoryAgent } from "./useStoryAgent";

/** The modal of a story action: the impact of a rebuild (every affected section, or the chosen ones), or the
 * confirm of a full build over edits and locked sections. */
type StoryActionDialog = { kind: "rebuild"; chapters: string[] | null } | { kind: "build" };

export interface StoryActions {
  agent: StoryAgent;
  /** Why the agent cannot take a story action now, or null when it can. */
  blocker: string | null;
  /** Starts the action's story-mode turn (after saving a pending edit) and brings the chat forward. */
  run(action: StoryAction, options?: StoryActionOptions): Promise<void>;
  /** A toolbar action: a full build over a story built and then edited (or locked) asks first. */
  request(action: StoryAction): void;
  /** Opens the impact of Rebuild affected: for every affected section, or for the chosen ones. */
  openRebuild(chapters: string[] | null): void;
  /** The open dialog, to be rendered inside a `relative` box that it is to cover; null when none is open. */
  dialog: ReactNode;
}

/** How many chapters the story has; Review and Build need at least one. */
export function useChapterCount(): number {
  return useStoryStore((state) => state.graph?.nodes.filter(isChapter).length ?? 0);
}

/**
 * The Story workspace's actions on the agent — Review, Build, Rebuild affected, Find missing — with the dialogs they
 * ask through. The Story panel and the chat's «Build the video» button run the same flow through this hook.
 */
export function useStoryActions(agentStore: AgentStore | null): StoryActions {
  const { store } = useStoryServices();
  const status = useStoryStore((state) => state.status);
  const sync = useStoryStore((state) => state.sync);
  const agent = useStoryAgent(agentStore);
  const [open, setOpen] = useState<StoryActionDialog | null>(null);
  const blocker = agentBlocker(agent);

  const run = async (action: StoryAction, options?: StoryActionOptions) => {
    setOpen(null);
    if (!(await store.getState().flush())) return;
    const result = await agent.runStoryAction(action, options);
    if (!result.ok) {
      store.getState().setNotice(result.message);
      return;
    }
    useDockLayoutStore.getState().activatePanel("chat");
  };

  const request = (action: StoryAction) => {
    if (action === "build" && fullBuildNeedsConfirm(store.getState().sync)) {
      setOpen({ kind: "build" });
      return;
    }
    void run(action);
  };

  let dialog: ReactNode = null;
  if (open && sync && status === "ready") {
    dialog =
      open.kind === "rebuild" ? (
        <RebuildDialog
          report={sync}
          chapters={open.chapters}
          blocker={blocker}
          onClose={() => setOpen(null)}
          onStart={(options) => void run("rebuild", options)}
        />
      ) : (
        <FullBuildDialog
          report={sync}
          rebuildBlocker={syncBlocker(sync) ?? blocker}
          blocker={blocker}
          onClose={() => setOpen(null)}
          onBuild={(options) => void run("build", options)}
          onRebuildInstead={() => setOpen({ kind: "rebuild", chapters: null })}
        />
      );
  }

  return {
    agent,
    blocker,
    run,
    request,
    openRebuild: (chapters) => setOpen({ kind: "rebuild", chapters }),
    dialog,
  };
}
