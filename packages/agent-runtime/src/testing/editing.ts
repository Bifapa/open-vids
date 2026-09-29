import type {
  ApplyEditsRequest,
  ApplyEditsResponse,
  PresetInfo,
  PresetKind,
  ProjectAsset,
  ProjectInventory,
  TimelineSnapshot,
} from "@hyperframes/agent-protocol";
import {
  EditingError,
  type EditingHost,
  type RenderOutput,
  type RenderProgress,
  type RenderRequest,
} from "../editing/host.js";

const EMPTY_TIMELINE: TimelineSnapshot = {
  composition: { path: "index.html", width: 1920, height: 1080, duration: 0 },
  version: "v1",
  tracks: [],
  clips: [],
};

/**
 * Deterministic in-memory editing host for runtime tests and embedding harnesses. It records every request, answers
 * from the fields below, and can hold an `apply` or a render open (`applyGate`, `renderGate`) so tests can finish a
 * turn while an edit is in flight. Like the real host, a started `apply` ignores aborts; a render honours them.
 */
export class FakeEditingHost implements EditingHost {
  inventoryResult: ProjectInventory = { compositions: [], assets: [], renders: [] };
  timelineResult: TimelineSnapshot = EMPTY_TIMELINE;
  presetResults: PresetInfo[] = [];
  renderResult: RenderOutput = {
    path: "renders/final.mp4",
    bytes: 1_500_000,
    duration: 12,
    width: 1920,
    height: 1080,
    videoCodec: "h264",
    hasAudio: true,
  };
  nextApplyError: EditingError | null = null;
  /** While set, `apply` records the request and then waits for it before answering. */
  applyGate: Promise<void> | null = null;
  /** While set, `render` waits for it (or for an abort) before answering. */
  renderGate: Promise<void> | null = null;

  readonly applyRequests: ApplyEditsRequest[] = [];
  /** The signal each `apply` was given, so tests can see when the caller stopped waiting for it. */
  readonly applySignals: AbortSignal[] = [];
  readonly applyFinished: ApplyEditsRequest[] = [];
  readonly timelineRequests: Array<string | undefined> = [];
  readonly presetRequests: Array<{ kind: PresetKind; query: string | undefined }> = [];
  readonly renderRequests: RenderRequest[] = [];
  inventoryCalls = 0;
  renderCancelled = false;

  async inventory(signal: AbortSignal): Promise<ProjectInventory> {
    signal.throwIfAborted();
    this.inventoryCalls += 1;
    return structuredClone(this.inventoryResult);
  }

  async timeline(composition: string | undefined, signal: AbortSignal): Promise<TimelineSnapshot> {
    signal.throwIfAborted();
    this.timelineRequests.push(composition);
    return structuredClone(this.timelineResult);
  }

  async apply(request: ApplyEditsRequest, signal: AbortSignal): Promise<ApplyEditsResponse> {
    if (signal.aborted) throw new EditingError("aborted", "The operation was cancelled.");
    this.applyRequests.push(request);
    this.applySignals.push(signal);
    if (this.applyGate) await this.applyGate;
    if (this.nextApplyError) {
      const error = this.nextApplyError;
      this.nextApplyError = null;
      throw error;
    }
    this.applyFinished.push(request);
    let sequence = this.applyFinished.length * 100;
    return {
      timeline: structuredClone(this.timelineResult),
      results: request.operations.map((operation) => {
        sequence += 1;
        return {
          op: operation.op,
          clipId: "clip" in operation ? operation.clip : `clip-${sequence}`,
          newClipId: operation.op === "split_clip" ? `clip-${sequence}b` : null,
        };
      }),
      changedFiles: [request.composition ?? "index.html"],
    };
  }

  async presets(
    kind: PresetKind,
    query: string | undefined,
    signal: AbortSignal,
  ): Promise<PresetInfo[]> {
    signal.throwIfAborted();
    this.presetRequests.push({ kind, query });
    return this.presetResults.filter((preset) => preset.kind === kind);
  }

  async probe(path: string, signal: AbortSignal): Promise<ProjectAsset> {
    signal.throwIfAborted();
    return {
      path,
      kind: "video",
      bytes: this.renderResult.bytes,
      duration: this.renderResult.duration,
      width: this.renderResult.width,
      height: this.renderResult.height,
      hasAudio: this.renderResult.hasAudio,
    };
  }

  async render(
    request: RenderRequest,
    signal: AbortSignal,
    onProgress: (progress: RenderProgress) => void,
  ): Promise<RenderOutput> {
    if (signal.aborted) throw new EditingError("aborted", "The render was cancelled.");
    this.renderRequests.push(request);
    onProgress({ progress: 0, stage: "starting" });
    if (this.renderGate) {
      const gate = this.renderGate;
      await new Promise<void>((resolve, reject) => {
        signal.addEventListener(
          "abort",
          () => {
            this.renderCancelled = true;
            reject(new EditingError("aborted", "The render was cancelled."));
          },
          { once: true },
        );
        void gate.then(resolve);
      });
    }
    onProgress({ progress: 100, stage: "done" });
    return structuredClone(this.renderResult);
  }
}
