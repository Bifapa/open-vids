import {
  isAssetSearchPolicy,
  isAssetSearchResult,
  isExportLicenseCheck,
  isImportAssetResult,
  isInspectUrlResult,
  isProjectSourcesView,
  isRecord,
  isResearchError,
  isResolveMissingResult,
  type AssetSearchPolicy,
  type AssetSearchRequest,
  type AssetSearchResult,
  type ExportLicenseCheck,
  type ImportAssetRequest,
  type ImportAssetResult,
  type InspectUrlRequest,
  type InspectUrlResult,
  type ProjectSourcesView,
  type ResolveMissingRequest,
  type ResolveMissingResult,
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
} as const;

interface RequestOptions {
  body?: unknown;
  signal: AbortSignal;
  timeoutMs: number;
  /** Shown when the call timed out, so the model knows whether to check what happened. */
  onTimeout: string;
}

/** Studio's research HTTP API for one project (and the user's global Asset Search policy). */
export class HttpResearchHost implements ResearchHost {
  private readonly global: string;
  private readonly project: string;

  constructor(scope: ProjectScope) {
    this.global = `${scope.studioOrigin}/api/research`;
    this.project = `${scope.studioOrigin}/api/projects/${encodeURIComponent(scope.projectId)}/research`;
  }

  async policy(signal: AbortSignal): Promise<AssetSearchPolicy> {
    const payload = await this.request("GET", `${this.global}/policy`, {
      signal,
      timeoutMs: RESEARCH_TIMEOUTS_MS.read,
      onTimeout: "Studio did not answer in time.",
    });
    if (!isAssetSearchPolicy(payload)) throw invalidResponse("Asset Search policy");
    return payload;
  }

  async search(request: AssetSearchRequest, signal: AbortSignal): Promise<AssetSearchResult> {
    const payload = await this.request("POST", `${this.project}/search`, {
      body: request,
      signal,
      timeoutMs: RESEARCH_TIMEOUTS_MS.search,
      onTimeout: "The search did not finish in time; try fewer sources or a narrower query.",
    });
    if (!isAssetSearchResult(payload)) throw invalidResponse("search result");
    return payload;
  }

  async inspect(request: InspectUrlRequest, signal: AbortSignal): Promise<InspectUrlResult> {
    const payload = await this.request("POST", `${this.project}/inspect`, {
      body: request,
      signal,
      timeoutMs: RESEARCH_TIMEOUTS_MS.inspect,
      onTimeout: "The page did not answer in time.",
    });
    if (!isInspectUrlResult(payload)) throw invalidResponse("page inspection result");
    return payload;
  }

  async importAsset(request: ImportAssetRequest, signal: AbortSignal): Promise<ImportAssetResult> {
    const payload = await this.request("POST", `${this.project}/import`, {
      body: request,
      signal,
      timeoutMs: RESEARCH_TIMEOUTS_MS.importAsset,
      onTimeout:
        "The import did not finish in time; read_sources shows whether the asset reached the project.",
    });
    if (!isImportAssetResult(payload)) throw invalidResponse("import result");
    return payload;
  }

  async resolve(
    request: ResolveMissingRequest,
    signal: AbortSignal,
  ): Promise<ResolveMissingResult> {
    const payload = await this.request("POST", `${this.project}/resolve`, {
      body: request,
      signal,
      timeoutMs: RESEARCH_TIMEOUTS_MS.resolve,
      onTimeout: "Studio did not answer in time; read_story shows whether the node was resolved.",
    });
    if (!isResolveMissingResult(payload)) throw invalidResponse("resolution result");
    return payload;
  }

  async sources(signal: AbortSignal): Promise<ProjectSourcesView> {
    const payload = await this.request("GET", `${this.project}/sources`, {
      signal,
      timeoutMs: RESEARCH_TIMEOUTS_MS.read,
      onTimeout: "Studio did not answer in time.",
    });
    if (!isProjectSourcesView(payload)) throw invalidResponse("sources view");
    return payload;
  }

  async exportCheck(composition: string, signal: AbortSignal): Promise<ExportLicenseCheck> {
    const payload = await this.request(
      "GET",
      `${this.project}/export-check?composition=${encodeURIComponent(composition)}`,
      { signal, timeoutMs: RESEARCH_TIMEOUTS_MS.read, onTimeout: "Studio did not answer in time." },
    );
    if (!isExportLicenseCheck(payload)) throw invalidResponse("export license check");
    return payload;
  }

  private async request(
    method: "GET" | "POST",
    url: string,
    { body, signal, timeoutMs, onTimeout }: RequestOptions,
  ): Promise<unknown> {
    if (signal.aborted) throw aborted();
    const timeout = AbortSignal.timeout(timeoutMs);
    const combined = AbortSignal.any([signal, timeout]);
    let response: Response;
    try {
      response = await fetch(url, {
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
    if (isResearchError(failure)) throw new ResearchToolError(failure.code, failure.message);
    throw new ResearchToolError(
      "studio_unavailable",
      typeof failure === "string"
        ? failure
        : `Studio's research service failed the request (${response.status}).`,
    );
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
