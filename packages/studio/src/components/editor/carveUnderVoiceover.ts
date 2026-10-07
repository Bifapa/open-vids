/**
 * The voiceover carve for a bed the inspector is not showing: the same measurement and the same chain and lanes
 * `useFxCarve` writes for the selected track, computed for a clip taken from the timeline. It only measures: the
 * caller writes the attributes (one undo entry for every bed) and reloads the preview.
 */

import type { HfAutomation } from "@hyperframes/core/audio-automation";
import {
  HF_AUDIO_FX_ATTR,
  parseAudioFxChain,
  serializeAudioFxChain,
  type HfAudioFxChain,
} from "@hyperframes/core/audio-fx";
import {
  DEFAULT_CARVE,
  HF_AUDIO_CARVE_ATTR,
  normalizeCarveSettings,
  type HfCarveSettings,
} from "@hyperframes/core/audio-carve";
import { resolveCarveSourceIds } from "@hyperframes/core/audio-groups";
import {
  automationAttrValue,
  HF_AUDIO_AUTOMATION_ATTR,
  readPanelAutomation,
} from "./propertyPanelAutomation";
import { resolveCarveVoices, withoutCarveLanes } from "./useFxCarve.js";
import { carveLanes, measureCarve, mintCarveNodes } from "./useFxCarveNodes.js";

export type VoiceoverCarve =
  | {
      kind: "carved";
      carve: HfCarveSettings;
      /** What to write on the bed: the carve setting, the filters and the envelopes (null removes the attribute). */
      attributes: Record<string, string | null>;
    }
  /** The group has no clip with a file to listen to. */
  | { kind: "no-voices" }
  /** The platform cannot decode audio, or the voices decoded to silence. */
  | { kind: "unmeasurable" };

function readCarve(raw: string | null): HfCarveSettings | null {
  if (!raw) return null;
  try {
    return normalizeCarveSettings(JSON.parse(raw));
  } catch {
    return null;
  }
}

function readChain(raw: string | null): HfAudioFxChain {
  if (!raw) return { version: 1, nodes: [] };
  try {
    return parseAudioFxChain(raw);
  } catch {
    return { version: 1, nodes: [] };
  }
}

/**
 * Measures the voices of `groupId` against `bed` (a live `<audio>` of the preview document) and says what the bed
 * has to carry to make room for them. A carve the bed already has keeps its strength and its other sources; the
 * group is added to them and the carve is switched on.
 */
export async function measureVoiceoverCarve(
  doc: Document,
  bed: Element,
  groupId: string,
): Promise<VoiceoverCarve> {
  const existing = readCarve(bed.getAttribute(HF_AUDIO_CARVE_ATTR));
  const carve: HfCarveSettings = {
    ...(existing ?? DEFAULT_CARVE),
    enabled: true,
    sources: [...new Set([...(existing?.sources ?? []), groupId])],
  };
  // The bed is never one of its own voices, whatever group it is in.
  const voiceIds = resolveCarveSourceIds(doc, carve.sources).filter((id) => id !== bed.id);
  const voices = resolveCarveVoices(doc, voiceIds);
  if (voices.length === 0) return { kind: "no-voices" };

  const measured = await measureCarve(
    doc,
    voices,
    carve.strength,
    bed.getAttribute("data-start"),
    bed.getAttribute("src"),
  );
  if (!measured) return { kind: "unmeasurable" };

  const chain = readChain(bed.getAttribute(HF_AUDIO_FX_ATTR));
  const automation = readPanelAutomation(
    bed.getAttribute(HF_AUDIO_AUTOMATION_ATTR) ?? undefined,
    chain,
  );
  const { next, carvedNodes, duckNode } = mintCarveNodes(chain, measured.carved, measured.duck);
  const lanes = carveLanes(carvedNodes, duckNode, measured.duck, measured.voiceMix, measured.bands);
  const nextAutomation: HfAutomation = {
    version: 1,
    lanes: [...withoutCarveLanes(automation, chain).lanes, ...lanes],
  };
  return {
    kind: "carved",
    carve,
    attributes: {
      [HF_AUDIO_CARVE_ATTR]: JSON.stringify(carve),
      [HF_AUDIO_FX_ATTR]: serializeAudioFxChain(next),
      [HF_AUDIO_AUTOMATION_ATTR]: automationAttrValue(nextAutomation) || null,
    },
  };
}
