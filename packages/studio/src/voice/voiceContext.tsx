import { createContext, useContext, useMemo, type ReactNode } from "react";
import { useStore } from "zustand";
import { createVoiceClient, type VoiceClient } from "./voiceClient";
import { createVoiceStore, type VoiceState, type VoiceStore } from "./voiceStore";
import {
  createVoiceScriptStore,
  type VoiceScriptState,
  type VoiceScriptStore,
} from "./script/voiceScriptStore";

export const studioVoiceClient: VoiceClient = createVoiceClient();

/**
 * Studio's one voice store: Settings › Voice, the setup window and the chat's connect step read the same providers
 * and presets, so a key saved in one shows in the others. Tests provide their own through `VoiceProvider`.
 */
export const studioVoiceStore: VoiceStore = createVoiceStore(studioVoiceClient);

/** The open project's script and takes: the Voiceover tab and the voice clip's inspector read the same one. */
export const studioVoiceScriptStore: VoiceScriptStore = createVoiceScriptStore(studioVoiceClient);

interface VoiceServices {
  client: VoiceClient;
  store: VoiceStore;
  scripts: VoiceScriptStore;
}

const VoiceContext = createContext<VoiceServices>({
  client: studioVoiceClient,
  store: studioVoiceStore,
  scripts: studioVoiceScriptStore,
});

export function VoiceProvider({
  client,
  store,
  scripts,
  children,
}: Omit<VoiceServices, "scripts"> & { scripts?: VoiceScriptStore; children: ReactNode }) {
  // A test that only fakes the client still gets a script store on it.
  const own = useMemo(() => scripts ?? createVoiceScriptStore(client), [scripts, client]);
  const value = useMemo(() => ({ client, store, scripts: own }), [client, store, own]);
  return <VoiceContext.Provider value={value}>{children}</VoiceContext.Provider>;
}

export function useVoiceClient(): VoiceClient {
  return useContext(VoiceContext).client;
}

export function useVoiceStoreApi(): VoiceStore {
  return useContext(VoiceContext).store;
}

export function useVoiceStore<T>(selector: (state: VoiceState) => T): T {
  return useStore(useVoiceStoreApi(), selector);
}

export function useVoiceScriptStoreApi(): VoiceScriptStore {
  return useContext(VoiceContext).scripts;
}

export function useVoiceScriptStore<T>(selector: (state: VoiceScriptState) => T): T {
  return useStore(useVoiceScriptStoreApi(), selector);
}
