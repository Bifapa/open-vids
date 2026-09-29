import { existsSync } from "node:fs";
import { join } from "node:path";
import { installItem, listRegistryItems, loadAllItems } from "../registry/index.js";
import { resolveItemWithDependencies } from "../registry/resolver.js";
import { gateRegistryItemsCompatibility } from "../registry/compatibility.js";

export interface LocalTemplateInfo {
  id: string;
  label: string;
  hint: string;
}

/**
 * List the example templates available in the bundled local registry.
 * Local-only: no network, no download.
 */
export async function listLocalTemplates(): Promise<LocalTemplateInfo[]> {
  const entries = await listRegistryItems({ type: "hyperframes:example" });
  const items = await loadAllItems(entries);
  return items.map((item) => ({
    id: item.name,
    label: item.title,
    hint: item.description,
  }));
}

/**
 * Install a local example template into destDir.
 *
 * Resolves the template's transitive `registryDependencies` and installs them
 * before the template itself, so a template that depends on other registry
 * items gets a complete install rather than silently dropping its deps.
 *
 * Every resolved item is compatibility-gated up front (same gate as
 * `hyperframes add`), so an incompatible template — or any of its deps —
 * aborts before a single file is written.
 */
export async function fetchLocalTemplate(templateId: string, destDir: string): Promise<void> {
  const items = await resolveItemWithDependencies(templateId);
  const warnings = gateRegistryItemsCompatibility(items);
  for (const warning of warnings) {
    process.stderr.write(`hyperframes:registry ${warning}\n`);
  }
  for (const item of items) {
    await installItem(item, { destDir });
  }

  // Safety check — an item with no index.html isn't a valid example.
  if (!existsSync(join(destDir, "index.html"))) {
    throw new Error(
      `Example "${templateId}" installed but missing index.html. The registry item may be malformed.`,
    );
  }
}
