import {
  isQaCheckResponse,
  isQaError,
  isQaReport,
  isRecord,
  type QaCheckRequest,
  type QaCheckResponse,
  type QaFramesRequest,
  type QaFramesResponse,
  type QaReport,
  type QaReportInput,
  type QaStateResponse,
} from "@hyperframes/agent-protocol";
import type { ProjectScope } from "../checkpointHost.js";
import { isFramesResponse } from "../analysis/wire.js";
import { QaToolError, type QaHost } from "./host.js";

/**
 * How long each call may take before the runtime stops waiting. A check runs ffmpeg over the whole render and the
 * layout check loads the composition in a browser; extracting frames seeks into the render.
 */
export const QA_TIMEOUTS_MS = {
  state: 30_000,
  check: 10 * 60_000,
  frames: 2 * 60_000,
  report: 30_000,
} as const;

interface RequestOptions {
  body?: unknown;
  signal: AbortSignal;
  timeoutMs: number;
  /** Shown when the call timed out. */
  onTimeout: string;
}

/** Studio's QA HTTP API (`/api/projects/:id/qa/*`) for one project. */
export class HttpQaHost implements QaHost {
  private readonly api: string;

  constructor(scope: ProjectScope) {
    this.api = `${scope.studioOrigin}/api/projects/${encodeURIComponent(scope.projectId)}/qa`;
  }

  async state(signal: AbortSignal): Promise<QaStateResponse> {
    const payload = await this.request("GET", "/state", {
      signal,
      timeoutMs: QA_TIMEOUTS_MS.state,
      onTimeout: "Studio did not answer in time.",
    });
    if (!isRecord(payload) || typeof payload.fingerprint !== "string")
      throw invalidResponse("project state");
    return { fingerprint: payload.fingerprint };
  }

  async check(request: QaCheckRequest, signal: AbortSignal): Promise<QaCheckResponse> {
    const payload = await this.request("POST", "/check", {
      body: request,
      signal,
      timeoutMs: QA_TIMEOUTS_MS.check,
      onTimeout: "The render checks did not finish in time.",
    });
    if (!isQaCheckResponse(payload)) throw invalidResponse("check result");
    return payload;
  }

  async frames(request: QaFramesRequest, signal: AbortSignal): Promise<QaFramesResponse> {
    const payload = await this.request("POST", "/frames", {
      body: request,
      signal,
      timeoutMs: QA_TIMEOUTS_MS.frames,
      onTimeout: "Extracting frames did not finish in time.",
    });
    if (!isFramesResponse(payload)) throw invalidResponse("frames response");
    return { frames: payload.frames };
  }

  async saveReport(input: QaReportInput, signal: AbortSignal): Promise<QaReport> {
    const payload = await this.request("POST", "/reports", {
      body: input,
      signal,
      timeoutMs: QA_TIMEOUTS_MS.report,
      onTimeout: "Studio did not answer in time.",
    });
    if (!isQaReport(payload)) throw invalidResponse("report");
    return payload;
  }

  private async request(
    method: "GET" | "POST",
    path: string,
    { body, signal, timeoutMs, onTimeout }: RequestOptions,
  ): Promise<unknown> {
    if (signal.aborted) throw aborted();
    const timeout = AbortSignal.timeout(timeoutMs);
    const combined = AbortSignal.any([signal, timeout]);
    let response: Response;
    try {
      response = await fetch(`${this.api}${path}`, {
        method,
        signal: combined,
        ...(body !== undefined && {
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        }),
      });
    } catch (error) {
      throw transportError(error, signal, timeout, onTimeout);
    }
    let payload: unknown;
    try {
      payload = await response.json();
    } catch (error) {
      // The body may still be streaming when the call is cancelled or times out.
      if (combined.aborted) throw transportError(error, signal, timeout, onTimeout);
      payload = null;
    }
    if (response.ok) return payload;
    const failure = isRecord(payload) ? payload.error : undefined;
    if (isQaError(failure)) {
      throw new QaToolError(
        failure.code === "cancelled" ? "aborted" : failure.code,
        failure.message,
      );
    }
    throw new QaToolError(
      "studio_unavailable",
      typeof failure === "string"
        ? failure
        : `Studio's QA service failed the request (${response.status}).`,
    );
  }
}

function aborted(): QaToolError {
  return new QaToolError("aborted", "The operation was cancelled.");
}

function invalidResponse(what: string): QaToolError {
  return new QaToolError("studio_unavailable", `Studio returned an invalid ${what}.`);
}

function transportError(
  error: unknown,
  signal: AbortSignal,
  timeout: AbortSignal,
  onTimeout: string,
): QaToolError {
  if (signal.aborted) return aborted();
  if (timeout.aborted) return new QaToolError("studio_unavailable", onTimeout);
  const reason = error instanceof Error ? error.message : String(error);
  return new QaToolError("studio_unavailable", `Studio's QA service is not reachable: ${reason}`);
}
