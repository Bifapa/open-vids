import { useEffect, useRef } from "react";
import type { AgentStore } from "../agent/agentStore";
import { useDockLayoutStore } from "../components/dock/dockLayoutStore";
import type { SourcesStore } from "./sourcesStore";

/** One reload for a burst of file changes (an import writes the file, then the timeline). */
const RELOAD_DELAY_MS = 300;

/**
 * Keeps the project's Sources view current. The provenance ledger sits in `.hyperframes/`, which the file watcher
 * does not report, so the view reloads on what changes it: an agent turn ending (Research imports inside a turn),
 * a revert (the store's owner calls `reload` then), a change of the project's files (an imported or deleted asset,
 * a timeline that starts or stops using one) and the Sources panel coming into view.
 */
export function useSourcesAutoRefresh(
  store: SourcesStore,
  projectId: string,
  agentStore: AgentStore | null,
  /** Any value whose identity moves when the project's files change (the file tree). */
  files: unknown,
): void {
  useEffect(() => {
    void store.getState().open(projectId);
  }, [store, projectId]);

  const timer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  const schedule = useRef(() => {
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => void store.getState().reload(), RELOAD_DELAY_MS);
  });

  const seenFiles = useRef(files);
  useEffect(() => {
    if (seenFiles.current === files) return;
    seenFiles.current = files;
    schedule.current();
  }, [files]);

  useEffect(() => {
    if (!agentStore) return;
    let running = agentStore.getState().activeTurn !== null;
    return agentStore.subscribe((state) => {
      const now = state.activeTurn !== null;
      if (now === running) return;
      running = now;
      if (!now) schedule.current();
    });
  }, [agentStore]);

  useEffect(() => {
    let visible = useDockLayoutStore.getState().visiblePanels.has("sources");
    return useDockLayoutStore.subscribe((state) => {
      const now = state.visiblePanels.has("sources");
      if (now === visible) return;
      visible = now;
      if (now) schedule.current();
    });
  }, []);
}
