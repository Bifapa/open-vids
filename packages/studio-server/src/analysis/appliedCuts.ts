import { readFile, stat } from "node:fs/promises";
import type { CutApplication } from "@hyperframes/agent-protocol";
import { isInHiddenOrVendorDir, resolveWithinProject, walkDir } from "../helpers/safePath.js";

const MAIN_COMPOSITION = "index.html";
/** Stamped by `build_rough_cut` on the clips of a cut plan (`data-ov-cut`). */
const CUT_ATTRIBUTE = /\bdata-ov-cut\s*=\s*["'](cut-[1-9][0-9]*)["']/g;
const MAX_COMPOSITION_BYTES = 8 * 1024 * 1024;

/** Composition files of the project: the main one first, then the others by path. */
export function compositionFiles(projectDir: string): string[] {
  const files = walkDir(projectDir).filter(
    (file) =>
      file.endsWith(".html") && !isInHiddenOrVendorDir(file) && !file.startsWith("renders/"),
  );
  return files.sort((a, b) =>
    a === MAIN_COMPOSITION ? -1 : b === MAIN_COMPOSITION ? 1 : a.localeCompare(b),
  );
}

/**
 * Where each cut plan is on a timeline right now, read from the clips stamped with the plan's id: a reverted or
 * deleted rough cut is not reported. A plan present in several compositions is reported for the first one (main
 * composition first).
 */
export async function readAppliedCuts(projectDir: string): Promise<Map<string, CutApplication>> {
  const applied = new Map<string, CutApplication>();
  for (const file of compositionFiles(projectDir)) {
    const abs = resolveWithinProject(projectDir, file);
    if (!abs) continue;
    const info = await stat(abs).catch(() => null);
    if (!info?.isFile() || info.size > MAX_COMPOSITION_BYTES) continue;
    const source = await readFile(abs, "utf-8").catch(() => "");
    if (!source.includes("data-ov-cut")) continue;
    const counts = new Map<string, number>();
    for (const match of source.matchAll(CUT_ATTRIBUTE)) {
      const id = match[1];
      if (id) counts.set(id, (counts.get(id) ?? 0) + 1);
    }
    for (const [id, clips] of counts) {
      if (!applied.has(id)) applied.set(id, { composition: file, clips });
    }
  }
  return applied;
}
