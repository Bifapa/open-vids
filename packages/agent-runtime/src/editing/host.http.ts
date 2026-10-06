import {
  isEditError,
  isRecord,
  type ApplyEditsRequest,
  type ApplyEditsResponse,
  type PresetKind,
  type ProjectAsset,
  type ProjectInventory,
  type TimelineSnapshot,
} from "@hyperframes/agent-protocol";
import type { ProjectScope } from "../checkpointHost.js";
import {
  EditingError,
  type EditingHost,
  type RenderOutput,
  type RenderProgress,
  type PresetPage,
  type RenderRequest,
} from "./host.js";
import {
  isApplyEditsResponse,
  isPresetList,
  isProjectAsset,
  isProjectInventory,
  isTimelineSnapshot,
} from "./wire.js";

/**
 * Ceilings only: they bound a Studio that hangs, not honest work. A batch (registry installs, hundreds of clips) may run
 * for minutes; a read that takes two is wedged. Every call also follows the caller's signal.
 */
const APPLY_CEILING_MS = 10 * 60_000;
const READ_CEILING_MS = 2 * 60_000;
const CANCEL_TIMEOUT_MS = 10_000;

interface RequestOptions {
  body?: Record<string, unknown>;
  signal?: AbortSignal;
}

/** Studio's editing HTTP API (`/api/projects/:id/editing/*`) plus its render routes, for one project. */
export class HttpEditingHost implements EditingHost {
  private readonly api: string;
  private readonly project: string;

  constructor(scope: ProjectScope) {
    this.api = `${scope.studioOrigin}/api`;
    this.project = `/projects/${encodeURIComponent(scope.projectId)}`;
  }

  async inventory(signal: AbortSignal): Promise<ProjectInventory> {
    const payload = await this.request("GET", `${this.project}/editing/project`, { signal });
    if (!isProjectInventory(payload)) throw invalidResponse("project inventory");
    return payload;
  }

  async timeline(composition: string | undefined, signal: AbortSignal): Promise<TimelineSnapshot> {
    const query = composition ? `?composition=${encodeURIComponent(composition)}` : "";
    const payload = await this.request("GET", `${this.project}/editing/timeline${query}`, {
      signal,
    });
    if (!isTimelineSnapshot(payload)) throw invalidResponse("timeline");
    return payload;
  }

  async apply(request: ApplyEditsRequest, signal: AbortSignal): Promise<ApplyEditsResponse> {
    if (signal.aborted) throw aborted();
    const { requestId } = request;
    // The turn's signal does not cut the call off: it asks Studio to stop before it writes, and the answer says
    // whether the batch landed. A call torn off mid-flight could leave the turn unsure and tempt a duplicate retry.
    const stop = () => void this.cancelApply(requestId);
    signal.addEventListener("abort", stop, { once: true });
    try {
      const payload = await this.request("POST", `${this.project}/editing/apply`, {
        body: { ...request },
        signal: AbortSignal.timeout(APPLY_CEILING_MS),
      });
      if (!isApplyEditsResponse(payload)) throw invalidResponse("edit result");
      return payload;
    } finally {
      signal.removeEventListener("abort", stop);
    }
  }

  private async cancelApply(requestId: string | undefined): Promise<void> {
    if (requestId === undefined) return;
    try {
      await this.request("POST", `${this.project}/editing/cancel`, {
        body: { requestId },
        signal: AbortSignal.timeout(CANCEL_TIMEOUT_MS),
      });
    } catch {
      // Studio may be gone or the batch already over; the apply call itself reports the outcome.
    }
  }

  async presets(
    kind: PresetKind,
    query: string | undefined,
    signal: AbortSignal,
    page?: { offset: number; limit: number },
  ): Promise<PresetPage> {
    const params = new URLSearchParams({ kind });
    if (query) params.set("query", query);
    if (page) {
      params.set("offset", String(page.offset));
      params.set("limit", String(page.limit));
    }
    const payload = await this.request("GET", `${this.project}/editing/presets?${params}`, {
      signal,
    });
    if (!isRecord(payload) || !isPresetList(payload.presets)) throw invalidResponse("preset list");
    const total = typeof payload.total === "number" ? payload.total : payload.presets.length;
    return { presets: payload.presets, total };
  }

