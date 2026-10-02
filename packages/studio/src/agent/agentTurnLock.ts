/**
 * "An agent turn is running for this project" as a value the timeline can read.
 *
 * The truth lives in the project's agent store (`agentStore.activeTurn` — the one project-modifying turn allowed at
 * a time, which stays running through the turn's render-QA correction passes — plus a running turn in the open
 * chat). That store is created in the right-panel subtree, under `AgentStoreProvider`; the timeline is not, and its
 * edit paths are not all React (hotkeys, clipboard, drop callbacks). So the store that owns the truth publishes
 * into this module-level mirror, and the timeline reads it through {@link useAgentTurnRunning} (reactive) or
 * {@link isAgentTurnRunning} (a callback that must decide right now).
 *
 * Publishing is project-scoped so a project switch cannot leave a stale lock behind: the old store's cleanup only
 * clears the mirror while it still owns it.
 */

import { useStore } from "zustand";
import { createStore } from "zustand/vanilla";

export interface AgentTurnLockState {
  /** The project whose agent store last published. */
  projectId: string | null;
  /** That project has a turn running: hand edits are refused while it is. */
  running: boolean;
}

export const agentTurnLockStore = createStore<AgentTurnLockState>(() => ({
  projectId: null,
  running: false,
}));

/** The project's agent store calls this whenever its turn state may have changed. */
export function publishAgentTurnRunning(projectId: string, running: boolean): void {
  const state = agentTurnLockStore.getState();
  if (state.projectId === projectId && state.running === running) return;
  agentTurnLockStore.setState({ projectId, running });
}

/** The project's agent store was disposed: forget its lock, unless a newer store already owns the mirror. */
export function clearAgentTurnRunning(projectId: string): void {
  if (agentTurnLockStore.getState().projectId !== projectId) return;
  agentTurnLockStore.setState({ projectId: null, running: false });
}

/** Drives the lock without an agent (dev-only `window.__studioTest` hook and unit tests). */
export function setAgentTurnRunning(running: boolean): void {
  if (agentTurnLockStore.getState().running === running) return;
  agentTurnLockStore.setState({ running });
}

/** For callbacks that must decide now (a refused write, a key handler): never a render-time value. */
export function isAgentTurnRunning(): boolean {
  return agentTurnLockStore.getState().running;
}

/** Reactive form for components: the indicator, the disabled affordances. */
export function useAgentTurnRunning(projectId?: string | null): boolean {
  return useStore(agentTurnLockStore, (state) =>
    projectId == null ? state.running : state.running && state.projectId === projectId,
  );
}
