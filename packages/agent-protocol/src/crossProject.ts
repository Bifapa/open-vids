import { isRecord } from "./validate.js";
import {
  PROJECT_FILE_PARTS,
  PROJECT_PARTS,
  type ProjectFilePart,
  type ProjectPart,
} from "./types.js";
import type { AssetProvenance, CancelRequestState } from "./research.js";

/**
 * Other projects as the Studio server serves them to the composer (`#` mentions) and to the runtime (the manifest the
 * agents read, and `import_from_project`). Every route is scoped to the open project (`/api/projects/:id/cross-project/…`)
 * and answers errors as `{ error: ResearchError }` (`unknown_project` for a key that matches no project).
 *
 *   GET  …/cross-project/projects                      → ExternalProjectList   (the other projects the user has opened)
 *   GET  …/cross-project/projects/:key/summary         → ProjectPartsSummary    (counts per part, no media probing)
 *   GET  …/cross-project/projects/:key/manifest?parts= → ProjectManifest        (files of the named parts + story synopsis)
 *   POST …/cross-project/import                        ImportFromProjectRequest → ImportFromProjectResult
 *   POST …/cross-project/requests/:requestId/cancel    → { requestId, state: CancelRequestState }
 *
 * `key` is the shell's per-folder key; the browser and the agents never see a path.
 */

/** Another project, as the list names it. */
export interface ExternalProjectEntry {
  key: string;
  name: string;
  /** When the user last opened it (epoch ms), when the shell knows. */
  openedAt?: number;
}

export interface ExternalProjectList {
  /** The projects other than the open one, most recently opened first. Empty when the host has no project list. */
  projects: ExternalProjectEntry[];
}

/** How many files (and, for the story, chapters) each part holds. */
export interface ProjectPartsSummary {
  key: string;
  name: string;
  counts: Record<ProjectFilePart, number> & { story: number };
}

export interface ProjectManifestFile {
  /** Path inside the other project. */
  path: string;
  part: ProjectFilePart;
  bytes: number;
  /** The license named by the file's provenance record in that project, when it has one. */
  license?: string;
}

export interface ProjectManifest {
  key: string;
  name: string;
  /** The parts the manifest was built for (`all` expanded). */
  parts: Array<ProjectFilePart | "story">;
  files: ProjectManifestFile[];
  /** More files matched than the manifest lists. */
  truncated: boolean;
  /** Chapters of the project's Story in order, as text; null when the part was not asked for or there is no story. */
  story: string | null;
}

export const PROJECT_MANIFEST_LIMITS = {
  /** Files one manifest lists. */
  files: 200,
  /** Characters of the story synopsis. */
  storyChars: 4_000,
  /** Files one import copies. */
  importFiles: 24,
  pathChars: 512,
} as const;

/** The concrete parts a reference's `parts` stand for (`all` is every part, the Story included). */
export function expandProjectParts(
  parts: readonly ProjectPart[],
): Array<ProjectFilePart | "story"> {
  if (parts.includes("all")) return [...PROJECT_FILE_PARTS, "story"];
  const named = new Set<string>(parts);
  const files = PROJECT_FILE_PARTS.filter((part) => named.has(part));
  return named.has("story") ? [...files, "story"] : files;
}

export function isProjectPart(value: unknown): value is ProjectPart {
  return PROJECT_PARTS.some((part) => part === value);
}

export function isProjectFilePart(value: unknown): value is ProjectFilePart {
  return PROJECT_FILE_PARTS.some((part) => part === value);
}

/** `parts=renders,music` of a manifest request; null when a name is unknown or none is given. */
export function parseManifestParts(value: string | undefined): ProjectPart[] | null {
  if (value === undefined || value.trim() === "") return null;
  const names = value.split(",").map((name) => name.trim());
  const parts = names.filter(isProjectPart);
  return parts.length === names.length && parts.length > 0 ? parts : null;
}

export interface ImportFromProjectRequest {
  /** The project to copy from (a `ProjectReference.projectKey`). */
  projectKey: string;
  /** Paths inside that project, as the manifest lists them. */
  files: string[];
  /** Lets the caller cancel the copy before it commits (research-import semantics). */
  requestId?: string;
  /** Recorded in the provenance of what carries over. */
  turnId?: string;
  agent?: string;
  model?: string;
}

