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
  ReadWebsiteRequest,
  ReadWebsiteResult,
  RecordWebsiteRequest,
  RecordWebsiteResult,
  ResolveMissingRequest,
  ResolveMissingResult,
  TrustedSource,
  UpdateAssetSearchPolicyRequest,
  WebsiteFileRequest,
  WebsiteFileResult,
  WebsiteGrant,
  WebsiteGrantRequest,
  WebsiteStyle,
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
    websites: { readLinkedPages: true, fullAccess: false },
    updatedAt: 1,
    ...overrides,
  };
}

/** A website's extracted style as the server would answer it, for `url` (default https://example.com/). */
export function sampleWebsiteStyle(url = "https://example.com/"): WebsiteStyle {
  const host = new URL(url).hostname.replace(/^www\./, "");
  return {
    url,
    finalUrl: url,
    host,
    title: "Example — build better",
    description: "A fictional product site.",
    themeColor: "#0b0b0f",
    language: "en",
    colors: [
      { hex: "#0b0b0f", role: "background", count: 40 },
      { hex: "#16161d", role: "surface", count: 12 },
      { hex: "#f4f4f5", role: "text", count: 30 },
      { hex: "#5e6ad2", role: "accent", count: 9 },
    ],
    fonts: [
      {
        family: "Inter",
        weights: [400, 600],
        source: "google",
        url: null,
        usedFor: ["heading", "body"],
      },
      {
        family: "Brand Display",
        weights: [700],
        source: "self_hosted",
        url: `https://${host}/fonts/brand.woff2`,
        usedFor: ["heading"],
      },
    ],
    textStyles: [
      {
        element: "h1",
        sample: "Build better",
        fontFamily: "Inter",
        fontSizePx: 64,
        fontWeight: 600,
        lineHeightPx: 64,
        letterSpacingPx: -1.5,
        color: "#f4f4f5",
      },
    ],
    radii: [{ px: 8, count: 14 }],
    shadows: ["0 8px 24px rgba(0,0,0,0.4)"],
    buttons: [
      {
        label: "Get started",
        background: "#5e6ad2",
        color: "#ffffff",
        border: null,
        radiusPx: 8,
        fontSizePx: 14,
        fontWeight: 600,
        padding: "8px 16px",
        shadow: null,
      },
    ],
    tokens: [{ name: "--color-accent", value: "#5e6ad2" }],
    motion: {
      durationsMs: [150, 300],
      easings: ["cubic-bezier(0.16, 1, 0.3, 1)"],
      keyframes: ["fade-up"],
      properties: ["opacity", "transform"],
    },
    logos: [{ source: "inline_svg", url, alt: "Example", width: 96, height: 24, captured: true }],
    favicon: `https://${host}/favicon.ico`,
    ogImage: null,
    headings: ["Build better products"],
    navLabels: ["Product", "Pricing"],
    notes: [],
    resources: [
      {
        url: `https://${host}/media/hero.mp4`,
        kind: "video",
        mimeType: "video/mp4",
        bytes: 4_200_000,
        width: 1920,
        height: 1080,
        duration: 6.5,
        usage: "<video> autoplay loop in .hero",
      },
      {
        url: `https://${host}/img/product.png`,
        kind: "image",
        mimeType: "image/png",
        bytes: 180_000,
        width: 1200,
        height: 800,
        duration: null,
        usage: "product card",
      },
      {
        url: "https://cdn.example-cdn.com/lottie/loader.json",
        kind: "animation",
        mimeType: "application/json",
        bytes: 90_000,
        width: null,
        height: null,
        duration: null,
        usage: "Lottie player in .badge",
      },
      {
        url: `https://${host}/fonts/brand.woff2`,
        kind: "font",
        mimeType: "font/woff2",
        bytes: 48_000,
        width: null,
        height: null,
        duration: null,
        usage: "headings",
      },
      {
        url: `https://${host}/app.css`,
        kind: "stylesheet",
        mimeType: "text/css",
        bytes: 12_000,
        width: null,
        height: null,
        duration: null,
        usage: "global styles",
      },
    ],
    capturedAt: 1,
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
  /** The next `updateWebsitePolicy`, `grantWebsite` or `revokeWebsiteGrant` call rejects with this error. */
  nextPermissionError: ResearchToolError | null = null;
  /** What `search` returns (candidates); the request's query and kind are echoed. */
  searchCandidates: AssetCandidate[] = [];
  /** When set, `search` answers with this result as is. */
  searchResult: AssetSearchResult | null = null;
  inspectResult: InspectUrlResult | null = null;
  /** What `website` answers; default: {@link sampleWebsiteStyle} of the requested URL with two screenshots. */
  websiteResult: ReadWebsiteResult | null = null;
  /** What `websiteFile` answers; default: a site file in `assets/web/<host>/files/` or a sample stylesheet text. */
  websiteFileResult: WebsiteFileResult | null = null;
  /** What `recordWebsite` answers; default: an MP4 in the site's `recordings/` folder. */
  recordResult: RecordWebsiteResult | null = null;
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
  /** Every `PUT /api/research/policy` the runtime sent (the user's "Turn on"). */
  readonly policyUpdates: UpdateAssetSearchPolicyRequest[] = [];
  /** Every grant the runtime posted (the user's "Allow once"). */
  readonly grants: WebsiteGrantRequest[] = [];
  /** Every turn id whose grant the runtime revoked at the turn's end. */
  readonly revokedGrants: string[] = [];
  readonly searchRequests: AssetSearchRequest[] = [];
  readonly inspectRequests: InspectUrlRequest[] = [];
  readonly websiteRequests: ReadWebsiteRequest[] = [];
  readonly websiteFileRequests: WebsiteFileRequest[] = [];
  readonly recordRequests: RecordWebsiteRequest[] = [];
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

  async updateWebsitePolicy(
    request: UpdateAssetSearchPolicyRequest,
    signal: AbortSignal,
  ): Promise<AssetSearchPolicy> {
    if (signal.aborted) throw aborted();
    this.policyUpdates.push(request);
    this.throwNextPermissionError();
    this.policyResult = {
      ...this.policyResult,
      websites: { ...this.policyResult.websites, ...request.websites },
    };
    return structuredClone(this.policyResult);
  }

  async grantWebsite(request: WebsiteGrantRequest, signal: AbortSignal): Promise<WebsiteGrant> {
    if (signal.aborted) throw aborted();
    this.grants.push(request);
    this.throwNextPermissionError();
    return {
      turnId: request.turnId,
      access: request.access,
      site: request.site ?? null,
      grantedAt: 1_700_000_000_000,
      expiresAt: 1_700_000_000_000 + 6 * 60 * 60_000,
    };
  }

  async revokeWebsiteGrant(turnId: string, signal: AbortSignal): Promise<void> {
    if (signal.aborted) throw aborted();
    this.revokedGrants.push(turnId);
    this.throwNextPermissionError();
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

  async website(request: ReadWebsiteRequest, signal: AbortSignal): Promise<ReadWebsiteResult> {
    if (signal.aborted) throw aborted();
    this.websiteRequests.push(request);
    this.throwNextError();
    const site = sampleWebsiteStyle(request.url);
    const dir = `assets/web/${site.host}`;
    return structuredClone(
      this.websiteResult ?? {
        site,
        screenshots: [
          { name: "viewport.jpg", mimeType: "image/jpeg", data: "AAAA", width: 1440, height: 900 },
          { name: "fullpage.jpg", mimeType: "image/jpeg", data: "BBBB", width: 1440, height: 3000 },
        ],
        ...(request.save && {
          saved: {
            dir,
            files: [`${dir}/viewport.jpg`, `${dir}/fullpage.jpg`, `${dir}/logo.svg`],
            logo: `${dir}/logo.svg`,
            screenshots: [`${dir}/viewport.jpg`, `${dir}/fullpage.jpg`],
            fonts: [
              {
                family: "Brand Display",
                weight: 700,
                style: "normal",
                path: `${dir}/brand-display-700.woff2`,
              },
            ],
          },
        }),
      },
    );
  }

  async websiteFile(request: WebsiteFileRequest, signal: AbortSignal): Promise<WebsiteFileResult> {
    if (signal.aborted) throw aborted();
    this.websiteFileRequests.push(request);
    this.throwNextError();
    const url = new URL(request.url);
    const host = url.hostname.replace(/^www\./, "");
    const name = url.pathname.split("/").filter(Boolean).at(-1) ?? "file";
    const result: WebsiteFileResult =
      request.mode === "save"
        ? {
            url: request.url,
            finalUrl: request.url,
            kind: "animation",
            mimeType: "application/json",
            bytes: 90_000,
            path: `assets/web/${host}/files/${name}`,
          }
        : {
            url: request.url,
            finalUrl: request.url,
            kind: "stylesheet",
            mimeType: "text/css",
            bytes: 12_000,
            text: "/* sample */ .hero { color: #5e6ad2; }",
          };
    return structuredClone(this.websiteFileResult ?? result);
  }

  async recordWebsite(
    request: RecordWebsiteRequest,
    signal: AbortSignal,
  ): Promise<RecordWebsiteResult> {
    if (signal.aborted) throw aborted();
    this.recordRequests.push(request);
    this.throwNextError();
    const host = new URL(request.url).hostname.replace(/^www\./, "");
    const result: RecordWebsiteResult = {
      path: `assets/web/${host}/recordings/page.mp4`,
      finalUrl: request.url,
      width: request.width ?? 1920,
      height: request.height ?? 1080,
      duration: request.seconds,
      bytes: 2_400_000,
      notes: [],
    };
    return structuredClone(this.recordResult ?? result);
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

  private throwNextPermissionError(): void {
    if (!this.nextPermissionError) return;
    const error = this.nextPermissionError;
    this.nextPermissionError = null;
    throw error;
  }
}

function aborted(): ResearchToolError {
  return new ResearchToolError("aborted", "The operation was cancelled.");
}
