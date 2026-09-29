/**
 * Local Registry Reader
 *
 * OpenVids is local-first: the canonical registry is the `registry/` tree,
 * resolved from the filesystem at runtime. No network, no cache, no startup
 * fetch.
 *
 * Resolution order for the registry root:
 *   1. `OPENVIDS_REGISTRY_DIR` env override (tests, dev tooling)
 *   2. `registry/` beside the built CLI (`dist/registry`, staged by
 *      build-copy.mjs and shipped inside the desktop runtime)
 *   3. `<repoRoot>/registry` found by walking up from the CLI module for a
 *      directory containing `registry/registry.json` (dev checkout)
 */

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { readBoundedRegistryFile } from "./boundedFile.js";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ITEM_TYPE_DIRS, type ItemType, type RegistryItem } from "@hyperframes/core";
import { validRegistryItem, validRegistryManifest } from "./validation.js";

/** Basename of an item's manifest within its directory. */
export const REGISTRY_ITEM_FILENAME = "registry-item.json";

/** Root of the bundled registry tree, or null when it cannot be found. */
export function localRegistryRoot(cwd = process.cwd()): string | null {
  const override = process.env["OPENVIDS_REGISTRY_DIR"];
  if (override) {
    const dir = isAbsolute(override) ? override : resolve(cwd, override);
    if (existsSync(join(dir, "registry.json"))) return dir;
    return null;
  }
  let here: string | null = null;
  try {
    here = dirname(fileURLToPath(import.meta.url));
  } catch {
    here = null;
  }
  if (here) {
    const bundled = resolve(here, "registry");
    if (existsSync(join(bundled, "registry.json"))) return bundled;
    let dir = resolve(here);
    for (let i = 0; i < 16; i++) {
      if (existsSync(join(dir, "registry", "registry.json"))) return join(dir, "registry");
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }
  return null;
}

/** Upper bound for a single registry manifest read (10 MB — manifests are KB-scale). */
const MAX_MANIFEST_BYTES = 10 * 1024 * 1024;

export function readLocalItem(root: string, name: string, type: ItemType): RegistryItem | null {
  const manifestPath = join(root, ITEM_TYPE_DIRS[type], name, REGISTRY_ITEM_FILENAME);
  let data: unknown;
  try {
    data = JSON.parse(readBoundedRegistryFile(manifestPath, MAX_MANIFEST_BYTES).toString("utf8"));
  } catch {
    return null;
  }
  if (!validRegistryItem(data, name, type)) return null;
  return data;
}

/**
 * List every item in the local registry, optionally filtered by type.
 * Reads the top-level registry.json (falling back to a directory scan when
 * it is absent), then validates each item manifest. Invalid manifests are
 * skipped so one malformed item never empties the catalog.
 */
export function listLocalItems(
  root: string,
  filter?: { type?: ItemType },
): { name: string; type: ItemType }[] {
  let entries: { name: string; type: ItemType }[] | null = null;
  try {
    const manifest: unknown = JSON.parse(
      readBoundedRegistryFile(join(root, "registry.json"), MAX_MANIFEST_BYTES).toString("utf8"),
    );
    if (validRegistryManifest(manifest)) {
      entries = manifest.items.map((e) => ({ name: e.name, type: e.type }));
    }
  } catch {
    entries = null;
  }
  if (!entries) {
    entries = [];
    const types: ItemType[] = ["hyperframes:example", "hyperframes:block", "hyperframes:component"];
    for (const type of types) {
      let names: string[] = [];
      try {
        names = readdirSync(join(root, ITEM_TYPE_DIRS[type]), { withFileTypes: true })
          .filter((e) => e.isDirectory())
          .map((e) => e.name);
      } catch {
        continue;
      }
      for (const name of names) entries.push({ name, type });
    }
  }
  const filtered = filter?.type ? entries.filter((e) => e.type === filter.type) : entries;
  return filtered.filter((e) => readLocalItem(root, e.name, e.type) !== null);
}

/**
 * Read a source file's bytes from the local registry tree. Files that declare
 * an absolute `url` have no local bytes by definition — the caller decides
 * how to handle those (the installer refuses them with a clear error).
 */
export function readLocalItemFile(
  root: string,
  itemName: string,
  type: ItemType,
  filePath: string,
): Buffer | null {
  if (/(^|[/\\])\.\.([/\\]|$)/.test(filePath)) return null;
  try {
    return readFileSync(join(root, ITEM_TYPE_DIRS[type], itemName, filePath));
  } catch {
    return null;
  }
}
