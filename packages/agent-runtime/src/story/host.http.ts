import {
  isRecord,
  isStoryError,
  type StoryBuildRequest,
  type StoryBuildResult,
  type StoryEditRequest,
  type StoryEditResponse,
  type StoryView,
} from "@hyperframes/agent-protocol";
import type { ProjectScope } from "../checkpointHost.js";
import { StoryToolError, type StoryHost } from "./host.js";
import { isStoryBuildResult, isStoryEditResponse, isStoryView } from "./wire.js";

/**
 * An edit or build that reached the service is atomic there and is awaited to its end (the turn's checkpoint must not
 * close under it); this only bounds a service that hangs. A build renders nothing but probes media, so it gets longer.
 */
const EDIT_TIMEOUT_MS = 60_000;
const BUILD_TIMEOUT_MS = 180_000;

interface RequestOptions {
  body?: unknown;
  signal: AbortSignal;
}

/** Studio's story HTTP API (`/api/projects/:id/story/*`) for one project. */
export class HttpStoryHost implements StoryHost {
  private readonly base: string;

  constructor(scope: ProjectScope) {
    this.base = `${scope.studioOrigin}/api/projects/${encodeURIComponent(scope.projectId)}/story`;
  }

  async view(signal: AbortSignal): Promise<StoryView> {
    const payload = await this.request("GET", "", { signal });
    if (!isStoryView(payload)) throw invalidResponse("story view");
    return payload;
  }

  async edit(request: StoryEditRequest, signal: AbortSignal): Promise<StoryEditResponse> {
    if (signal.aborted) throw aborted();
    const payload = await this.request("POST", "/edit", {
      body: request,
      signal: AbortSignal.timeout(EDIT_TIMEOUT_MS),
    });
    if (!isStoryEditResponse(payload)) throw invalidResponse("story edit result");
    return payload;
  }

  async build(request: StoryBuildRequest, signal: AbortSignal): Promise<StoryBuildResult> {
    if (signal.aborted) throw aborted();
    const payload = await this.request("POST", "/build", {
      body: request,
      // A dry run writes nothing, so it can simply be cancelled.
      signal: request.dryRun ? signal : AbortSignal.timeout(BUILD_TIMEOUT_MS),
    });
    if (!isStoryBuildResult(payload)) throw invalidResponse("story build result");
    return payload;
  }

  private async request(
    method: "GET" | "POST",
    path: string,
    { body, signal }: RequestOptions,
  ): Promise<unknown> {
    let response: Response;
    try {
      response = await fetch(`${this.base}${path}`, {
        method,
        signal,
        ...(body !== undefined && {
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        }),
      });
    } catch (error) {
      throw transportError(error, signal);
    }
    const payload: unknown = await response.json().catch(() => null);
    if (response.ok) return payload;
    const failure = isRecord(payload) ? payload.error : undefined;
    if (isStoryError(failure))
      throw new StoryToolError(failure.code, failure.message, failure.opIndex);
    throw new StoryToolError(
      "unavailable",
      typeof failure === "string"
        ? failure
        : `Studio's story service failed the request (${response.status}).`,
    );
  }
}

function aborted(): StoryToolError {
  return new StoryToolError("aborted", "The operation was cancelled.");
}

function invalidResponse(what: string): StoryToolError {
  return new StoryToolError("unavailable", `Studio returned an invalid ${what}.`);
}

function transportError(error: unknown, signal: AbortSignal): StoryToolError {
  if (signal.aborted) {
    if (signal.reason instanceof Error && signal.reason.name === "TimeoutError") {
      return new StoryToolError(
        "unavailable",
        "Studio's story service did not answer in time; read the story to see whether the request took effect.",
      );
    }
    return aborted();
  }
  const reason = error instanceof Error ? error.message : String(error);
  return new StoryToolError("unavailable", `Studio's story service is not reachable: ${reason}`);
}
