/**
 * The Story workspace's state: the graph as the user sees it, a local undo/redo stack of graph snapshots, and a
 * debounced save. Manual edits never make project checkpoints; each saved state is a PUT the server claims as the
 * user's own history entry. Agent turns change the graph on the server, so the canvas is read-only while one runs
 * and reloads when it ends. The view also carries the Story ↔ timeline sync report, which timeline edits change
 * without touching the graph: a reload for it keeps the graph object when its version did not move.
 */

import { createStore, type StoreApi } from "zustand/vanilla";
import type { StoryGraph, StoryNodeFacts, StorySyncReport } from "@hyperframes/agent-protocol";
import { StoryApiError, type StoryClient } from "./storyClient";
import { emptyStoryGraph, newStoryId } from "./storyGraphOps";

export interface StorySelection {
  nodes: string[];
  /** Sequence edge and attachment ids. */
  edges: string[];
}

export type StoryLoadStatus = "idle" | "loading" | "ready" | "error";
export type StorySaveState = "saved" | "pending" | "saving" | "failed";

export interface StoryState {
  projectId: string | null;
  status: StoryLoadStatus;
  loadError: string | null;
  graph: StoryGraph | null;
  /** Server version of the graph file the local graph builds on (`baseVersion` of the next save). */
  version: string | null;
  facts: Record<string, StoryNodeFacts>;
  composition: string | null;
  /** How the timeline relates to the graph since the last build (null without a graph). */
  sync: StorySyncReport | null;
  past: StoryGraph[];
  future: StoryGraph[];
  saveState: StorySaveState;
  notice: string | null;
  /** An agent turn is running on this project: the graph is the agent's until it ends. */
  agentBusy: boolean;
  selection: StorySelection;

  open(projectId: string): Promise<void>;
  /** Fetches the server's graph; a changed version drops the local undo stack (it described another graph). */
  reload(): Promise<void>;
  /** Applies a manual edit (one undo step) and schedules a save. False when refused or a no-op. */
  commit(change: (graph: StoryGraph) => StoryGraph): boolean;
  undo(): boolean;
  redo(): boolean;
  /** Saves a pending edit now. True when the server has everything. */
  flush(): Promise<boolean>;
  select(selection: StorySelection): void;
  setAgentBusy(busy: boolean): void;
  /** Shows (or, with null, dismisses) the message above the canvas. */
  setNotice(message: string | null): void;
  dispose(): void;
}

export interface StoryStoreDeps {
  client: StoryClient;
  /** Debounce between the last edit and its save. */
  saveDelayMs?: number;
  historyLimit?: number;
}

export type StoryStore = StoreApi<StoryState>;

const EMPTY_SELECTION: StorySelection = { nodes: [], edges: [] };

export const CONFLICT_NOTICE =
  "The story changed elsewhere, so the latest version was loaded. Your last change was not saved.";

function describe(error: unknown): string {
  return error instanceof Error ? error.message : "Something went wrong";
}

/** The selection without ids the graph no longer has. */
function pruneSelection(selection: StorySelection, graph: StoryGraph | null): StorySelection {
  if (!graph) return EMPTY_SELECTION;
  const nodes = new Set(graph.nodes.map((node) => node.id));
  const edges = new Set([...graph.edges, ...graph.attachments].map((item) => item.id));
  const next = {
    nodes: selection.nodes.filter((id) => nodes.has(id)),
    edges: selection.edges.filter((id) => edges.has(id)),
  };
  return next.nodes.length === selection.nodes.length &&
    next.edges.length === selection.edges.length
    ? selection
    : next;
}

