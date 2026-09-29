// The registry resolver (packages/cli/src/registry/) is the canonical
// implementation. Converts RegistryItem manifests back into the TemplateOption
// shape the init wizard uses.

import { listRegistryItems, loadAllItems } from "../registry/index.js";

export type TemplateSource = "bundled" | "local";

export interface TemplateOption {
  id: string;
  label: string;
  hint: string;
  source: TemplateSource;
}

/** Templates bundled in the CLI package (available offline). */
export const BUNDLED_TEMPLATES: TemplateOption[] = [
  {
    id: "blank",
    label: "Blank",
    hint: "Centered Inter stage, paused timeline",
    source: "bundled",
  },
];

/**
 * Resolve the full template list by merging bundled templates with local
 * registry examples. Fully offline — no network.
 */
export async function resolveTemplateList(): Promise<TemplateOption[]> {
  const bundled = [...BUNDLED_TEMPLATES];
  const bundledIds = new Set(bundled.map((t) => t.id));

  const entries = await listRegistryItems({ type: "hyperframes:example" });
  const items = await loadAllItems(entries);

  const localOptions: TemplateOption[] = items
    .filter((item) => !bundledIds.has(item.name))
    .map((item) => ({
      id: item.name,
      label: item.title,
      hint: item.description,
      source: "local" as const,
    }));

  return [...bundled, ...localOptions];
}
