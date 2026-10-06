import {
  isAssetSearchPolicy,
  isAssetSearchResult,
  isExportLicenseCheck,
  isImportAssetResult,
  isInspectUrlResult,
  isProjectSourcesView,
  isReadWebsiteResult,
  isRecordWebsiteResult,
  isResolveMissingResult,
  isWebsiteFileResult,
  isWebsiteGrant,
  type AssetSearchPolicy,
  type AssetSearchRequest,
  type AssetSearchResult,
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
import type { ResearchHost } from "./host.js";
import { invalidResponse, StudioTransport, type RequestOptions } from "./transport.js";

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

export interface HttpResearchHostOptions {
  /** Overrides {@link RESEARCH_TIMEOUTS_MS}. */
  timeoutsMs?: Partial<Record<keyof typeof RESEARCH_TIMEOUTS_MS, number>>;
  /** Overrides the shared write settle bound (`WRITE_SETTLE_MS`). */
  settleMs?: number;
}

/** Studio's research HTTP API for one project (and the user's global Asset Search policy). */
export class HttpResearchHost implements ResearchHost {
  private readonly global: string;
  private readonly project: string;
  private readonly timeoutsMs: Record<keyof typeof RESEARCH_TIMEOUTS_MS, number>;
  private readonly transport: StudioTransport;

  constructor(scope: ProjectScope, options: HttpResearchHostOptions = {}) {
    this.global = `${scope.studioOrigin}/api/research`;
    this.project = `${scope.studioOrigin}/api/projects/${encodeURIComponent(scope.projectId)}/research`;
    this.timeoutsMs = { ...RESEARCH_TIMEOUTS_MS, ...options.timeoutsMs };
    this.transport = new StudioTransport({
      service: "research",
      ...(options.settleMs !== undefined && { settleMs: options.settleMs }),
    });
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

  private request(
    method: "GET" | "POST" | "PUT" | "DELETE",
    url: string,
    options: RequestOptions,
  ): Promise<unknown> {
    return this.transport.request(method, url, options);
  }

  /**
   * An import, a resolution, a saved website read, a full-access download or a page recording: it writes project
   * files, so it goes through the shared cancellable write (see {@link StudioTransport.write}).
   */
  private write(
    path: "import" | "resolve" | "website" | "website/file" | "website/record",
    request:
      | ImportAssetRequest
      | ResolveMissingRequest
      | ReadWebsiteRequest
      | WebsiteFileRequest
      | RecordWebsiteRequest,
    options: Omit<RequestOptions, "body">,
  ): Promise<unknown> {
    return this.transport.write(request, {
      ...options,
      url: `${this.project}/${path}`,
      cancelUrl: (requestId) => `${this.project}/requests/${encodeURIComponent(requestId)}/cancel`,
      label: path,
    });
  }
}
