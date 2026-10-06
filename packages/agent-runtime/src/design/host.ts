import type {
  DesignErrorCode,
  DesignManifest,
  DesignSystemDetail,
  DesignSystemSummary,
  ProjectDesignExtraction,
  ProjectDesignState,
  SaveDesignSystemRequest,
  SaveDesignSystemResult,
  VideoPalette,
} from "@hyperframes/agent-protocol";

/**
 * What the project's `design/` snapshot says, read for the turn's prompt and `inspect_project`: the attach record and,
 * when the snapshot is readable, its `:root` tokens and manifest. Null parts mean the file could not be read or parsed.
 */
export interface DesignSnapshot {
  state: ProjectDesignState;
  tokens: Record<string, string> | null;
  manifest: DesignManifest | null;
}

/**
 * Design Systems as the runtime sees them: the OpenVids-owned design service of the Studio server (the global library
 * under `/api/design-systems`, the project's snapshot and extraction under `/api/projects/:id/design`). A host is
 * bound to one project. Reads are cancellable through their signal; a save that already reached the service is atomic
 * there and is awaited to its end instead of being cut off.
 */
export interface DesignHost {
  /** The library's systems, newest updated first. */
  list(signal: AbortSignal): Promise<DesignSystemSummary[]>;
  /** One system in full (the current version, or `version`). */
  get(id: string, version: number | undefined, signal: AbortSignal): Promise<DesignSystemDetail>;
  /** Creates a system or saves a new version of it; refusals (`invalid_system`, `conflict`, …) reject. */
  save(
    id: string,
    request: SaveDesignSystemRequest,
    signal: AbortSignal,
  ): Promise<SaveDesignSystemResult>;
  /** What this project's compositions use, counted (deterministic, no model). */
  extract(signal: AbortSignal): Promise<ProjectDesignExtraction>;
  /** The measured dominant colors of a project video. */
  videoPalette(
    video: string,
    samples: number | undefined,
    signal: AbortSignal,
  ): Promise<VideoPalette>;
  /** Which system (and version) the project carries, and whether the library has a newer one. */
  projectState(signal: AbortSignal): Promise<ProjectDesignState>;
  /** The project's snapshot for prompts: the attach record plus the tokens and manifest it holds. */
  snapshot(signal: AbortSignal): Promise<DesignSnapshot>;
  /** Attaches (or switches to) an existing library system: writes the project's `design/` only, never a composition. */
  attach(id: string, signal: AbortSignal): Promise<ProjectDesignState>;
  /**
   * What another project of the Projects page uses (the `external_project` source), by the host's project key. The
   * Studio server resolves the key through its `externalProjects` capability (the project's folder never reaches the
   * runtime); a key it does not know, or a host without the capability, rejects `not_found`.
   */
  externalProject(projectKey: string, signal: AbortSignal): Promise<ProjectDesignExtraction>;
}

/** Failures that do not come from the service's validation: transport and cancellation. */
export type DesignToolErrorCode = DesignErrorCode | "aborted";

/** A design failure the model can act on: a stable code, a message and, for an invalid system, every issue found. */
export class DesignToolError extends Error {
  readonly code: DesignToolErrorCode;
  readonly issues: readonly string[];

  constructor(code: DesignToolErrorCode, message: string, issues: readonly string[] = []) {
    super(message);
    this.name = "DesignToolError";
    this.code = code;
    this.issues = issues;
  }
}
