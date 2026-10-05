import type {
  ApplyEditsRequest,
  ApplyEditsResponse,
  EditErrorCode,
  PresetInfo,
  PresetKind,
  ProjectAsset,
  ProjectInventory,
  TimelineSnapshot,
} from "@hyperframes/agent-protocol";

export const RENDER_QUALITIES = ["draft", "standard", "high"] as const;
export type RenderQuality = (typeof RENDER_QUALITIES)[number];

export interface RenderRequest {
  /** Project-relative composition; the project's main composition when absent. */
  composition?: string;
  quality: RenderQuality;
}

export interface RenderProgress {
  /** 0–100. */
  progress: number;
  stage: string | null;
}

/** A finished, probed render output. */
export interface RenderOutput {
  /** Project-relative path of the video file. */
  path: string;
  bytes: number;
  /** Seconds. */
  duration: number;
  width: number;
  height: number;
  videoCodec: string | null;
  hasAudio: boolean | null;
}

/** One page of presets and how many match in all. */
export interface PresetPage {
  presets: PresetInfo[];
  total: number;
}

/**
 * The project's editing capabilities as the runtime sees them: the OpenVids-owned editing service of the Studio
 * server (`/api/projects/:id/editing/*`) plus rendering. A host is bound to one project. Every call is cancellable
 * through its signal. An `apply` follows the signal by asking the service to stop before it writes, and still waits for
 * the answer: a batch is atomic there, so it is never cut off half-way, and the caller learns whether it landed.
 */
export interface EditingHost {
  inventory(signal: AbortSignal): Promise<ProjectInventory>;
  timeline(composition: string | undefined, signal: AbortSignal): Promise<TimelineSnapshot>;
  apply(request: ApplyEditsRequest, signal: AbortSignal): Promise<ApplyEditsResponse>;
  presets(
    kind: PresetKind,
    query: string | undefined,
    signal: AbortSignal,
    page?: { offset: number; limit: number },
  ): Promise<PresetPage>;
  /** Renders to mp4 and resolves once the file exists and was probed. Aborting cancels the render and rejects. */
  render(
    request: RenderRequest,
    signal: AbortSignal,
    onProgress: (progress: RenderProgress) => void,
  ): Promise<RenderOutput>;
  /** Probes any project-relative media file (used for render outputs). */
  probe(path: string, signal: AbortSignal): Promise<ProjectAsset>;
}

/** Failures that do not come from the service's validation: transport, cancellation, render failure. */
export type EditingErrorCode = EditErrorCode | "unavailable" | "aborted" | "render_failed";

/** An editing failure the model can act on: a stable code, a message, and the failing operation of a batch. */
export class EditingError extends Error {
  readonly code: EditingErrorCode;
  readonly opIndex: number | undefined;

  constructor(code: EditingErrorCode, message: string, opIndex?: number) {
    super(message);
    this.name = "EditingError";
    this.code = code;
    this.opIndex = opIndex;
  }
}
