import { stat } from "node:fs/promises";
import { isInHiddenOrVendorDir, resolveWithinProject, walkDir } from "../helpers/safePath.js";
import { assetKindOf } from "../editing/mediaFacts.js";
import { sampledHash } from "./fingerprint.js";
import type { AnalysisStore, SourceManifest } from "./store.js";

export interface OrphanReport {
  /** Source paths whose analysis folder was removed. */
  sources: string[];
  /** Cut plans dropped because their source file is gone. */
  cuts: string[];
}

const artifactCount = (manifest: SourceManifest): number =>
  Object.keys(manifest.stages).length + (manifest.asr ? 1 : 0);

async function exists(projectDir: string, path: string): Promise<boolean> {
  const abs = resolveWithinProject(projectDir, path);
  if (!abs) return false;
  return (await stat(abs).catch(() => null))?.isFile() === true;
}

/**
 * Removes analysis nobody can use any more.
 *
 * A source folder goes when its file is gone and no current media file of the project has the same content (size and
 * sampled hash): a renamed file adopts the artifacts of its old name (`findTwin`), so those stay until the new name
 * holds at least as much analysis itself. Cut plans whose source file is gone are dropped; the id counter is kept.
 */
export async function removeOrphans(store: AnalysisStore): Promise<OrphanReport> {
  const projectDir = store.projectDir;
  const manifests = await store.listManifests();
  const gone: SourceManifest[] = [];
  for (const manifest of manifests) {
    if (!(await exists(projectDir, manifest.path))) gone.push(manifest);
  }
  const report: OrphanReport = { sources: [], cuts: [] };

  if (gone.length > 0) {
    const media = walkDir(projectDir).filter(
      (file) =>
        !isInHiddenOrVendorDir(file) &&
        !file.startsWith("renders/") &&
        ["video", "audio"].includes(assetKindOf(file)),
    );
    const sizes = new Map<string, number>();
    for (const file of media) {
      const abs = resolveWithinProject(projectDir, file);
      const info = abs ? await stat(abs).catch(() => null) : null;
      if (info?.isFile()) sizes.set(file, info.size);
    }
    const hashes = new Map<string, string>();
    const hashOf = async (file: string): Promise<string | null> => {
      const cached = hashes.get(file);
      if (cached !== undefined) return cached;
      const abs = resolveWithinProject(projectDir, file);
      const size = sizes.get(file);
      if (!abs || size === undefined) return null;
      const hash = await sampledHash(abs, size).catch(() => null);
      if (hash !== null) hashes.set(file, hash);
      return hash;
    };
    for (const manifest of gone) {
      let successor: string | null = null;
      for (const file of media) {
        if (sizes.get(file) !== manifest.fingerprint.bytes) continue;
        if ((await hashOf(file)) === manifest.fingerprint.hash) {
          successor = file;
          break;
        }
      }
      if (successor !== null) {
        const adopted = manifests.find((entry) => entry.path === successor);
        if (!adopted || artifactCount(adopted) < artifactCount(manifest)) continue;
      }
      await store.locked(manifest.path, () => store.wipeSource(manifest.path));
      report.sources.push(manifest.path);
    }
  }

  const missing = new Set<string>();
  for (const plan of await store.listCuts()) {
    if (!missing.has(plan.source) && !(await exists(projectDir, plan.source))) {
      missing.add(plan.source);
    }
  }
  if (missing.size > 0) report.cuts = await store.dropCuts((plan) => missing.has(plan.source));
  return report;
}
