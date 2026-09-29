/**
 * Append (or, on reapply, replace in place) a preset's nodes onto a chain —
 * the write path the property panel's FX section and the timeline FX
 * popover (C1) both use, so a preset applied from either surface lands
 * the same chain.
 */

import { applyAudioFxPreset, getAudioFxPreset } from "@hyperframes/core/audio-fx-presets";
import type { HfAudioFxChain } from "@hyperframes/core/audio-fx";

export function applyPresetToChain(chain: HfAudioFxChain, presetId: string): HfAudioFxChain | null {
  const preset = getAudioFxPreset(presetId);
  if (!preset) return null;
  // Appends. Stacking a character preset onto an already-cleaned voice is a
  // real thing to want, and replacing silently would throw work away — so
  // the destructive option is a separate gesture, not the default one.
  return applyAudioFxPreset(chain, preset);
}
