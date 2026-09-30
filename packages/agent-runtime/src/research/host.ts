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
  ResearchErrorCode,
  ResolveMissingRequest,
  ResolveMissingResult,
} from "@hyperframes/agent-protocol";

/**
 * Research as the runtime sees it: the Studio server's research service (the global Asset Search policy at
 * `/api/research/policy`, the project routes at `/api/projects/:id/research/*`). A host is bound to one project.
 *
 * The Studio server performs every search, page read and download, and it enforces the policy: a request never carries
 * a policy mode, and a request the policy does not allow is refused with `blocked_by_policy`. Reads and searches are
 * cancellable through their signal. An import or a resolution writes project files (the asset, its provenance record,
 * the Story node), so the turn awaits its end before the checkpoint closes: aborting the signal of a write asks the
 * server to cancel it, but the host keeps waiting for the server's answer (the write may already be committing) and
 * only then settles. It settles without an answer only after a bounded wait, and then with `write_unsettled` when a
 * write could still land.
 */
export interface ResearchHost {
  /** The user's Asset Search policy (mode and trusted sources). */
  policy(signal: AbortSignal): Promise<AssetSearchPolicy>;
  search(request: AssetSearchRequest, signal: AbortSignal): Promise<AssetSearchResult>;
  inspect(request: InspectUrlRequest, signal: AbortSignal): Promise<InspectUrlResult>;
  importAsset(request: ImportAssetRequest, signal: AbortSignal): Promise<ImportAssetResult>;
  resolve(request: ResolveMissingRequest, signal: AbortSignal): Promise<ResolveMissingResult>;
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
