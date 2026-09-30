import type {
  AssetCandidate,
  AssetProvenance,
  AssetSearchPolicy,
  AssetSearchRequest,
  AssetSearchResult,
  ExportLicenseCheck,
  ImportAssetRequest,
  ImportAssetResult,
  InspectUrlRequest,
  InspectUrlResult,
  LicenseInfo,
  ProjectSourcesView,
  ResolveMissingRequest,
  ResolveMissingResult,
  TrustedSource,
} from "@hyperframes/agent-protocol";
import { storyView } from "./story.js";
import { ResearchToolError, type ResearchHost } from "../research/host.js";

export function trustedSource(id: string, overrides: Partial<TrustedSource> = {}): TrustedSource {
  return {
    id,
    name: id === "wikimedia-commons" ? "Wikimedia Commons" : id,
    builtIn: true,
    enabled: true,
    connector: "wikimedia_commons",
    domains: ["wikimedia.org"],
    kinds: ["video", "picture", "audio"],
    description: "Free media files",
    licenseNote: "Each file has its own free license",
    homepage: null,
    ...overrides,
  };
}

/** The user's Asset Search policy: trusted mode with Wikimedia Commons and NASA Images enabled unless overridden. */
export function researchPolicy(overrides: Partial<AssetSearchPolicy> = {}): AssetSearchPolicy {
  return {
    mode: "trusted",
    sources: [
      trustedSource("wikimedia-commons"),
      trustedSource("nasa-images", {
        name: "NASA Images",
        connector: "nasa_images",
        domains: ["nasa.gov"],
        kinds: ["video", "picture", "audio"],
        licenseNote: "NASA media is generally not copyrighted",
      }),
    ],
    removedBuiltIns: [],
    updatedAt: 1,
    ...overrides,
  };
}

export function ccBy(overrides: Partial<LicenseInfo> = {}): LicenseInfo {
  return {
    id: "cc_by",
    name: "CC BY 4.0",
    url: "https://creativecommons.org/licenses/by/4.0/",
    confidence: "high",
    status: "attribution",
    basis: "Wikimedia Commons API (LicenseShortName)",
    ...overrides,
  };
}

export function sampleCandidate(
  id: string,
  overrides: Partial<AssetCandidate> = {},
): AssetCandidate {
  return {
    id,
    mediaKind: "video",
    title: "Ocean waves",
    description: "Waves rolling onto a beach",
    source: { id: "wikimedia-commons", name: "Wikimedia Commons", trusted: true },
    pageUrl: "https://commons.wikimedia.org/wiki/File:Ocean_waves.webm",
    mediaUrl: "https://upload.wikimedia.org/Ocean_waves.webm",
    previewUrl: null,
    author: "Jane Doe",
    authorUrl: null,
    license: ccBy(),
    width: 1920,
    height: 1080,
    duration: 12.5,
    bytes: 4_200_000,
    contentType: "video/webm",
    inProject: null,
    ...overrides,
  };
}

export function sampleProvenance(overrides: Partial<AssetProvenance> = {}): AssetProvenance {
  return {
    id: "prov-1",
    asset: "assets/research/ocean-waves.mp4",
    mediaKind: "video",
    title: "Ocean waves",
    originalUrl: "https://upload.wikimedia.org/Ocean_waves.webm",
    pageUrl: "https://commons.wikimedia.org/wiki/File:Ocean_waves.webm",
    source: { id: "wikimedia-commons", name: "Wikimedia Commons", trusted: true },
    author: "Jane Doe",
    authorUrl: null,
    license: "CC BY 4.0",
    licenseId: "cc_by",
    licenseUrl: "https://creativecommons.org/licenses/by/4.0/",
    licenseConfidence: "high",
    licenseStatus: "attribution",
    licenseBasis: "Wikimedia Commons API (LicenseShortName)",
    attribution: "“Ocean waves” by Jane Doe, CC BY 4.0, via Wikimedia Commons",
    retrievedAt: 1_700_000_000_000,
    retrievedBy: { agent: "research", turnId: "t1", model: null },
    policyMode: "trusted",
    sha256: "a".repeat(64),
    originalSha256: "b".repeat(64),
    bytes: 4_200_000,
    contentType: "video/mp4",
    converted: "VP9/WebM → H.264/MP4",
    storyNode: null,
    need: null,
    ...overrides,
  };
}

export function sampleSearchResult(
  request: AssetSearchRequest,
  candidates: AssetCandidate[],
): AssetSearchResult {
  return {
    mode: "trusted",
    query: request.query,
    mediaKind: request.mediaKind,
    candidates,
    searched: [
      {
        source: { id: "wikimedia-commons", name: "Wikimedia Commons", trusted: true },
        results: candidates.length,
        error: null,
      },
    ],
    blocked: [],
    notes: [],
  };
}

export function sampleSourcesView(): ProjectSourcesView {
  return {
    records: [
      {
        ...sampleProvenance(),
        present: true,
        usedIn: ["index.html"],
        issues: [],
      },
    ],
    summary: { clear: 0, attribution: 1, restricted: 0, unknown: 0, total: 1, missingFiles: 0 },
    credits: ["“Ocean waves” by Jane Doe, CC BY 4.0, via Wikimedia Commons"],
    mode: "trusted",
  };
}

