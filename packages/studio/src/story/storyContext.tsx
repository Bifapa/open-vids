import { createContext, useContext, type ReactNode } from "react";
import { useStore } from "zustand";
import { createStoryClient, type StoryClient } from "./storyClient";
import { createStoryStore, type StoryState, type StoryStore } from "./storyStore";

export const studioStoryClient: StoryClient = createStoryClient();

/**
 * Studio's one Story store. It follows the open project (`open(projectId)`); the agent's editor context and the
 * app hotkeys read it directly, the Story panel through the context below (tests provide their own).
 */
export const studioStoryStore: StoryStore = createStoryStore({ client: studioStoryClient });

interface StoryServices {
  store: StoryStore;
  client: StoryClient;
}

const StoryContext = createContext<StoryServices>({
  store: studioStoryStore,
  client: studioStoryClient,
});

export function StoryProvider({
  store,
  client,
  children,
}: StoryServices & { children: ReactNode }) {
  return <StoryContext.Provider value={{ store, client }}>{children}</StoryContext.Provider>;
}

export function useStoryServices(): StoryServices {
  return useContext(StoryContext);
}

export function useStoryStore<T>(selector: (state: StoryState) => T): T {
  return useStore(useStoryServices().store, selector);
}
