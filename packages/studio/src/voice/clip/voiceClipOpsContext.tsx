import { createContext, useContext } from "react";
import type { VoiceClipOps } from "./useVoiceClipOps";

const VoiceClipOpsContext = createContext<VoiceClipOps | null>(null);

/** Provided where the Studio timeline's writes are in reach (the right panels); absent in a bare mount. */
export const VoiceClipOpsProvider = VoiceClipOpsContext.Provider;

/** The timeline writes of the voiceover surfaces, or null outside Studio's panels (nothing then touches a clip). */
export function useVoiceClipOpsContext(): VoiceClipOps | null {
  return useContext(VoiceClipOpsContext);
}
