import {
  isAnalysisError,
  isRecord,
  type AnalysisJob,
  type AnalysisOverview,
  type AnalyzeRequest,
  type CutPlan,
  type CutPlanRequest,
  type CutPlanSummary,
  type FramesRequest,
  type FramesResponse,
  type SaveSegmentsRequest,
  type SaveVisionNotesRequest,
  type SegmentMap,
  type ShotMap,
  type SilenceMap,
  type TranscriptView,
  type VisionAnalysis,
} from "@hyperframes/agent-protocol";
import type { ProjectScope } from "../checkpointHost.js";
import { AnalysisToolError, type AnalysisHost } from "./host.js";
import {
  isAnalysisJob,
  isAnalysisOverview,
  isCutPlan,
  isCutPlanSummaryList,
  isFramesResponse,
  isSegmentMap,
  isShotMap,
  isSilenceMap,
  isTranscriptView,
  isVisionAnalysis,
} from "./wire.js";

interface RequestOptions {
  body?: unknown;
  signal?: AbortSignal;
}

/** Studio's analysis HTTP API (`/api/projects/:id/analysis/*`) for one project. */
export class HttpAnalysisHost implements AnalysisHost {
  private readonly base: string;

  constructor(scope: ProjectScope) {
    this.base = `${scope.studioOrigin}/api/projects/${encodeURIComponent(scope.projectId)}/analysis`;
  }

  async startJob(request: AnalyzeRequest, signal: AbortSignal): Promise<AnalysisJob> {
    const payload = await this.request("POST", "/jobs", { body: request, signal });
    if (!isAnalysisJob(payload)) throw invalidResponse("analysis job");
    return payload;
  }

  async getJob(jobId: string, signal: AbortSignal): Promise<AnalysisJob> {
    const payload = await this.request("GET", `/jobs/${encodeURIComponent(jobId)}`, { signal });
    if (!isAnalysisJob(payload)) throw invalidResponse("analysis job");
    return payload;
  }

  async cancelJob(jobId: string, signal: AbortSignal): Promise<AnalysisJob> {
    const payload = await this.request("POST", `/jobs/${encodeURIComponent(jobId)}/cancel`, {
      body: {},
      signal,
    });
    if (!isAnalysisJob(payload)) throw invalidResponse("analysis job");
    return payload;
  }

  async overview(source: string, signal: AbortSignal): Promise<AnalysisOverview> {
    const payload = await this.request("GET", `/overview?${new URLSearchParams({ source })}`, {
      signal,
    });
    if (!isAnalysisOverview(payload)) throw invalidResponse("analysis overview");
    return payload;
  }

  async transcript(
    source: string,
    window: { from?: number; to?: number; words?: boolean },
    signal: AbortSignal,
  ): Promise<TranscriptView> {
    const params = new URLSearchParams({ source });
    if (window.from !== undefined) params.set("from", String(window.from));
    if (window.to !== undefined) params.set("to", String(window.to));
    if (window.words) params.set("words", "1");
    const payload = await this.request("GET", `/transcript?${params}`, { signal });
    if (!isTranscriptView(payload)) throw invalidResponse("transcript");
    return payload;
  }

  artifact(source: string, stage: "silence", signal: AbortSignal): Promise<SilenceMap>;
  artifact(source: string, stage: "shots", signal: AbortSignal): Promise<ShotMap>;
  async artifact(
    source: string,
    stage: "silence" | "shots",
    signal: AbortSignal,
  ): Promise<SilenceMap | ShotMap> {
    const payload = await this.request(
      "GET",
      `/artifact?${new URLSearchParams({ source, stage })}`,
      {
        signal,
      },
    );
    if (stage === "silence") {
      if (isSilenceMap(payload)) return payload;
    } else if (isShotMap(payload)) {
      return payload;
    }
    throw invalidResponse(`${stage} artifact`);
  }

  async saveSegments(request: SaveSegmentsRequest, signal: AbortSignal): Promise<SegmentMap> {
    const payload = await this.request("PUT", "/segments", { body: request, signal });
    if (!isSegmentMap(payload)) throw invalidResponse("segment map");
    return payload;
  }

  async saveVisionNotes(
    request: SaveVisionNotesRequest,
    signal: AbortSignal,
  ): Promise<VisionAnalysis> {
    const payload = await this.request("POST", "/vision", { body: request, signal });
    if (!isVisionAnalysis(payload)) throw invalidResponse("vision notes");
    return payload;
  }

  async frames(request: FramesRequest, signal: AbortSignal): Promise<FramesResponse> {
    const payload = await this.request("POST", "/frames", { body: request, signal });
    if (!isFramesResponse(payload)) throw invalidResponse("frames response");
    return payload;
  }

  async planCut(request: CutPlanRequest, signal: AbortSignal): Promise<CutPlan> {
    const payload = await this.request("POST", "/cuts", { body: request, signal });
    if (!isCutPlan(payload)) throw invalidResponse("cut plan");
    return payload;
  }

  async listCuts(source: string | undefined, signal: AbortSignal): Promise<CutPlanSummary[]> {
    const query = source === undefined ? "" : `?${new URLSearchParams({ source })}`;
    const payload = await this.request("GET", `/cuts${query}`, { signal });
    if (!isRecord(payload) || !isCutPlanSummaryList(payload.plans))
      throw invalidResponse("cut plan list");
    return payload.plans;
  }

  async getCut(planId: string, signal: AbortSignal): Promise<CutPlan> {
    const payload = await this.request("GET", `/cuts/${encodeURIComponent(planId)}`, { signal });
    if (!isCutPlan(payload)) throw invalidResponse("cut plan");
    return payload;
  }

  private async request(
    method: "GET" | "POST" | "PUT",
    path: string,
    { body, signal }: RequestOptions = {},
  ): Promise<unknown> {
    let response: Response;
    try {
      response = await fetch(`${this.base}${path}`, {
        method,
        ...(signal && { signal }),
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
    if (isAnalysisError(failure)) throw new AnalysisToolError(failure.code, failure.message);
    throw new AnalysisToolError(
      "unavailable",
      typeof failure === "string"
        ? failure
        : `Studio's analysis service failed the request (${response.status}).`,
    );
  }
}

function invalidResponse(what: string): AnalysisToolError {
  return new AnalysisToolError("unavailable", `Studio returned an invalid ${what}.`);
}

function transportError(error: unknown, signal: AbortSignal | undefined): AnalysisToolError {
  if (signal?.aborted) return new AnalysisToolError("aborted", "The operation was cancelled.");
  const reason = error instanceof Error ? error.message : String(error);
  return new AnalysisToolError(
    "unavailable",
    `Studio's analysis service is not reachable: ${reason}`,
  );
}
