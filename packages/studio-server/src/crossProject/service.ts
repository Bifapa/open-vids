import { statSync } from "node:fs";
import {
  PROJECT_FILE_PARTS,
  PROJECT_MANIFEST_LIMITS,
  expandProjectParts,
  type CancelRequestState,
  type ExternalProjectList,
  type ImportFromProjectRequest,
  type ImportFromProjectResult,
  type ProjectManifest,
  type ProjectPart,
  type ProjectPartsSummary,
} from "@hyperframes/agent-protocol";
import { realFilePath, realpath } from "../helpers/safePath.js";
import { ResearchFailure } from "../research/errors.js";
import { withLedgerLock } from "../research/provenance.js";
import { RequestRegistry } from "../research/requestRegistry.js";
import type { ResolvedProject, StudioApiAdapter } from "../types.js";
import { importProjectFiles } from "./importFiles.js";
import { chaptersOf, scanProjectFiles, storySynopsis } from "./projectFiles.js";

interface LocatedProject {
  key: string;
  name: string;
  /** Real folder of the project. */
  root: string;
}

export interface CrossProjectServiceOptions {
  /** The host's project list; read per request, the adapter is completed after the routes are registered. */
  adapter: Pick<StudioApiAdapter, "externalProjects">;
  now?: () => number;
}

const unknownProject = (): ResearchFailure =>
  new ResearchFailure("unknown_project", "No such project: it is not one the user has opened");

const samePlace = (a: string, b: string): boolean =>
  process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;

/**
 * Other projects, for `#` mentions: which exist, what each holds (by part), the manifest the agents read, and the
 * import that copies chosen files into the open project. Everything is addressed by the host's opaque project key;
 * no path of another project leaves this service.
 */
export class CrossProjectService {
  private readonly requests: RequestRegistry;
  private readonly now: () => number;

  constructor(private readonly options: CrossProjectServiceOptions) {
    this.now = options.now ?? Date.now;
    this.requests = new RequestRegistry(this.now);
  }

  /** The project behind a key, or `unknown_project`: no host list, a key the host does not know, or the open project. */
  private async locate(project: ResolvedProject, key: string): Promise<LocatedProject> {
    const located = await this.locateOrNull(project, key);
    if (!located) throw unknownProject();
    return located;
  }

  private async locateOrNull(
    project: ResolvedProject,
    key: string,
  ): Promise<LocatedProject | null> {
    const external = this.options.adapter.externalProjects;
    if (!external || key.length === 0 || key.length > 64) return null;
    const found = await external.resolve(key);
    if (!found) return null;
    let root: string;
    try {
      root = realpath(found.dir);
      if (!statSync(root).isDirectory()) return null;
    } catch {
      return null;
    }
    return samePlace(root, realFilePath(project.dir)) ? null : { key, name: found.name, root };
  }

  /** The projects other than the open one that still exist, in the host's order (most recently opened first). */
  async list(project: ResolvedProject): Promise<ExternalProjectList> {
    const external = this.options.adapter.externalProjects;
    if (!external) return { projects: [] };
    const entries = await external.list();
    const located = await Promise.all(
      entries.map(async (entry) => ((await this.locateOrNull(project, entry.key)) ? entry : null)),
    );
    return {
      projects: located.flatMap((entry) =>
        entry
          ? [
              {
                key: entry.key,
                name: entry.name,
                ...(entry.openedAt !== undefined && { openedAt: entry.openedAt }),
              },
            ]
          : [],
      ),
    };
  }

  /** How many files each part holds and how many chapters the story has; the media is not probed. */
  async summary(project: ResolvedProject, key: string): Promise<ProjectPartsSummary> {
    const other = await this.locate(project, key);
    const { files, story } = scanProjectFiles(other.root);
    const counts: ProjectPartsSummary["counts"] = {
      renders: 0,
      music: 0,
      audio: 0,
      images: 0,
      video: 0,
      story: chaptersOf(story).length,
    };
    for (const file of files) counts[file.part] += 1;
    return { key, name: other.name, counts };
  }

  /** The files of the named parts (bounded) and the story synopsis, as the agents read them. */
  async manifest(
    project: ResolvedProject,
    key: string,
    parts: readonly ProjectPart[],
  ): Promise<ProjectManifest> {
    const other = await this.locate(project, key);
    const named = expandProjectParts(parts);
    const { files, story } = scanProjectFiles(other.root);
    // Parts in their fixed order; inside a part the newest first for renders (the latest cut), the rest by path.
    const matching = PROJECT_FILE_PARTS.filter((part) => named.includes(part)).flatMap((part) =>
      files
        .filter((file) => file.part === part)
        .sort((a, b) =>
          part === "renders" && a.mtimeMs !== b.mtimeMs
            ? b.mtimeMs - a.mtimeMs
            : a.path.localeCompare(b.path),
        ),
    );
    const listed = matching.slice(0, PROJECT_MANIFEST_LIMITS.files);
    return {
      key,
      name: other.name,
      parts: named,
      files: listed.map((file) => ({
        path: file.path,
        part: file.part,
        bytes: file.bytes,
        ...(file.record && { license: file.record.license }),
      })),
      truncated: matching.length > listed.length,
      story:
        named.includes("story") && story
          ? storySynopsis(story, PROJECT_MANIFEST_LIMITS.storyChars)
          : null,
    };
  }

  /**
   * Copies files of another project into this one. `client` is the request's abort signal; with `request.requestId`
   * the import can also be cancelled by {@link cancel}. A cancel before the commit writes nothing and answers
   * `cancelled`; once the commit started the import finishes and answers normally.
   */
  async import(
    project: ResolvedProject,
    request: ImportFromProjectRequest,
    client?: AbortSignal,
  ): Promise<ImportFromProjectResult> {
    const other = await this.locate(project, request.projectKey);
    const guard = this.requests.begin(project.dir, request.requestId, client);
    try {
      return await guard.race(
        withLedgerLock(project.dir, () => {
          // The source is read inside the lock: what is offered is what is on disk when the copy starts.
          const { files } = scanProjectFiles(other.root);
          return importProjectFiles({
            project,
            other,
            request,
            offered: files,
            guard,
            now: this.now,
          });
        }),
      );
    } catch (error) {
      throw guard.normalize(error);
    } finally {
      this.requests.end(guard);
    }
  }

  /** Cancels the import with this `requestId`; the answer says whether it can still write. */
  cancel(project: ResolvedProject, requestId: string): CancelRequestState {
    return this.requests.cancel(project.dir, requestId);
  }
}