export function createStoryStore({
  client,
  saveDelayMs = 400,
  historyLimit = 100,
}: StoryStoreDeps): StoryStore {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let inFlight: Promise<boolean> | null = null;
  /** Local edits the server does not have yet. */
  let dirty = false;
  /** Bumped on every local edit, so a save response only replaces the graph it was made from. */
  let revision = 0;
  /** Bumped on project switch/dispose, so late responses for another project are dropped. */
  let epoch = 0;

  return createStore<StoryState>()((set, get) => {
    const stopTimer = () => {
      clearTimeout(timer);
      timer = undefined;
    };

    const scheduleSave = () => {
      dirty = true;
      revision += 1;
      stopTimer();
      set({ saveState: "pending" });
      timer = setTimeout(() => void save(), saveDelayMs);
    };

    async function load(projectId: string, from: number): Promise<void> {
      try {
        const view = await client.load(projectId);
        if (from !== epoch || dirty) return;
        const { version, selection, graph } = get();
        // Same version, same graph: keep the object so the canvas does not redraw every card for a sync refresh.
        const nextGraph = view.version === version && graph ? graph : view.graph;
        set({
          status: "ready",
          loadError: null,
          graph: nextGraph,
          version: view.version,
          facts: view.facts,
          composition: view.composition,
          sync: view.sync,
          selection: pruneSelection(selection, nextGraph),
          ...(view.version === version ? {} : { past: [], future: [] }),
        });
      } catch (error) {
        if (from !== epoch) return;
        if (get().status === "ready")
          set({ notice: `Couldn't reload the story: ${describe(error)}` });
        else set({ status: "error", loadError: describe(error) });
      }
    }

    async function save(): Promise<boolean> {
      stopTimer();
      while (inFlight) await inFlight;
      const { projectId, graph, version } = get();
      if (!dirty || !projectId || !graph) return get().saveState !== "failed";
      dirty = false;
      const from = epoch;
      const madeAt = revision;
      set({ saveState: "saving" });
      const attempt = (async (): Promise<boolean> => {
        try {
          const view = await client.save(projectId, { baseVersion: version, graph });
          if (from !== epoch) return false;
          set({
            version: view.version,
            facts: view.facts,
            composition: view.composition,
            sync: view.sync,
            // The server's copy carries the authorship it recorded; take it unless the user edited on.
            ...(madeAt === revision && view.graph ? { graph: view.graph } : {}),
            saveState: dirty ? "pending" : "saved",
          });
          return true;
        } catch (error) {
          if (from !== epoch) return false;
          if (error instanceof StoryApiError && error.isConflict) {
            dirty = false;
            stopTimer();
            set({ past: [], future: [], notice: CONFLICT_NOTICE, saveState: "saved" });
            await load(projectId, from);
            return false;
          }
          dirty = true;
          set({ saveState: "failed", notice: `Couldn't save the story: ${describe(error)}` });
          return false;
        }
      })();
      inFlight = attempt;
      try {
        return await attempt;
      } finally {
        if (inFlight === attempt) inFlight = null;
      }
    }

    const restore = (graph: StoryGraph, past: StoryGraph[], future: StoryGraph[]) => {
      set({ graph, past, future, selection: pruneSelection(get().selection, graph) });
      scheduleSave();
    };

    return {
      projectId: null,
      status: "idle",
      loadError: null,
      graph: null,
      version: null,
      facts: {},
      composition: null,
      sync: null,
      past: [],
      future: [],
      saveState: "saved",
      notice: null,
      agentBusy: false,
      selection: EMPTY_SELECTION,

      async open(projectId) {
        if (get().projectId === projectId) return get().reload();
        const { projectId: previous, graph, version } = get();
        // Leaving a project with an unsaved edit: send it on its way before forgetting it.
        if (dirty && previous && graph && !inFlight) {
          void client.save(previous, { baseVersion: version, graph }).catch(() => {});
        }
        epoch += 1;
        stopTimer();
        dirty = false;
        set({
          projectId,
          status: "loading",
          loadError: null,
          graph: null,
          version: null,
          facts: {},
          composition: null,
          sync: null,
          past: [],
          future: [],
          saveState: "saved",
          notice: null,
          selection: EMPTY_SELECTION,
        });
        await load(projectId, epoch);
      },

      async reload() {
        const { projectId } = get();
        if (projectId) await load(projectId, epoch);
      },

      commit(change) {
        const { graph, agentBusy, projectId, past } = get();
        if (agentBusy || !projectId) return false;
        const base = graph ?? emptyStoryGraph(newStoryId(null, "story"), Date.now());
        const next = change(base);
        if (next === base) return false;
        set({
          graph: next,
          // A story created by this edit has no earlier state to go back to.
          past: graph ? [...past, graph].slice(-historyLimit) : [],
          future: [],
          selection: pruneSelection(get().selection, next),
        });
        scheduleSave();
        return true;
      },

      undo() {
        const { graph, past, future, agentBusy } = get();
        const previous = past.at(-1);
        if (agentBusy || !graph || !previous) return false;
        restore(previous, past.slice(0, -1), [...future, graph]);
        return true;
      },

      redo() {
        const { graph, past, future, agentBusy } = get();
        const next = future.at(-1);
        if (agentBusy || !graph || !next) return false;
        restore(next, [...past, graph].slice(-historyLimit), future.slice(0, -1));
        return true;
      },

      async flush() {
        if (dirty || timer) return save();
        if (inFlight) return inFlight;
        return get().saveState !== "failed";
      },

      select(selection) {
        const current = get().selection;
        const same =
          current.nodes.length === selection.nodes.length &&
          current.edges.length === selection.edges.length &&
          current.nodes.every((id, index) => id === selection.nodes[index]) &&
          current.edges.every((id, index) => id === selection.edges[index]);
        if (!same) set({ selection });
      },

      setAgentBusy(busy) {
        if (get().agentBusy === busy) return;
        set({ agentBusy: busy });
        // The agent works from the saved graph: a pending edit goes out now, not after it started.
        if (busy && (dirty || timer)) void save();
      },

      setNotice: (notice) => set({ notice }),

      dispose() {
        epoch += 1;
        stopTimer();
      },
    };
  });
}
