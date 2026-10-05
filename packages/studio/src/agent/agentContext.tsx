import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { useStore } from "zustand";
import { createAgentClient } from "./agentClient";
import { agentTurnRunning } from "./agentSelectors";
import { clearAgentTurnRunning, publishAgentTurnRunning } from "./agentTurnLock";
import { createAgentStore, type AgentState, type AgentStore } from "./agentStore";
import { browserEventSource, type EventSourceFactory } from "./agentStream";
import type { EditorContextSource } from "./editorContext";
import { consumeIntake } from "./agentIntake";
import { withoutExcluded } from "./composerContext";

const AgentStoreContext = createContext<AgentStore | null>(null);

export function AgentStoreProvider({
  store,
  children,
}: {
  store: AgentStore;
  children: ReactNode;
}) {
  return <AgentStoreContext.Provider value={store}>{children}</AgentStoreContext.Provider>;
}

export function useAgentStoreApi(): AgentStore {
  const store = useContext(AgentStoreContext);
  if (!store) throw new Error("useAgentStore must be used inside AgentStoreProvider");
  return store;
}

export function useAgentStore<T>(selector: (state: AgentState) => T): T {
  return useStore(useAgentStoreApi(), selector);
}

/**
 * The agent store for one project. A new project gets a fresh store (and closes the old
 * streams); the store is created in an effect so a discarded render never opens a connection.
 */
export function useProjectAgentStore(
  projectId: string,
  editorContext: EditorContextSource,
  onReverted: () => void | Promise<void>,
  onTurnEnded: () => void = () => {},
  projectHasMedia: () => boolean = () => false,
  openEventSource: EventSourceFactory = browserEventSource,
): AgentStore | null {
  const [store, setStore] = useState<AgentStore | null>(null);
  const live = useRef({ editorContext, onReverted, onTurnEnded, projectHasMedia });
  useEffect(() => {
    live.current = { editorContext, onReverted, onTurnEnded, projectHasMedia };
  });

  useEffect(() => {
    let cancelled = false;
    const client = createAgentClient(projectId);
    const next = createAgentStore({
      client,
      openEventSource,
      captureEditorContext: () => withoutExcluded(live.current.editorContext.capture()),
      onTurnReverted: () => live.current.onReverted(),
      onTurnEnded: () => live.current.onTurnEnded(),
      projectHasMedia: () => live.current.projectHasMedia(),
    });
    setStore(next);
    // The timeline (outside this provider) locks while a turn runs: mirror the store's own turn state.
    const publishTurnLock = (state: AgentState) =>
      publishAgentTurnRunning(projectId, agentTurnRunning(state));
    publishTurnLock(next.getState());
    const unsubscribeTurnLock = next.subscribe(publishTurnLock);
    void next
      .getState()
      .init()
      .then(() => consumeIntake(next, client, { projectId, isCancelled: () => cancelled }));
    return () => {
      cancelled = true;
      unsubscribeTurnLock();
      next.getState().dispose();
      clearAgentTurnRunning(projectId);
      setStore(null);
    };
  }, [projectId, openEventSource]);

  return store;
}