  async probe(path: string, signal: AbortSignal): Promise<ProjectAsset> {
    const payload = await this.request(
      "GET",
      `${this.project}/editing/probe?path=${encodeURIComponent(path)}`,
      { signal },
    );
    if (!isProjectAsset(payload)) throw invalidResponse("media probe");
    return payload;
  }

  async render(
    request: RenderRequest,
    signal: AbortSignal,
    onProgress: (progress: RenderProgress) => void,
  ): Promise<RenderOutput> {
    if (signal.aborted) throw aborted();
    const started = await this.request("POST", `${this.project}/render`, {
      body: {
        ...(request.composition && { composition: request.composition }),
        quality: request.quality,
        format: "mp4",
      },
      signal,
    });
    const jobId = isRecord(started) && typeof started.jobId === "string" ? started.jobId : null;
    if (!jobId) throw invalidResponse("render job");

    let final: { status: string; error: string | null } | null = null;
    try {
      for await (const event of this.progressEvents(jobId, signal)) {
        // A render queued behind another one is waiting, not finished and not stuck: it carries on (only the
        // caller's signal ends the wait) and reports where it stands as structured data (the UI words it). The wait is not render time: nothing here
        // bounds the render, and the stream keeps beating while queued.
        const queued = event.status === "queued";
        onProgress(
          queued
            ? {
                progress: 0,
                stage: null,
                queue: { position: event.queuePosition, holder: event.queueHolder },
              }
            : { progress: event.progress, stage: event.stage },
        );
        if (!queued && event.status !== "rendering") {
          final = { status: event.status, error: event.error };
          break;
        }
      }
    } catch (error) {
      if (signal.aborted) {
        await this.cancelRender(jobId);
        throw aborted("The render was cancelled.");
      }
      throw error;
    }
    if (signal.aborted) {
      await this.cancelRender(jobId);
      throw aborted("The render was cancelled.");
    }
    if (!final) {
      throw new EditingError("render_failed", "The render progress stream ended unexpectedly.");
    }
    if (final.status === "cancelled") throw aborted("The render was cancelled.");
    if (final.status !== "complete") {
      throw new EditingError("render_failed", final.error ?? "The render failed.");
    }
    return this.locateOutput(jobId, signal);
  }

  /** The finished job's file (from the render list) with its probed media properties. */
  private async locateOutput(jobId: string, signal: AbortSignal): Promise<RenderOutput> {
    const listing = await this.request("GET", `${this.project}/renders`, { signal });
    const files = isRecord(listing) && Array.isArray(listing.renders) ? listing.renders : [];
    const file = files.find((entry) => isRecord(entry) && entry.id === jobId);
    if (!isRecord(file) || typeof file.filename !== "string") {
      throw new EditingError("render_failed", "The render finished but its file was not found.");
    }
    const path = `renders/${file.filename}`;
    const media = await this.probe(path, signal);
    if (
      media.bytes <= 0 ||
      !media.duration ||
      media.duration <= 0 ||
      !media.width ||
      !media.height
    ) {
      throw new EditingError(
        "render_failed",
        `The render produced an empty or unreadable video (${path}).`,
      );
    }
    return {
      path: media.path,
      bytes: media.bytes,
      duration: media.duration,
      width: media.width,
      height: media.height,
      videoCodec: await this.videoCodec(path, signal),
      hasAudio: media.hasAudio,
    };
  }

  /** The codec name is informational; a failure to read it never fails the render. */
  private async videoCodec(path: string, signal: AbortSignal): Promise<string | null> {
    try {
      const payload = await this.request(
        "GET",
        `${this.project}/media/metadata?path=${encodeURIComponent(path)}`,
        { signal },
      );
      const color = isRecord(payload) && isRecord(payload.metadata) ? payload.metadata.color : null;
      return isRecord(color) && typeof color.codecName === "string" ? color.codecName : null;
    } catch {
      return null;
    }
  }

  private async cancelRender(jobId: string): Promise<void> {
    try {
      await this.request("POST", `/render/${encodeURIComponent(jobId)}/cancel`, {
        body: {},
        signal: AbortSignal.timeout(CANCEL_TIMEOUT_MS),
      });
    } catch {
      // The job may already be over or Studio gone; the caller is aborting either way.
    }
  }

