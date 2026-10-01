/**
 * The project's Sources/Licenses view (`GET /api/projects/:id/research/sources`), shared by the Sources panel, the
 * Story workspace's license chips and the export check. The records live in `.hyperframes/research/provenance.json`,
 * which only the server reads; the store reloads whenever something may have changed it (an agent turn ended or was
 * reverted, project files changed, the panel came into view).
 */

import { createStore, type StoreApi } from "zustand/vanilla";
import type { ProjectSourcesView } from "@hyperframes/agent-protocol";
import { t } from "../i18n";
import type { ResearchClient } from "./researchClient";

export type SourcesLoadStatus = "idle" | "loading" | "ready" | "error";

export interface SourcesState {
  projectId: string | null;
  status: SourcesLoadStatus;
  view: ProjectSourcesView | null;
  /** The last load's failure; with a view, the view is the previous good one. */
  error: string | null;
  /** The asset the Sources panel should bring into view (the Story inspector's "Show in Sources"). */
  revealed: string | null;
  open(projectId: string): Promise<void>;
  reload(): Promise<void>;
  reveal(asset: string | null): void;
}

export type SourcesStore = StoreApi<SourcesState>;

export function createSourcesStore(client: ResearchClient): SourcesStore {
  // Only the newest request may land: a slow answer for an older project or state must not overwrite it.
  let generation = 0;
  return createStore<SourcesState>()((set, get) => ({
    projectId: null,
    status: "idle",
    view: null,
    error: null,
    revealed: null,

    async open(projectId) {
      if (get().projectId !== projectId) {
        generation += 1;
        set({ projectId, status: "idle", view: null, error: null, revealed: null });
      }
      await get().reload();
    },

    async reload() {
      const { projectId } = get();
      if (!projectId) return;
      generation += 1;
      const mine = generation;
      if (!get().view) set({ status: "loading" });
      try {
        const view = await client.sources(projectId);
        if (mine !== generation) return;
        set({ view, status: "ready", error: null });
      } catch (error) {
        if (mine !== generation) return;
        const message = error instanceof Error ? error.message : t("research.error.sources");
        set((state) => ({ status: state.view ? "ready" : "error", error: message }));
      }
    },

    reveal(asset) {
      set({ revealed: asset });
    },
  }));
}
