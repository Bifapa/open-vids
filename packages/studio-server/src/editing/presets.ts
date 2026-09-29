import type { PresetInfo, PresetKind } from "@hyperframes/agent-protocol";
import type { StudioApiAdapter } from "../types.js";
import { listCaptionPresets } from "./captions.js";

export const MAX_PRESETS = 100;

/** Caption skins, registry blocks and registry components matching `query` (name, title or tag), at most 100. */
export async function listPresets(
  adapter: StudioApiAdapter,
  filter: { kind?: PresetKind; query?: string },
): Promise<PresetInfo[]> {
  const wants = (kind: PresetKind) => filter.kind === undefined || filter.kind === kind;
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

  const query = filter.query?.trim().toLowerCase();
  const matching = query
    ? presets.filter((preset) =>
        [preset.name, preset.title, ...preset.tags].some((text) =>
          text.toLowerCase().includes(query),
        ),
      )
    : presets;
  return matching.slice(0, MAX_PRESETS);
}
