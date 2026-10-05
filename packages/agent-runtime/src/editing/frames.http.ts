import {
  isCompositionFramesResponse,
  isEditError,
  isRecord,
  type CompositionFramesRequest,
  type CompositionFramesResponse,
} from "@hyperframes/agent-protocol";
import type { ProjectScope } from "../checkpointHost.js";
import { FramesError, type FramesHost } from "./frames.js";

/** Studio gives a capture up after 120 s; this only bounds a Studio that does not answer at all. */
const FRAMES_TIMEOUT_MS = 150_000;

/** Studio's `POST /api/projects/:id/editing/frames` for one project. */
export class HttpFramesHost implements FramesHost {
  private readonly url: string;

  constructor(scope: ProjectScope) {
    this.url = `${scope.studioOrigin}/api/projects/${encodeURIComponent(scope.projectId)}/editing/frames`;
  }

  async frames(
    request: CompositionFramesRequest,
    signal: AbortSignal,
  ): Promise<CompositionFramesResponse> {
    const limit = AbortSignal.timeout(FRAMES_TIMEOUT_MS);
    let response: Response;
    try {
      response = await fetch(this.url, {
        method: "POST",
        signal: AbortSignal.any([signal, limit]),
        headers: { "content-type": "application/json" },
        body: JSON.stringify(request),
      });
    } catch (error) {
      if (signal.aborted) throw new FramesError("aborted", "The operation was cancelled.");
      if (limit.aborted) {
        throw new FramesError("unavailable", "Studio did not answer the frame request in time.");
      }
      const reason = error instanceof Error ? error.message : String(error);
      throw new FramesError("unavailable", `Studio is not reachable: ${reason}`);
    }
    const payload: unknown = await response.json().catch(() => null);
    if (response.ok) {
      if (!isCompositionFramesResponse(payload)) {
        throw new FramesError("unavailable", "Studio returned an invalid frames response.");
      }
      return payload;
    }
    const failure = isRecord(payload) ? payload.error : undefined;
    if (isEditError(failure)) throw new FramesError(failure.code, failure.message);
    throw new FramesError(
      "unavailable",
      typeof failure === "string"
        ? failure
        : `Studio's frame service failed the request (${response.status}).`,
    );
  }
}
