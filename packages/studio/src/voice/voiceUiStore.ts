import { create } from "zustand";
import type { VoicePreset } from "@hyperframes/agent-protocol";

/** What opens the voice setup window: the script it is for, and who hears about the voice the user saved. */
export interface VoiceSetupRequest {
  /** BCP-47 language of the script: the catalog opens filtered by it. */
  language: string | null;
  /** The phrase every sample speaks (editable in the window). Empty: Studio's own phrase. */
  sampleText: string;
  /** The agent's proposal for the voice's character, shown above the choices. */
  suggestion: string;
  /** A voice to start from (the project's current voice, a library preset). */
  startFrom: VoicePreset | null;
  /** Called with the preset the user saved; not called when the window closes without one. */
  onSaved?: (preset: VoicePreset) => void;
}

interface VoiceUiState {
  setup: VoiceSetupRequest | null;
  openSetup(request?: Partial<VoiceSetupRequest>): void;
  closeSetup(): void;
}

/**
 * The modal of the voice surface. A chat card or Settings only asks for the window; `VoiceHost`, mounted once
 * beside the chat, shows it (the same pattern as the design dialogs).
 */
export const useVoiceUi = create<VoiceUiState>((set) => ({
  setup: null,
  openSetup: (request = {}) =>
    set({
      setup: {
        language: request.language ?? null,
        sampleText: request.sampleText ?? "",
        suggestion: request.suggestion ?? "",
        startFrom: request.startFrom ?? null,
        ...(request.onSaved && { onSaved: request.onSaved }),
      },
    }),
  closeSetup: () => set({ setup: null }),
}));