/**
 * Deterministic in-memory research host for runtime tests and embedding harnesses. It records every request and
 * answers from the fields below. Like the real service, an import or a resolution that already reached it ignores
 * aborts (it writes project files); `importGate` holds one open so tests can finish a turn while an import is in
 * flight. It never enforces the Asset Search policy itself: tests make it refuse with `nextError`.
 */
export class FakeResearchHost implements ResearchHost {
  policyResult: AssetSearchPolicy = researchPolicy();
  /** The next `policy` call rejects with this error. */
  nextPolicyError: ResearchToolError | null = null;
  /** What `search` returns (candidates); the request's query and kind are echoed. */
  searchCandidates: AssetCandidate[] = [];
  /** When set, `search` answers with this result as is. */
  searchResult: AssetSearchResult | null = null;
  inspectResult: InspectUrlResult | null = null;
  /** What `importAsset` answers; default: a fresh import of `assets/research/ocean-waves.mp4`. */
  importResult: ImportAssetResult | null = null;
  sourcesResult: ProjectSourcesView = sampleSourcesView();
  exportCheckResult: ExportLicenseCheck = {
    composition: "index.html",
    assets: [],
    warnings: [],
    credits: [],
  };
  /** The next search/inspect/import/resolve/sources call rejects with this error. */
  nextError: ResearchToolError | null = null;
  nextExportCheckError: ResearchToolError | null = null;
  /** While set, `importAsset` records the request and then waits for it before answering. */
  importGate: Promise<void> | null = null;

  policyCalls = 0;
  readonly searchRequests: AssetSearchRequest[] = [];
  readonly inspectRequests: InspectUrlRequest[] = [];
  readonly importRequests: ImportAssetRequest[] = [];
  readonly importFinished: ImportAssetRequest[] = [];
  /** The signal each import was given, so tests can see when the turn stopped waiting for it. */
  readonly importSignals: AbortSignal[] = [];
  readonly resolveRequests: ResolveMissingRequest[] = [];
  readonly exportChecks: string[] = [];
  sourcesCalls = 0;

  async policy(signal: AbortSignal): Promise<AssetSearchPolicy> {
    if (signal.aborted) throw aborted();
    this.policyCalls += 1;
    if (this.nextPolicyError) {
      const error = this.nextPolicyError;
      this.nextPolicyError = null;
      throw error;
    }
    return structuredClone(this.policyResult);
  }

  async search(request: AssetSearchRequest, signal: AbortSignal): Promise<AssetSearchResult> {
    if (signal.aborted) throw aborted();
    this.searchRequests.push(request);
    this.throwNextError();
    return structuredClone(this.searchResult ?? sampleSearchResult(request, this.searchCandidates));
  }

  async inspect(request: InspectUrlRequest, signal: AbortSignal): Promise<InspectUrlResult> {
    if (signal.aborted) throw aborted();
    this.inspectRequests.push(request);
    this.throwNextError();
    return structuredClone(
      this.inspectResult ?? {
        url: request.url,
        finalUrl: request.url,
        title: "A page",
        source: { id: "web", name: "Web", trusted: false },
        author: null,
        license: {
          id: "unknown",
          name: "Unknown",
          url: null,
          confidence: "none",
          status: "unknown",
          basis: "no license found",
        },
        candidates: this.searchCandidates,
        notes: [],
      },
    );
  }

  async importAsset(request: ImportAssetRequest, signal: AbortSignal): Promise<ImportAssetResult> {
    if (signal.aborted) throw aborted();
    this.importRequests.push(request);
    this.importSignals.push(signal);
    if (this.importGate) await this.importGate;
    this.throwNextError();
    this.importFinished.push(request);
    return structuredClone(
      this.importResult ?? {
        asset: "assets/research/ocean-waves.mp4",
        provenance: sampleProvenance({
          storyNode: request.resolveMissing ?? null,
          retrievedBy: {
            agent: request.agent ?? "user",
            turnId: request.turnId ?? null,
            model: request.model ?? null,
          },
        }),
        fetch: "network",
        duplicate: null,
        resolved: request.resolveMissing ? { missing: request.resolveMissing, node: "v9" } : null,
        resolveError: null,
        warnings: [],
      },
    );
  }

  async resolve(
    request: ResolveMissingRequest,
    signal: AbortSignal,
  ): Promise<ResolveMissingResult> {
    if (signal.aborted) throw aborted();
    this.resolveRequests.push(request);
    this.throwNextError();
    return {
      missing: request.missing,
      node: "v9",
      asset: request.asset,
      view: storyView(null),
    };
  }

  async sources(signal: AbortSignal): Promise<ProjectSourcesView> {
    if (signal.aborted) throw aborted();
    this.sourcesCalls += 1;
    this.throwNextError();
    return structuredClone(this.sourcesResult);
  }

  async exportCheck(composition: string, signal: AbortSignal): Promise<ExportLicenseCheck> {
    if (signal.aborted) throw aborted();
    this.exportChecks.push(composition);
    if (this.nextExportCheckError) {
      const error = this.nextExportCheckError;
      this.nextExportCheckError = null;
      throw error;
    }
    return structuredClone({ ...this.exportCheckResult, composition });
  }

  private throwNextError(): void {
    if (!this.nextError) return;
    const error = this.nextError;
    this.nextError = null;
    throw error;
  }
}

function aborted(): ResearchToolError {
  return new ResearchToolError("aborted", "The operation was cancelled.");
}