  private async *progressEvents(jobId: string, signal: AbortSignal): AsyncGenerator<ProgressEvent> {
    let response: Response;
    try {
      response = await fetch(`${this.api}/render/${encodeURIComponent(jobId)}/progress`, {
        signal,
      });
    } catch (error) {
      throw transportError(error, signal);
    }
    if (!response.ok || !response.body) {
      throw new EditingError(
        "render_failed",
        `Studio could not report render progress (${response.status}).`,
      );
    }
    const decoder = new TextDecoder();
    let buffer = "";
    try {
      for await (const chunk of response.body) {
        buffer += decoder.decode(chunk, { stream: true });
        let boundary = buffer.indexOf("\n\n");
        while (boundary !== -1) {
          const event = parseProgressEvent(buffer.slice(0, boundary));
          buffer = buffer.slice(boundary + 2);
          if (event) yield event;
          boundary = buffer.indexOf("\n\n");
        }
      }
    } catch (error) {
      throw transportError(error, signal);
    } finally {
      await response.body.cancel().catch(() => undefined);
    }
  }

  private async request(
    method: "GET" | "POST",
    path: string,
    { body, signal }: RequestOptions = {},
  ): Promise<unknown> {
    // A read follows the caller's signal and a ceiling; the POSTs bring their own (apply, cancel).
    const bounded =
      method === "GET" && signal
        ? AbortSignal.any([signal, AbortSignal.timeout(READ_CEILING_MS)])
        : signal;
    let response: Response;
    try {
      response = await fetch(`${this.api}${path}`, {
        method,
        ...(bounded && { signal: bounded }),
        ...(body && {
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        }),
      });
    } catch (error) {
      throw transportError(error, bounded, path);
    }
    const payload: unknown = await response.json().catch(() => null);
    if (response.ok) return payload;
    const failure = isRecord(payload) ? payload.error : undefined;
    if (isEditError(failure))
      throw new EditingError(failure.code, failure.message, failure.opIndex);
    throw new EditingError(
      "unavailable",
      typeof failure === "string"
        ? failure
        : `Studio's editing service failed the request (${response.status}).`,
    );
  }
}

/** One `progress` event of the render SSE stream. `queuePosition` and `queueHolder` are set while `status` is `queued`. */
interface ProgressEvent {
  progress: number;
  status: string;
  stage: string | null;
  error: string | null;
  queuePosition: number | null;
  queueHolder: string | null;
}

/** One `progress` event of the render SSE stream (`event:` + `data:` lines), or null for anything else. */
function parseProgressEvent(block: string): ProgressEvent | null {
  let name = "message";
  const data: string[] = [];
  for (const line of block.split("\n")) {
    if (line.startsWith("event:")) name = line.slice(6).trim();
    else if (line.startsWith("data:")) data.push(line.slice(5).trimStart());
  }
  if (name !== "progress" || data.length === 0) return null;
  try {
    const payload: unknown = JSON.parse(data.join("\n"));
    if (!isRecord(payload) || typeof payload.status !== "string") return null;
    const holder = payload.queueHolder;
    return {
      progress: typeof payload.progress === "number" ? payload.progress : 0,
      status: payload.status,
      stage: typeof payload.stage === "string" ? payload.stage : null,
      error: typeof payload.error === "string" ? payload.error : null,
      queuePosition: typeof payload.queuePosition === "number" ? payload.queuePosition : null,
      queueHolder:
        isRecord(holder) && typeof holder.projectName === "string" ? holder.projectName : null,
    };
  } catch {
    return null;
  }
}

function aborted(message = "The operation was cancelled."): EditingError {
  return new EditingError("aborted", message);
}

function invalidResponse(what: string): EditingError {
  return new EditingError("unavailable", `Studio returned an invalid ${what}.`);
}

function transportError(error: unknown, signal: AbortSignal | undefined, path = ""): EditingError {
  if (signal?.aborted) {
    if (signal.reason instanceof Error && signal.reason.name === "TimeoutError") {
      const apply = path.endsWith("/editing/apply");
      return new EditingError(
        "unavailable",
        apply
          ? "Studio's editing service did not answer in time. The batch may have been applied: call edit_timeline again with the SAME operations (a batch Studio already applied is answered, not applied twice) or inspect the timeline."
          : "Studio's editing service did not answer in time; try again.",
      );
    }
    return aborted();
  }
  const reason = error instanceof Error ? error.message : String(error);
  return new EditingError("unavailable", `Studio's editing service is not reachable: ${reason}`);
}
