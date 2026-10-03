import { randomUUID } from "node:crypto";
import {
  isAssetSearchPolicy,
  isAssetSearchResult,
  isCancelResearchRequestResult,
  isExportLicenseCheck,
  isImportAssetResult,
  isInspectUrlResult,
  isProjectSourcesView,
  isReadWebsiteResult,
  isRecord,
  isRecordWebsiteResult,
  isResearchError,
  isResolveMissingResult,
  isWebsiteFileResult,
  isWebsiteGrant,
  type AssetSearchPolicy,
  type AssetSearchRequest,
  type AssetSearchResult,
  type CancelRequestState,
  type ExportLicenseCheck,
  type ImportAssetRequest,
  type ImportAssetResult,
  type InspectUrlRequest,
  type InspectUrlResult,
  type ProjectSourcesView,
  type ReadWebsiteRequest,
  type ReadWebsiteResult,
  type RecordWebsiteRequest,
  type RecordWebsiteResult,
  type ResolveMissingRequest,
  type ResolveMissingResult,
  type UpdateAssetSearchPolicyRequest,
  type WebsiteFileRequest,
  type WebsiteFileResult,
  type WebsiteGrant,
  type WebsiteGrantRequest,
} from "@hyperframes/agent-protocol";
import type { ProjectScope } from "../checkpointHost.js";
import { ResearchToolError, type ResearchHost } from "./host.js";

/**
 * How long each call may take before the runtime stops waiting. A search fans out to several sources and a page read
 * follows redirects; an import downloads the file and may transcode it for the editor (minutes for a large video).
 */
export const RESEARCH_TIMEOUTS_MS = {
  read: 30_000,
  search: 90_000,
  inspect: 90_000,
  resolve: 60_000,
  importAsset: 15 * 60_000,
  /** Chrome renders the page (30 s budget) and a save downloads logo and fonts. */
  website: 120_000,
  /** A full-access download may be a large video (up to 300 MB) and can be converted for the editor. */
  websiteFile: 15 * 60_000,
  /** A page recording runs at most 30 s of real time plus the page load. */
  recordWebsite: 5 * 60_000,
} as const;

/**
 * After a write is cancelled (the turn was stopped, or the call timed out) the host keeps waiting this long for the
 * server's answer. The server checks the cancel right before it commits, so the answer normally comes at once; the
 * long part of an import (download, conversion) is abandoned as soon as the cancel arrives.
 */
export const WRITE_SETTLE_MS = 30_000;
/** How long the cancel request itself may take. */
const CANCEL_TIMEOUT_MS = 10_000;

export interface HttpResearchHostOptions {
  /** Overrides {@link RESEARCH_TIMEOUTS_MS}. */
  timeoutsMs?: Partial<Record<keyof typeof RESEARCH_TIMEOUTS_MS, number>>;
  /** Overrides {@link WRITE_SETTLE_MS}. */
  settleMs?: number;
}

interface RequestOptions {
  body?: unknown;
  signal: AbortSignal;
  timeoutMs: number;
  /** Shown when the call timed out, so the model knows whether to check what happened. */
  onTimeout: string;
}

/** What the server answered, before it is read as a success or a failure. */
interface Exchange {
  ok: boolean;
  status: number;
  payload: unknown;
}

/** The outcome of a request on the wire; never rejects, so a write's answer can be awaited after the caller left. */
type Outcome = { exchange: Exchange } | { error: unknown };

/** Studio's research HTTP API for one project (and the user's global Asset Search policy). */
export class HttpResearchHost implements ResearchHost {
  private readonly global: string;
  private readonly project: string;
  private readonly timeoutsMs: Record<keyof typeof RESEARCH_TIMEOUTS_MS, number>;
  private readonly settleMs: number;

  constructor(scope: ProjectScope, options: HttpResearchHostOptions = {}) {
    this.global = `${scope.studioOrigin}/api/research`;
    this.project = `${scope.studioOrigin}/api/projects/${encodeURIComponent(scope.projectId)}/research`;
    this.timeoutsMs = { ...RESEARCH_TIMEOUTS_MS, ...options.timeoutsMs };
    this.settleMs = options.settleMs ?? WRITE_SETTLE_MS;
  }

