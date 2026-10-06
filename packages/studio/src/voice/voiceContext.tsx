import { createContext, useContext, type ReactNode } from "react";
import { useStore } from "zustand";
import { createVoiceClient, type VoiceClient } from "./voiceClient";
import { createVoiceStore, type VoiceState, type VoiceStore } from "./voiceStore";

export const studioVoiceClient: VoiceClient = createVoiceClient();

/**
 * Studio's one voice store: Settings › Voice, the setup window and the chat's connect step read the same providers
 * and presets, so a key saved in one shows in the others. Tests provide their own through `VoiceProvider`.
 */
export const studioVoiceStore: VoiceStore = createVoiceStore(studioVoiceClient);

interface VoiceServices {
  client: VoiceClient;
  store: VoiceStore;
}

const VoiceContext = createContext<VoiceServices>({
  client: studioVoiceClient,
  store: studioVoiceStore,
});

export function VoiceProvider({
  client,
  store,
  children,
}: VoiceServices & { children: ReactNode }) {
  return <VoiceContext.Provider value={{ client, store }}>{children}</VoiceContext.Provider>;
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
