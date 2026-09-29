import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { useStore } from "zustand";
import { createAgentClient } from "./agentClient";
import { createAgentStore, type AgentState, type AgentStore } from "./agentStore";
import { browserEventSource, type EventSourceFactory } from "./agentStream";
import type { EditorContextSource } from "./editorContext";

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
  openEventSource: EventSourceFactory = browserEventSource,
): AgentStore | null {
  const [store, setStore] = useState<AgentStore | null>(null);
  const live = useRef({ editorContext, onReverted });
  useEffect(() => {
    live.current = { editorContext, onReverted };
  });

  useEffect(() => {
    const next = createAgentStore({
      client: createAgentClient(projectId),
      openEventSource,
      captureEditorContext: () => live.current.editorContext.capture(),
      onTurnReverted: () => live.current.onReverted(),
    });
    setStore(next);
    void next.getState().init();
    return () => {
      next.getState().dispose();
      setStore(null);
    };
  }, [projectId, openEventSource]);

  return store;
}
