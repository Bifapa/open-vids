import type {
  AnalysisErrorCode,
  AnalysisJob,
  AnalysisOverview,
  AnalyzeRequest,
  CutPlan,
  CutPlanRequest,
  CutPlanSummary,
  FramesRequest,
  FramesResponse,
  SaveSegmentsRequest,
  SaveVisionNotesRequest,
  SegmentMap,
  ShotMap,
  SilenceMap,
  TranscriptView,
  VisionAnalysis,
} from "@hyperframes/agent-protocol";

/**
 * The project's long-form analysis as the runtime sees it: the OpenVids-owned analysis service of the Studio server
 * (`/api/projects/:id/analysis/*`). A host is bound to one project and every call is cancellable through its signal.
 * Analysis artifacts live outside project history, so none of these calls is part of a turn's checkpoint.
 */
export interface AnalysisHost {
  /**
   * Starts the analysis of a source, or joins the running job of that source when it does what the request asks;
   * rejects with `conflict` when a running job would not (force, another language).
   */
  startJob(request: AnalyzeRequest, signal: AbortSignal): Promise<AnalysisJob>;
  getJob(jobId: string, signal: AbortSignal): Promise<AnalysisJob>;
  /** Kills the job's child processes; resolves with the job in its final state. */
  cancelJob(jobId: string, signal: AbortSignal): Promise<AnalysisJob>;
  overview(source: string, signal: AbortSignal): Promise<AnalysisOverview>;
  transcript(
    source: string,
    /** `words`: also return the word list (for captions). */
    window: { from?: number; to?: number; words?: boolean },
    signal: AbortSignal,
  ): Promise<TranscriptView>;
  /** The complete artifact of a stage the overview only summarises. */
  artifact(source: string, stage: "silence", signal: AbortSignal): Promise<SilenceMap>;
  artifact(source: string, stage: "shots", signal: AbortSignal): Promise<ShotMap>;
  saveSegments(request: SaveSegmentsRequest, signal: AbortSignal): Promise<SegmentMap>;
  saveVisionNotes(request: SaveVisionNotesRequest, signal: AbortSignal): Promise<VisionAnalysis>;
  frames(request: FramesRequest, signal: AbortSignal): Promise<FramesResponse>;
  planCut(request: CutPlanRequest, signal: AbortSignal): Promise<CutPlan>;
  listCuts(source: string | undefined, signal: AbortSignal): Promise<CutPlanSummary[]>;
  getCut(planId: string, signal: AbortSignal): Promise<CutPlan>;
}

/** Failures that do not come from the service's validation: transport and cancellation. */
export type AnalysisToolErrorCode = AnalysisErrorCode | "aborted";

/** An analysis failure the model can act on: a stable code and a message. */
export class AnalysisToolError extends Error {
  readonly code: AnalysisToolErrorCode;

  constructor(code: AnalysisToolErrorCode, message: string) {
    super(message);
    this.name = "AnalysisToolError";
    this.code = code;
  }
}
