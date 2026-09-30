import { useEffect } from "react";
import { useDockLayoutStore } from "../components/dock/dockLayoutStore";
import { usePlayerStore } from "../player/store/playerStore";
import { thumbnailRevisionOf } from "../player/store/thumbnailSlice";
import type { StoryStore } from "./storyStore";

/** One reload for a burst of saves (a multi-clip edit writes more than once). */
const RELOAD_DELAY_MS = 250;

/**
 * Keeps the Story ↔ timeline sync report fresh while the Story panel is mounted. Every persisted change of a
 * composition — Studio's own timeline writes, external and agent edits, reverts — moves its revision in the player
 * store; a move of the story's composition reloads the view, and so does the panel becoming visible again. While an
 * agent turn runs the reload waits for the turn's end, which reloads anyway.
 */
export function useStoryTimelineSync(story: StoryStore): void {
  useEffect(() => {
    let timer: number | undefined;
    const schedule = () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        const state = story.getState();
        if (state.graph && !state.agentBusy) void state.reload();
      }, RELOAD_DELAY_MS);
    };
    const revision = () => {
      const { composition } = story.getState();
      return composition
        ? thumbnailRevisionOf(usePlayerStore.getState().thumbnailRevisions, composition)
        : null;
    };

    let seen = revision();
    const stopTimeline = usePlayerStore.subscribe((state, previous) => {
      if (state.thumbnailRevisions === previous.thumbnailRevisions) return;
      const now = revision();
      if (now === seen) return;
      seen = now;
      schedule();
    });

    let visible = useDockLayoutStore.getState().visiblePanels.has("story");
    const stopDock = useDockLayoutStore.subscribe((state) => {
      const now = state.visiblePanels.has("story");
      if (now === visible) return;
      visible = now;
      if (now) schedule();
    });

    return () => {
      window.clearTimeout(timer);
      stopTimeline();
      stopDock();
    };
  }, [story]);
}
