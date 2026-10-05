import type { PresetInfo, PresetKind } from "@hyperframes/agent-protocol";
import { HF_AUDIO_FX_PRESETS } from "@hyperframes/core/audio-fx-presets";
import {
  HF_COLOR_GRADING_EFFECT_PRESETS,
  HF_COLOR_GRADING_PRESETS,
} from "@hyperframes/core/color-grading";
import type { StudioApiAdapter } from "../types.js";
import { listCaptionPresets } from "./captions.js";

export const MAX_PRESETS = 100;

/** The kinds a query without `kind` covers; the clip-look kinds are listed only when asked for. */
const DEFAULT_KINDS: readonly PresetKind[] = ["caption", "block", "component"];

function colorGradePresets(): PresetInfo[] {
  return HF_COLOR_GRADING_PRESETS.map((preset) => ({
    name: preset.id,
    kind: "color_grade" as const,
    title: preset.label,
    description: HF_COLOR_GRADING_EFFECT_PRESETS.includes(preset)
      ? "A stylised look with an effect (grain, glitch, print …)."
      : "A colour grade.",
    tags: [HF_COLOR_GRADING_EFFECT_PRESETS.includes(preset) ? "effect" : "grade"],
    duration: null,
  }));
}

function audioFxPresets(): PresetInfo[] {
  return HF_AUDIO_FX_PRESETS.map((preset) => ({
    name: preset.id,
    kind: "audio_fx" as const,
    title: preset.label,
    description: preset.description,
    tags: [preset.family],
    duration: null,
  }));
}

/** Presets matching `query` (name, title or tag) of the wanted kind(s): every match, in catalog order. */
async function matchingPresets(
  adapter: StudioApiAdapter,
  filter: { kind?: PresetKind; query?: string },
): Promise<PresetInfo[]> {
  const wants = (kind: PresetKind) =>
    filter.kind === undefined ? DEFAULT_KINDS.includes(kind) : filter.kind === kind;
  const presets: PresetInfo[] = [];

  if (wants("caption")) {
    const skinsDir = adapter.captionSkinsDir?.() ?? null;
    if (skinsDir) presets.push(...listCaptionPresets(skinsDir));
  }
  if ((wants("block") || wants("component")) && adapter.listRegistryCatalog) {
    for (const item of await adapter.listRegistryCatalog()) {
      const kind: PresetKind | null =
        item.type === "hyperframes:block"
          ? "block"
          : item.type === "hyperframes:component"
            ? "component"
            : null;
      if (kind === null || !wants(kind)) continue;
      presets.push({
        name: item.name,
        kind,
        title: item.title,
        description: item.description,
        tags: item.tags ?? [],
        duration: item.type === "hyperframes:block" ? item.duration : null,
      });
    }
  }
  if (wants("color_grade")) presets.push(...colorGradePresets());
  if (wants("audio_fx")) presets.push(...audioFxPresets());

  const query = filter.query?.trim().toLowerCase();
  return query
    ? presets.filter((preset) =>
        [preset.name, preset.title, ...preset.tags].some((text) =>
          text.toLowerCase().includes(query),
        ),
      )
    : presets;
}

/** Caption skins, registry blocks and registry components matching `query`, at most 100. */
export async function listPresets(
  adapter: StudioApiAdapter,
  filter: { kind?: PresetKind; query?: string },
): Promise<PresetInfo[]> {
  return (await matchingPresets(adapter, filter)).slice(0, MAX_PRESETS);
}

/** One page of the matching presets plus how many match in all (the route's paged answer). */
export async function pagePresets(
  adapter: StudioApiAdapter,
  filter: { kind?: PresetKind; query?: string },
  page: { offset: number; limit: number },
): Promise<{ presets: PresetInfo[]; total: number }> {
  const all = await matchingPresets(adapter, filter);
  return { presets: all.slice(page.offset, page.offset + page.limit), total: all.length };
}
