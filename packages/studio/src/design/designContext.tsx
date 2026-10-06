import { createContext, useContext, type ReactNode } from "react";
import { useStore } from "zustand";
import { createDesignClient } from "./designClient";
import { createDesignStore, type DesignState, type DesignStore } from "./designStore";

/**
 * Studio's one design store: the header's popover, the dialogs and the chat's "Attach" card read the same state,
 * and `DesignHost` keeps it on the open project. Tests provide their own through `DesignProvider`.
 */
export const studioDesignStore: DesignStore = createDesignStore({ client: createDesignClient() });

const DesignContext = createContext<DesignStore>(studioDesignStore);

export function DesignProvider({ store, children }: { store: DesignStore; children: ReactNode }) {
  return <DesignContext.Provider value={store}>{children}</DesignContext.Provider>;
}

export function useDesignStoreApi(): DesignStore {
  return useContext(DesignContext);
}

export function useDesignStore<T>(selector: (state: DesignState) => T): T {
  return useStore(useDesignStoreApi(), selector);
}
