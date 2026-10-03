import type {
  AssetSearchPolicy,
  AssetSearchRequest,
  AssetSearchResult,
  ExportLicenseCheck,
  ImportAssetRequest,
  ImportAssetResult,
  InspectUrlRequest,
  InspectUrlResult,
  ProjectSourcesView,
  ReadWebsiteRequest,
  ReadWebsiteResult,
  RecordWebsiteRequest,
  RecordWebsiteResult,
  ResearchErrorCode,
  ResolveMissingRequest,
  ResolveMissingResult,
  UpdateAssetSearchPolicyRequest,
  WebsiteFileRequest,
  WebsiteFileResult,
  WebsiteGrant,
  WebsiteGrantRequest,
} from "@hyperframes/agent-protocol";

/**
 * Research as the runtime sees it: the Studio server's research service (the global Asset Search policy at
 * `/api/research/policy`, the project routes at `/api/projects/:id/research/*`). A host is bound to one project.
 *
 * The Studio server performs every search, page read and download, and it enforces the policy: a request never carries
 * a policy mode, and a request the policy does not allow is refused with `blocked_by_policy`. Reads and searches are
 * cancellable through their signal. An import, a resolution or a saved website read writes project files (the asset, its provenance record,
 * the Story node), so the turn awaits its end before the checkpoint closes: aborting the signal of a write asks the
 * server to cancel it, but the host keeps waiting for the server's answer (the write may already be committing) and
 * only then settles. It settles without an answer only after a bounded wait, and then with `write_unsettled` when a
 * write could still land.
 */
export interface ResearchHost {
  /** The user's Asset Search policy (mode and trusted sources). */
  policy(signal: AbortSignal): Promise<AssetSearchPolicy>;
  /**
   * `PUT /api/research/policy` with only the Websites switches: the user answered "Turn on" to a permission request
   * in the chat. Studio merges the partial update and answers the fresh policy.
   */
  updateWebsitePolicy(
    request: UpdateAssetSearchPolicyRequest,
    signal: AbortSignal,
  ): Promise<AssetSearchPolicy>;
  /**
   * `POST /api/projects/:id/research/website/grants`: the user answered "Allow once" to a permission request, so
   * website calls of that turn pass the setting's check as if it were on (a `full` grant also satisfies reading).
   * Studio keeps it until {@link revokeWebsiteGrant} or its own expiry.
   */
  grantWebsite(request: WebsiteGrantRequest, signal: AbortSignal): Promise<WebsiteGrant>;
  /** `DELETE /api/projects/:id/research/website/grants/:turnId`: the turn ended; Studio drops the grant. */
  revokeWebsiteGrant(turnId: string, signal: AbortSignal): Promise<void>;
  search(request: AssetSearchRequest, signal: AbortSignal): Promise<AssetSearchResult>;
  inspect(request: InspectUrlRequest, signal: AbortSignal): Promise<InspectUrlResult>;
  importAsset(request: ImportAssetRequest, signal: AbortSignal): Promise<ImportAssetResult>;
  resolve(request: ResolveMissingRequest, signal: AbortSignal): Promise<ResolveMissingResult>;
  /**
   * Reads a website's visual style (and screenshots). With `save` it also writes the screenshots, logo and fonts into
   * `assets/web/<host>/` with provenance, so like an import it is awaited to its end before the checkpoint closes.
   * The runtime decides which sites the user linked; the server enforces the user's switch and public-address rules.
   */
  website(request: ReadWebsiteRequest, signal: AbortSignal): Promise<ReadWebsiteResult>;
  /**
   * Full access to a linked site: downloads one file it serves (or its pages load) into `assets/web/<host>/files/`
   * with a provenance record (`mode: "save"`), or returns the raw text of a page, style sheet or script
   * (`mode: "read"`). The runtime decides which URLs are allowed (a linked site, or a file an earlier read of it
   * listed); the server enforces the user's full-access switch and the public-address rules. `save` writes, so it is
   * awaited to its end before the checkpoint closes.
   */
  websiteFile(request: WebsiteFileRequest, signal: AbortSignal): Promise<WebsiteFileResult>;
  /**
   * Full access to a linked site: records a page as an MP4 in `assets/web/<host>/recordings/` for `seconds` (real
   * time). It writes, so it is awaited to its end before the checkpoint closes.
   */
  recordWebsite(request: RecordWebsiteRequest, signal: AbortSignal): Promise<RecordWebsiteResult>;
  /** The project's Sources/Licenses view. */
  sources(signal: AbortSignal): Promise<ProjectSourcesView>;
  /** What an export of the composition would ship: license warnings and credits. */
  exportCheck(composition: string, signal: AbortSignal): Promise<ExportLicenseCheck>;
}

/**
 * Failures that do not come from the research service's validation: transport and cancellation.
 * `write_unsettled`: an import or resolution was cancelled but the server never said whether it wrote — the file may
 * still land after the turn's checkpoint closed.
 */
export type ResearchToolErrorCode =
  | ResearchErrorCode
  | "studio_unavailable"
  | "aborted"
  | "write_unsettled";

/** A research failure the model can act on: a stable code and a message. */
export class ResearchToolError extends Error {
  readonly code: ResearchToolErrorCode;

  constructor(code: ResearchToolErrorCode, message: string) {
    super(message);
    this.name = "ResearchToolError";
    this.code = code;
  }
}
