import type {
  ImportFromProjectRequest,
  ImportFromProjectResult,
  ProjectManifest,
  ProjectPart,
} from "@hyperframes/agent-protocol";

/**
 * Other projects as the runtime sees them: Studio's cross-project service (`/api/projects/:id/cross-project/*`, see
 * `crossProject.ts` of the protocol). A host is bound to the open project; keys are the shell's per-folder keys and no
 * path ever crosses it. Failures are `ResearchToolError`s (`unknown_project`, `cancelled`, `studio_unavailable`, …).
 *
 * The runtime decides what a chat may reach (see `access.ts`) before it calls a host; the host does not.
 * {@link importFiles} writes project files, so it is cancellable like a research import: aborting its signal asks the
 * server to cancel, the host keeps waiting for the server's answer, and it settles with `write_unsettled` only when a
 * write could still land.
 */
export interface CrossProjectHost {
  /** The files of the named parts of another project (and its story synopsis when `story` is among them). */
  manifest(
    key: string,
    parts: readonly ProjectPart[],
    signal: AbortSignal,
  ): Promise<ProjectManifest>;
  /** Copies files of another project into `assets/from/<project>/…`, carrying their provenance records. */
  importFiles(
    request: ImportFromProjectRequest,
    signal: AbortSignal,
  ): Promise<ImportFromProjectResult>;
}