  async policy(signal: AbortSignal): Promise<AssetSearchPolicy> {
    const payload = await this.request("GET", `${this.global}/policy`, {
      signal,
      timeoutMs: this.timeoutsMs.read,
      onTimeout: "Studio did not answer in time.",
    });
    if (!isAssetSearchPolicy(payload)) throw invalidResponse("Asset Search policy");
    return payload;
  }

  async updateWebsitePolicy(
    request: UpdateAssetSearchPolicyRequest,
    signal: AbortSignal,
  ): Promise<AssetSearchPolicy> {
    const payload = await this.request("PUT", `${this.global}/policy`, {
      body: request,
      signal,
      timeoutMs: this.timeoutsMs.read,
      onTimeout: "Studio did not answer in time.",
    });
    if (!isAssetSearchPolicy(payload)) throw invalidResponse("Asset Search policy");
    return payload;
  }

  async grantWebsite(request: WebsiteGrantRequest, signal: AbortSignal): Promise<WebsiteGrant> {
    const payload = await this.request("POST", `${this.project}/website/grants`, {
      body: request,
      signal,
      timeoutMs: this.timeoutsMs.read,
      onTimeout: "Studio did not answer in time.",
    });
    if (!isWebsiteGrant(payload)) throw invalidResponse("website grant");
    return payload;
  }

  async revokeWebsiteGrant(turnId: string, signal: AbortSignal): Promise<void> {
    await this.request("DELETE", `${this.project}/website/grants/${encodeURIComponent(turnId)}`, {
      signal,
      timeoutMs: this.timeoutsMs.read,
      onTimeout: "Studio did not answer in time.",
    });
  }

  async search(request: AssetSearchRequest, signal: AbortSignal): Promise<AssetSearchResult> {
    const payload = await this.request("POST", `${this.project}/search`, {
      body: request,
      signal,
      timeoutMs: this.timeoutsMs.search,
      onTimeout: "The search did not finish in time; try fewer sources or a narrower query.",
    });
    if (!isAssetSearchResult(payload)) throw invalidResponse("search result");
    return payload;
  }

  async inspect(request: InspectUrlRequest, signal: AbortSignal): Promise<InspectUrlResult> {
    const payload = await this.request("POST", `${this.project}/inspect`, {
      body: request,
      signal,
      timeoutMs: this.timeoutsMs.inspect,
      onTimeout: "The page did not answer in time.",
    });
    if (!isInspectUrlResult(payload)) throw invalidResponse("page inspection result");
    return payload;
  }

  async importAsset(request: ImportAssetRequest, signal: AbortSignal): Promise<ImportAssetResult> {
    const payload = await this.write("import", request, {
      signal,
      timeoutMs: this.timeoutsMs.importAsset,
      onTimeout:
        "The import did not finish in time and was cancelled; read_sources shows whether the asset reached the project.",
    });
    if (!isImportAssetResult(payload)) throw invalidResponse("import result");
    return payload;
  }

  async resolve(
    request: ResolveMissingRequest,
    signal: AbortSignal,
  ): Promise<ResolveMissingResult> {
    const payload = await this.write("resolve", request, {
      signal,
      timeoutMs: this.timeoutsMs.resolve,
      onTimeout:
        "Studio did not answer in time and the resolution was cancelled; read_story shows whether the node was resolved.",
    });
    if (!isResolveMissingResult(payload)) throw invalidResponse("resolution result");
    return payload;
  }

  async website(request: ReadWebsiteRequest, signal: AbortSignal): Promise<ReadWebsiteResult> {
    const options = {
      signal,
      timeoutMs: this.timeoutsMs.website,
      onTimeout: "The website did not finish loading in time.",
    };
    const payload = request.save
      ? await this.write("website", request, options)
      : await this.request("POST", `${this.project}/website`, { ...options, body: request });
    if (!isReadWebsiteResult(payload)) throw invalidResponse("website result");
    return payload;
  }

  async websiteFile(request: WebsiteFileRequest, signal: AbortSignal): Promise<WebsiteFileResult> {
    const options = {
      signal,
      timeoutMs: this.timeoutsMs.websiteFile,
      onTimeout:
        "The file did not finish downloading in time and was cancelled; read_sources shows whether it reached the project.",
    };
    // A read returns text and writes nothing; a save downloads the file and is awaited like an import.
    const payload =
      request.mode === "save"
        ? await this.write("website/file", request, options)
        : await this.request("POST", `${this.project}/website/file`, { ...options, body: request });
    if (!isWebsiteFileResult(payload)) throw invalidResponse("website file result");
    return payload;
  }

