import { createStore, type StoreApi } from "zustand/vanilla";
import type { DesignSystemSummary, ProjectDesignState } from "@hyperframes/agent-protocol";
import { t } from "../i18n";
import { DesignApiError, type DesignClient } from "./designClient";
import { snapshotFacts, type SnapshotFacts } from "./designFacts";

export type DesignLoadStatus = "idle" | "loading" | "ready" | "error";

/** A mutation in flight; the surface disables the others while one runs. */
export type DesignMutation =
  | { kind: "attach"; id: string }
  | { kind: "update" }
  | { kind: "detach" };

/** A failed action: what the user can read, and the server's own list of problems when it sent one. */
export interface DesignNotice {
  message: string;
  issues: string[];
}

export interface DesignState {
  /** The project the state belongs to; null until `open`. */
  projectId: string | null;
  /** The user's library. `systems` keeps the last answer while a refresh runs or fails. */
  library: { status: DesignLoadStatus; systems: DesignSystemSummary[]; error: string | null };
  /** The project's attachment; `state` keeps the last answer while a refresh runs or fails. */
  project: {
    status: DesignLoadStatus;
    state: ProjectDesignState | null;
    /** Swatches and display font of the snapshot; null when it cannot be read (the rest still shows). */
    facts: SnapshotFacts | null;
    error: string | null;
  };
  mutation: DesignMutation | null;
  notice: DesignNotice | null;

  /** Follows `projectId`: a different project resets the state and loads it; the same one keeps what it has. */
  open(projectId: string): Promise<void>;
  /** Reads the library and the project's attachment again. A newer refresh supersedes an older one. */
  refresh(): Promise<void>;
  /** Each returns true when the server did it. The state is read again afterwards either way. */
  attach(id: string): Promise<boolean>;
  update(): Promise<boolean>;
  detach(): Promise<boolean>;
  dismissNotice(): void;
}

export type DesignStore = StoreApi<DesignState>;

const EMPTY_LIBRARY: DesignState["library"] = { status: "idle", systems: [], error: null };
const EMPTY_PROJECT: DesignState["project"] = {
  status: "idle",
  state: null,
  facts: null,
  error: null,
};

function describe(error: unknown): DesignNotice {
  if (error instanceof DesignApiError) return { message: error.message, issues: error.issues };
  return { message: t("studio.design.error.http"), issues: [] };
}

export function createDesignStore(deps: { client: DesignClient }): DesignStore {
  const { client } = deps;
  /** Bumped by every `open` and `refresh`: an answer for an older one is dropped. */
  let epoch = 0;
  let inFlight: AbortController | null = null;

  return createStore<DesignState>()((set, get) => {
    const run = async (
      mutation: DesignMutation,
      act: (projectId: string) => Promise<ProjectDesignState>,
    ) => {
      const { projectId, mutation: running } = get();
      if (!projectId || running) return false;
      set({ mutation, notice: null });
      let done = false;
      try {
        const next = await act(projectId);
        if (get().projectId === projectId) {
          set((state) => ({ project: { ...state.project, state: next } }));
        }
        done = true;
      } catch (error) {
        if (get().projectId === projectId) set({ notice: describe(error) });
      }
      if (get().projectId !== projectId) return done;
      set({ mutation: null });
      await get().refresh();
      return done;
    };

    return {
      projectId: null,
      library: EMPTY_LIBRARY,
      project: EMPTY_PROJECT,
      mutation: null,
      notice: null,

      async open(projectId) {
        if (get().projectId === projectId) return;
        epoch += 1;
        inFlight?.abort();
        inFlight = null;
        set({
          projectId,
          library: EMPTY_LIBRARY,
          project: EMPTY_PROJECT,
          mutation: null,
          notice: null,
        });
        await get().refresh();
      },

      async refresh() {
        const { projectId } = get();
        if (!projectId) return;
        epoch += 1;
        const mine = epoch;
        inFlight?.abort();
        const controller = new AbortController();
        inFlight = controller;
        const { signal } = controller;
        set((state) => ({
          library: { ...state.library, status: "loading", error: null },
          project: { ...state.project, status: "loading", error: null },
        }));

        const loadProject = async () => {
          try {
            const state = await client.getProject(projectId, signal);
            // The snapshot's own tokens are the truth about what the project carries (the library may be newer).
            let facts: SnapshotFacts | null = null;
            if (state.attached && state.snapshotOk) {
              try {
                facts = snapshotFacts(await client.snapshotTokens(projectId, signal));
              } catch (error) {
                if (error instanceof DesignApiError && error.code === "aborted") throw error;
              }
            }
            if (mine !== epoch) return;
            set({ project: { status: "ready", state, facts, error: null } });
          } catch (error) {
            if (mine !== epoch || (error instanceof DesignApiError && error.code === "aborted")) {
              return;
            }
            set((current) => ({
              project: { ...current.project, status: "error", error: describe(error).message },
            }));
          }
        };
        const loadLibrary = async () => {
          try {
            const systems = await client.listLibrary(signal);
            if (mine !== epoch) return;
            set({ library: { status: "ready", systems, error: null } });
          } catch (error) {
            if (mine !== epoch || (error instanceof DesignApiError && error.code === "aborted")) {
              return;
            }
            set((current) => ({
              library: { ...current.library, status: "error", error: describe(error).message },
            }));
          }
        };
        await Promise.all([loadProject(), loadLibrary()]);
        if (mine === epoch) inFlight = null;
      },

      attach: (id) => run({ kind: "attach", id }, (projectId) => client.attach(projectId, id)),
      update: () => run({ kind: "update" }, (projectId) => client.update(projectId)),
      detach: () => run({ kind: "detach" }, (projectId) => client.detach(projectId)),
      dismissNotice: () => set({ notice: null }),
    };
  });
}