export interface ImportedProjectFile {
  /** The path in the other project. */
  source: string;
  /** The path in this project (`assets/from/<project>/…`). */
  asset: string;
  bytes: number;
  /** `copied` now, or `existing`: this project already held the same bytes (at `asset`), nothing was added. */
  status: "copied" | "existing";
  /** The carried provenance record, when the source file had one. */
  provenance: AssetProvenance | null;
}

export interface ImportFromProjectResult {
  imported: ImportedProjectFile[];
  /** Files that were not copied, with the reason ("not a file of the project", "too large", …). */
  skipped: Array<{ source: string; reason: string }>;
}

export type ParsedImportFromProject =
  | { ok: true; value: ImportFromProjectRequest }
  | { ok: false; message: string };

const textOf = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim() !== "" ? value : undefined;

/** Validates `POST …/cross-project/import`. Duplicate paths are collapsed. */
export function parseImportFromProjectRequest(body: unknown): ParsedImportFromProject {
  if (!isRecord(body)) return { ok: false, message: "body must be a JSON object" };
  const projectKey = textOf(body.projectKey);
  if (projectKey === undefined || projectKey.length > 64) {
    return { ok: false, message: "projectKey is required" };
  }
  const { files } = body;
  if (!Array.isArray(files) || files.length === 0) {
    return { ok: false, message: "files must list at least one path" };
  }
  const paths = new Set<string>();
  for (const file of files) {
    const path = textOf(file);
    if (path === undefined || path.length > PROJECT_MANIFEST_LIMITS.pathChars) {
      return { ok: false, message: "every file must be a project-relative path" };
    }
    paths.add(path);
  }
  if (paths.size > PROJECT_MANIFEST_LIMITS.importFiles) {
    return {
      ok: false,
      message: `at most ${PROJECT_MANIFEST_LIMITS.importFiles} files per import`,
    };
  }
  const requestId = textOf(body.requestId);
  const turnId = textOf(body.turnId);
  const agent = textOf(body.agent);
  const model = textOf(body.model);
  return {
    ok: true,
    value: {
      projectKey,
      files: [...paths],
      ...(requestId !== undefined && { requestId }),
      ...(turnId !== undefined && { turnId }),
      ...(agent !== undefined && { agent }),
      ...(model !== undefined && { model }),
    },
  };
}

// ── Guards (shallow: the Studio server is the producer) ──────────────────────

export function isExternalProjectList(value: unknown): value is ExternalProjectList {
  return (
    isRecord(value) &&
    Array.isArray(value.projects) &&
    value.projects.every(
      (entry) =>
        isRecord(entry) &&
        typeof entry.key === "string" &&
        typeof entry.name === "string" &&
        (entry.openedAt === undefined || typeof entry.openedAt === "number"),
    )
  );
}

export function isProjectPartsSummary(value: unknown): value is ProjectPartsSummary {
  if (!isRecord(value) || typeof value.key !== "string" || typeof value.name !== "string") {
    return false;
  }
  const { counts } = value;
  return (
    isRecord(counts) &&
    [...PROJECT_FILE_PARTS, "story"].every((part) => typeof counts[part] === "number")
  );
}

export function isProjectManifest(value: unknown): value is ProjectManifest {
  return (
    isRecord(value) &&
    typeof value.key === "string" &&
    typeof value.name === "string" &&
    Array.isArray(value.parts) &&
    Array.isArray(value.files) &&
    value.files.every(
      (file) =>
        isRecord(file) &&
        typeof file.path === "string" &&
        isProjectFilePart(file.part) &&
        typeof file.bytes === "number",
    ) &&
    typeof value.truncated === "boolean" &&
    (value.story === null || typeof value.story === "string")
  );
}

export function isImportFromProjectResult(value: unknown): value is ImportFromProjectResult {
  return (
    isRecord(value) &&
    Array.isArray(value.imported) &&
    value.imported.every(
      (file) =>
        isRecord(file) &&
        typeof file.source === "string" &&
        typeof file.asset === "string" &&
        typeof file.bytes === "number" &&
        (file.status === "copied" || file.status === "existing"),
    ) &&
    Array.isArray(value.skipped)
  );
}

export interface CancelCrossProjectResult {
  requestId: string;
  state: CancelRequestState;
}
