import { existsSync, readFileSync, statSync } from "node:fs";
import { posix } from "node:path";
import type { ProjectAsset, TimelineSnapshot } from "@hyperframes/agent-protocol";
import { resolveWithinProject } from "../helpers/safePath.js";
import type { ResolvedProject } from "../types.js";
import { EditFailure } from "./errors.js";
import { MAIN_COMPOSITION } from "./inventory.js";
import type { MediaFacts } from "./mediaFacts.js";
import {
  clipMediaPaths,
  parseComposition,
  resolveClipDurations,
  resolveProjectRelative,
  toSnapshot,
  type CompositionModel,
} from "./timeline.js";

/** A project-relative composition path from a request (`./a.html`, `a.html`), or the main composition. */
export function normalizeCompositionPath(raw: string | undefined): string {
  const trimmed = raw?.trim();
  if (!trimmed) return MAIN_COMPOSITION;
  const path = resolveProjectRelative(MAIN_COMPOSITION, trimmed);
  if (path === null) {
    throw new EditFailure("unknown_composition", `"${trimmed}" is not a path inside the project`);
  }
  return posix.normalize(path);
}

export interface ReadComposition {
  content: string;
  /** Parsed, with every clip's duration resolved. */
  model: CompositionModel;
  snapshot: TimelineSnapshot;
}

/** One composition file as it is on disk right now: its text, parsed model and wire snapshot. */
export async function readComposition(
  project: ResolvedProject,
  compositionPath: string,
  facts: MediaFacts,
): Promise<ReadComposition> {
  const abs = resolveWithinProject(project.dir, compositionPath);
  if (!abs || !compositionPath.endsWith(".html") || !existsSync(abs) || !statSync(abs).isFile()) {
    throw new EditFailure("unknown_composition", `No composition "${compositionPath}"`);
  }
  const content = readFileSync(abs, "utf-8");
  const model = parseComposition(content, compositionPath);
  if (!model) {
    throw new EditFailure(
      "unknown_composition",
      `${compositionPath} is not a composition (no data-composition-id)`,
    );
  }
  await facts.readMany(project.dir, clipMediaPaths(model));
  const lookup = (media: string) => facts.peek(project.dir, media);
  resolveClipDurations(model, lookup);
  return { content, model, snapshot: toSnapshot(model, compositionPath, content, lookup) };
}

/** The timeline of one composition file as it is on disk right now. */
export async function readTimeline(
  project: ResolvedProject,
  compositionPath: string,
  facts: MediaFacts,
): Promise<TimelineSnapshot> {
  return (await readComposition(project, compositionPath, facts)).snapshot;
}

/** Facts of any project-relative file, renders included. */
export async function probeProjectFile(
  project: ResolvedProject,
  rawPath: string,
  facts: MediaFacts,
): Promise<ProjectAsset> {
  const path = resolveProjectRelative(MAIN_COMPOSITION, rawPath);
  const asset = path === null ? null : await facts.read(project.dir, path);
  if (!asset) throw new EditFailure("unknown_asset", `No file "${rawPath}" in this project`);
  return asset;
}