  async recordWebsite(
    request: RecordWebsiteRequest,
    signal: AbortSignal,
  ): Promise<RecordWebsiteResult> {
    const payload = await this.write("website/record", request, {
      signal,
      timeoutMs: this.timeoutsMs.recordWebsite,
      onTimeout:
        "The recording did not finish in time and was cancelled; check the project before trying again.",
    });
    if (!isRecordWebsiteResult(payload)) throw invalidResponse("website recording result");
    return payload;
  }

  async sources(signal: AbortSignal): Promise<ProjectSourcesView> {
    const payload = await this.request("GET", `${this.project}/sources`, {
      signal,
      timeoutMs: this.timeoutsMs.read,
      onTimeout: "Studio did not answer in time.",
    });
    if (!isProjectSourcesView(payload)) throw invalidResponse("sources view");
    return payload;
  }

  async exportCheck(composition: string, signal: AbortSignal): Promise<ExportLicenseCheck> {
    const payload = await this.request(
      "GET",
      `${this.project}/export-check?composition=${encodeURIComponent(composition)}`,
      { signal, timeoutMs: this.timeoutsMs.read, onTimeout: "Studio did not answer in time." },
    );
    if (!isExportLicenseCheck(payload)) throw invalidResponse("export license check");
    return payload;
  }

  /** A read: abandoned (the connection closed) as soon as the caller's signal aborts or the call times out. */
  private async request(
    method: "GET" | "POST" | "PUT" | "DELETE",
    url: string,
    { body, signal, timeoutMs, onTimeout }: RequestOptions,
  ): Promise<unknown> {
    if (signal.aborted) throw aborted();
    const timeout = AbortSignal.timeout(timeoutMs);
    const outcome = await this.exchange(method, url, body, AbortSignal.any([signal, timeout]));
    if ("error" in outcome) throw transportError(outcome.error, signal, timeout, onTimeout);
    return payloadOf(outcome.exchange);
  }

  /**
   * An import, a resolution, a saved website read, a full-access download or a page recording: it writes project
   * files, so stopping it must not end with a write landing after the
   * turn's checkpoint closed. The call carries a fresh request id; when the caller's signal aborts (the turn was
   * stopped) or the call times out, the host sends an explicit cancel and keeps waiting for the original request's
   * answer instead of dropping the connection:
   *
   * - the server checks a cancel right before it commits, so it answers `cancelled` (nothing written) or, when the
   *   commit had started, the normal result — which is then returned, because that write happened;
   * - if the answer does not come within `settleMs`: when the cancel was acknowledged as `cancelled` the server has
   *   promised never to write, so the host gives up safely; otherwise a write may still land, and the host fails with
   *   `write_unsettled` so the turn reports it instead of pretending the checkpoint is clean. Waiting longer is not
   *   safer: the commit itself is synchronous on the server, so an answer this late means Studio is stuck *after* its
   *   write, and a stuck Studio must not hold the turn (and the user's Stop) forever.
   */
  private async write(
    path: "import" | "resolve" | "website" | "website/file" | "website/record",
    request:
      | ImportAssetRequest
      | ResolveMissingRequest
      | ReadWebsiteRequest
      | WebsiteFileRequest
      | RecordWebsiteRequest,
    { signal, timeoutMs, onTimeout }: Omit<RequestOptions, "body">,
  ): Promise<unknown> {
    if (signal.aborted) throw aborted();
    const requestId = randomUUID();
    const timeout = AbortSignal.timeout(timeoutMs);
    // The connection stays open after the caller is gone; only the host closes it, once the outcome is settled.
    const wire = new AbortController();
    const answer = this.exchange(
      "POST",
      `${this.project}/${path}`,
      { ...request, requestId },
      wire.signal,
    );
    const stopped = Promise.withResolvers<"stopped">();
    const onStop = () => stopped.resolve("stopped");
    signal.addEventListener("abort", onStop, { once: true });
    timeout.addEventListener("abort", onStop, { once: true });
    try {
      const first = await Promise.race([answer, stopped.promise]);
      if (first !== "stopped") return this.answered(first, signal, timeout, onTimeout);

      const state = await this.cancel(requestId);
      const late = await waitFor(answer, this.settleMs);
      if (late !== "waiting") return this.answered(late, signal, timeout, onTimeout);
      if (state === "cancelled") throw transportError(null, signal, timeout, onTimeout);
      throw new ResearchToolError(
        "write_unsettled",
        `The ${path} was cancelled but Studio did not say whether it wrote anything` +
          ` (cancel answered ${state ?? "nothing"}); the file may still appear in the project.`,
      );
    } finally {
      signal.removeEventListener("abort", onStop);
      timeout.removeEventListener("abort", onStop);
      wire.abort();
    }
  }

