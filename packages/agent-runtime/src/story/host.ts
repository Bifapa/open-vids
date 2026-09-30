import type {
  StoryBuildRequest,
  StoryBuildResult,
  StoryEditRequest,
  StoryEditResponse,
  StoryErrorCode,
  StoryRebuildRequest,
  StoryRebuildResult,
  StoryView,
} from "@hyperframes/agent-protocol";

/**
 * The project's Story Graph as the runtime sees it: the OpenVids-owned story service of the Studio server
 * (`/api/projects/:id/story/*`). A host is bound to one project. Reads are cancellable through their signal; an edit or
 * a build that already reached the service is atomic there and is awaited to its end instead of being cut off.
 */
export interface StoryHost {
  /** The graph (null until a story exists) with its version, play order and per-node facts. */
  view(signal: AbortSignal): Promise<StoryView>;
  /** An agent's atomic batch of story operations. Refusals (locks, user decisions, unknown ids) reject. */
  edit(request: StoryEditRequest, signal: AbortSignal): Promise<StoryEditResponse>;
  /** Compiles the graph into the timeline in one atomic edit (or reports what it would do for a dry run). */
  build(request: StoryBuildRequest, signal: AbortSignal): Promise<StoryBuildResult>;
  /** Rebuilds only the sections the graph changed since the last build (or reports what it would do for a dry run). */
  rebuild(request: StoryRebuildRequest, signal: AbortSignal): Promise<StoryRebuildResult>;
}

/** Failures that do not come from the service's validation: transport and cancellation. */
export type StoryToolErrorCode = StoryErrorCode | "unavailable" | "aborted";

/** A story failure the model can act on: a stable code, a message and, for a batch, the failing operation. */
export class StoryToolError extends Error {
  readonly code: StoryToolErrorCode;
  readonly opIndex: number | undefined;

  constructor(code: StoryToolErrorCode, message: string, opIndex?: number) {
    super(message);
    this.name = "StoryToolError";
    this.code = code;
    this.opIndex = opIndex;
  }
}
