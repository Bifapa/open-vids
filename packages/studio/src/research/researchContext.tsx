import { createContext, useContext, type ReactNode } from "react";
import { useStore } from "zustand";
import { createResearchClient, type ResearchClient } from "./researchClient";
import { createSourcesStore, type SourcesState, type SourcesStore } from "./sourcesStore";

export const studioResearchClient: ResearchClient = createResearchClient();

/**
 * Studio's one project Sources store. It follows the open project; the Sources panel, the Story workspace and the
 * export check read it through the context below (tests provide their own).
 */
export const studioSourcesStore: SourcesStore = createSourcesStore(studioResearchClient);

interface ResearchServices {
  store: SourcesStore;
  client: ResearchClient;
}

const ResearchContext = createContext<ResearchServices>({
  store: studioSourcesStore,
  client: studioResearchClient,
});

export function ResearchProvider({
  store,
  client,
  children,
}: ResearchServices & { children: ReactNode }) {
  return <ResearchContext.Provider value={{ store, client }}>{children}</ResearchContext.Provider>;
}

export function useResearchServices(): ResearchServices {
  return useContext(ResearchContext);
}

export function useSourcesStore<T>(selector: (state: SourcesState) => T): T {
  return useStore(useResearchServices().store, selector);
}