  /** The server's final answer to a write. A `cancelled` answer means the stop reached it before its commit. */
  private answered(
    outcome: Outcome,
    signal: AbortSignal,
    timeout: AbortSignal,
    onTimeout: string,
  ): unknown {
    if ("error" in outcome) throw transportError(outcome.error, signal, timeout, onTimeout);
    try {
      return payloadOf(outcome.exchange);
    } catch (error) {
      if (error instanceof ResearchToolError && error.code === "cancelled") {
        throw transportError(error, signal, timeout, onTimeout);
      }
      throw error;
    }
  }

  /** Asks Studio to cancel a write; `null` when Studio could not be asked (the write's fate is then unknown). */
  private async cancel(requestId: string): Promise<CancelRequestState | null> {
    const outcome = await this.exchange(
      "POST",
      `${this.project}/requests/${encodeURIComponent(requestId)}/cancel`,
      undefined,
      AbortSignal.timeout(CANCEL_TIMEOUT_MS),
    );
    if ("error" in outcome || !outcome.exchange.ok) return null;
    const { payload } = outcome.exchange;
    return isCancelResearchRequestResult(payload) ? payload.state : null;
  }

  private async exchange(
    method: "GET" | "POST" | "PUT" | "DELETE",
    url: string,
    body: unknown,
    signal: AbortSignal,
  ): Promise<Outcome> {
    try {
      const response = await fetch(url, {
        method,
        signal,
        ...(body !== undefined && {
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        }),
      });
      let payload: unknown;
      try {
        payload = await response.json();
      } catch (error) {
        // The body may still be streaming when the call is cancelled or times out.
        if (signal.aborted) throw error;
        payload = null;
      }
      return { exchange: { ok: response.ok, status: response.status, payload } };
    } catch (error) {
      return { error };
    }
  }
}

/** The payload of a successful answer; a failure becomes a {@link ResearchToolError} with the service's code. */
function payloadOf({ ok, status, payload }: Exchange): unknown {
  if (ok) return payload;
  const failure = isRecord(payload) ? payload.error : undefined;
  if (isResearchError(failure)) throw new ResearchToolError(failure.code, failure.message);
  throw new ResearchToolError(
    "studio_unavailable",
    typeof failure === "string"
      ? failure
      : `Studio's research service failed the request (${status}).`,
  );
}

/** `promise`'s outcome, or "waiting" once `ms` have passed. */
async function waitFor<T>(promise: Promise<T>, ms: number): Promise<T | "waiting"> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const elapsed = new Promise<"waiting">((resolve) => {
    timer = setTimeout(() => resolve("waiting"), ms);
  });
  try {
    return await Promise.race([promise, elapsed]);
  } finally {
    clearTimeout(timer);
  }
}

function aborted(): ResearchToolError {
  return new ResearchToolError("aborted", "The operation was cancelled.");
}

function invalidResponse(what: string): ResearchToolError {
  return new ResearchToolError("studio_unavailable", `Studio returned an invalid ${what}.`);
}

function transportError(
  error: unknown,
  signal: AbortSignal,
  timeout: AbortSignal,
  onTimeout: string,
): ResearchToolError {
  if (signal.aborted) return aborted();
  if (timeout.aborted) return new ResearchToolError("studio_unavailable", onTimeout);
  const reason = error instanceof Error ? error.message : String(error);
  return new ResearchToolError(
    "studio_unavailable",
    `Studio's research service is not reachable: ${reason}`,
  );
}
