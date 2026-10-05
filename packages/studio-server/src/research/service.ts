import { createHash, randomBytes } from "node:crypto";
import { createReadStream, existsSync, mkdirSync, renameSync, rmSync, statSync } from "node:fs";
import { basename, posix } from "node:path";
import {
  normalizeLicense,
  RESEARCH_ASSET_DIR,
  RESEARCH_LIMITS,
  RESEARCH_MEDIA_KINDS,
  WEB_SOURCE_ID,
  WEBSITE_SOURCE_ID,
  type WebsiteFileRequest,
  type WebsiteFileResult,
  type WebsiteGrant,
  type WebsiteGrantRequest,
  type AddTrustedSourceRequest,
  type CancelRequestState,
  type AssetCandidate,
  type AssetProvenance,
  type AssetSearchPolicy,
  type AssetSearchRequest,
  type AssetSearchResult,
  type AssetSourceRef,
  type ExportLicenseCheck,
  type ImportAssetRequest,
  type ImportAssetResult,
  type ImportFetch,
  type InspectUrlRequest,
  type InspectUrlResult,
  type LicenseInfo,
  type ProjectSourcesView,
  type ReadWebsiteRequest,
  type ReadWebsiteResult,
  type RecordWebsiteRequest,
  type RecordWebsiteResult,
  type ResearchMediaKind,
  type ResolveMissingRequest,
  type ResolveMissingResult,
  type SourceSearchReport,
  type StoryError,
  type TrustedSource,
  type UpdateAssetSearchPolicyRequest,
  type UpdateTrustedSourceRequest,
} from "@hyperframes/agent-protocol";
import { serialized } from "../analysis/store.js";
import { MAIN_COMPOSITION } from "../editing/inventory.js";
import { assetKindOf } from "../editing/mediaFacts.js";
import { normalizeCompositionPath } from "../editing/service.js";
import { isInHiddenOrVendorDir, resolveWithinProject, walkDir } from "../helpers/safePath.js";
import { isStoryFailure, type StoryFailure } from "../story/errors.js";
import { readStoredStory } from "../story/graphIo.js";
import type { StoryService } from "../story/service.js";
import type { ResolvedProject, StudioApiAdapter } from "../types.js";
import { CandidateRegistry } from "./candidates.js";
import { ResearchCache, type CacheEntry } from "./cache.js";
import { RequestRegistry, type RequestGuard } from "./requestRegistry.js";
import { ResearchFailure, isResearchFailure } from "./errors.js";
import { planNormalization, systemToolkit, type MediaToolkit } from "./normalize.js";
import { readLedger, writeLedger } from "./provenance.js";
import {
  attributionLine,
  compositionExists,
  exportCheck as buildExportCheck,
  sourcesView,
} from "./sourcesView.js";
import { connectorFor } from "./sources/connectors/index.js";
import { webConnector } from "./sources/connectors/web.js";
import { hostOf } from "./sources/domains.js";
import { extensionFor } from "./sources/mediaTypes.js";
import { inspectPage } from "./sources/pageInspector.js";
import { PolicyFetcher } from "./sources/policyFetch.js";
import { PolicyStore } from "./sources/policyStore.js";
import type {
  AssetConnector,
  ConnectorContext,
  RawCandidate,
  WebSearchBackend,
} from "./sources/types.js";
import { UrlGuard, sourceForHost } from "./sources/urlPolicy.js";
import { DuckDuckGoSearch } from "./sources/webSearch.js";
import { WebsiteReader } from "./website.js";
import { WebsiteFiles } from "./websiteFiles.js";
import { WebsiteGrantStore } from "./websiteGrants.js";

const DEFAULT_LIMIT = 6;
const MAX_BYTES: Record<ResearchMediaKind, number> = {
  video: 600 * 1024 * 1024,
  audio: 120 * 1024 * 1024,
  picture: 60 * 1024 * 1024,
};
const WEB_REF: AssetSourceRef = { id: WEB_SOURCE_ID, name: "Web", trusted: false };

export interface ResearchServiceOptions {
  /** Missing Asset resolution goes through the Story service (`resolve_missing`). */
  story: Pick<StoryService, "edit">;
  /** The global Asset Search policy (default: `$OPENVIDS_RESEARCH_DIR`, else `~/.openvids/research`). */
  store?: PolicyStore;
  /** Every network access (tests inject a fake transport and DNS resolver). */
  fetcher?: PolicyFetcher;
  webSearch?: WebSearchBackend;
  /** ffprobe/ffmpeg/sharp (tests inject fakes). */
  toolkit?: MediaToolkit;
  /** Renders a page for the website style reader (the adapter's CLI child); without it the reader is unsupported. */
  inspectWebsite?: StudioApiAdapter["inspectWebsite"];
  /** Records a page as MP4 for full access (the adapter's CLI child); without it recording is unsupported. */
  recordWebsite?: StudioApiAdapter["recordWebsite"];
  /** The address rules of the website reader (tests inject a DNS resolver). */
  websiteGuard?: UrlGuard;
  now?: () => number;
}

interface Found {
  candidate: RawCandidate;
  source: AssetSourceRef;
  grants: string[];
}

interface Inspected {
  finalUrl: string;
  title: string | null;
  source: AssetSourceRef;
  author: string | null;
  license: LicenseInfo;
  found: Found[];
  notes: string[];
}

const isPresent = (projectDir: string, asset: string): boolean => {
  const abs = resolveWithinProject(projectDir, asset);
  return abs !== null && existsSync(abs) && statSync(abs).isFile();
};

function sha256File(file: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    createReadStream(file)
      .on("data", (chunk) => hash.update(chunk))
      .on("error", reject)
      .on("end", () => resolve(hash.digest("hex")));
  });
}

function slugOf(text: string): string {
  const slug = text
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/\.[a-z0-9]{2,4}$/, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48)
    .replace(/-+$/, "");
  return slug || "asset";
}

/** What a record knew about its media, as a candidate (a repeated import of the same URL needs no page read). */
function candidateOfRecord(record: AssetProvenance, mediaKind: ResearchMediaKind): RawCandidate {
  return {
    mediaKind,
    title: record.title,
    description: "",
    pageUrl: record.pageUrl,
    mediaUrl: record.originalUrl,
    previewUrl: null,
    author: record.author,
    authorUrl: record.authorUrl,
    license: {
      id: record.licenseId,
      name: record.license,
      url: record.licenseUrl,
      confidence: record.licenseConfidence,
      status: record.licenseStatus,
      basis: record.licenseBasis,
    },
    width: null,
    height: null,
    duration: null,
    bytes: record.bytes,
    contentType: record.contentType,
  };
}

function fromStory(failure: StoryFailure): ResearchFailure {
  const { code, message } = failure.error;
  switch (code) {
    case "no_story":
      return new ResearchFailure("no_story", message);
    case "unknown_node":
      return new ResearchFailure("unknown_node", message);
    case "unknown_asset":
      return new ResearchFailure("unknown_asset", message);
    case "locked":
      return new ResearchFailure("locked", message);
    case "conflict":
    case "user_decision":
      return new ResearchFailure("conflict", message);
    default:
      return new ResearchFailure("invalid_request", message);
  }
}

/** Whether trusted mode lets `host` be read: an enabled source's domain, or a host the candidate's source granted. */
function hostAllowed(
  policy: AssetSearchPolicy,
  host: string | null,
  grants: readonly string[],
): boolean {
  if (policy.mode === "any") return true;
  return host !== null && (sourceForHost(policy, host) !== null || grants.includes(host));
}

/**
 * Research, sources and licensing: the Asset Search policy (global), searches across trusted sources and the web,
 * page inspection, imports into the project (deduplicated, normalized for the editor, with provenance), Missing Asset
 * resolution and the project's Sources/Licenses view. Every network access of research happens here, behind the
 * policy ({@link PolicyFetcher}); agents have no network tools of their own.
 */
export class ResearchService {
  private readonly store: PolicyStore;
  private readonly fetcher: PolicyFetcher;
  private readonly webSearch: WebSearchBackend;
  private readonly toolkit: MediaToolkit;
  private readonly now: () => number;
  private readonly registry = new CandidateRegistry();
  private readonly requests: RequestRegistry;
  private readonly websites: WebsiteReader;
  private readonly websiteFiles: WebsiteFiles;
  private readonly grants: WebsiteGrantStore;

  constructor(private readonly options: ResearchServiceOptions) {
    this.store = options.store ?? new PolicyStore();
    this.fetcher = options.fetcher ?? new PolicyFetcher();
    this.webSearch = options.webSearch ?? new DuckDuckGoSearch();
    this.toolkit = options.toolkit ?? systemToolkit;
    this.now = options.now ?? Date.now;
    this.requests = new RequestRegistry(this.now);
    this.grants = new WebsiteGrantStore(this.now);
    this.websites = new WebsiteReader({
      store: this.store,
      guard: options.websiteGuard ?? new UrlGuard(),
      inspect: options.inspectWebsite,
      requests: this.requests,
      grants: this.grants,
      lock: (project, task) => this.lock(project, task),
      now: this.now,
    });
    this.websiteFiles = new WebsiteFiles({
      store: this.store,
      guard: options.websiteGuard ?? new UrlGuard(),
      fetcher: this.fetcher,
      record: options.recordWebsite,
      requests: this.requests,
      grants: this.grants,
      lock: (project, task) => this.lock(project, task),
      now: this.now,
    });
  }

  // ── Policy ────────────────────────────────────────────────────────────────

  policy(): AssetSearchPolicy {
    return this.store.get();
  }

  updatePolicy(request: UpdateAssetSearchPolicyRequest): AssetSearchPolicy {
    if (request.mode !== undefined) this.store.setMode(request.mode);
    if (request.websites !== undefined) this.store.setWebsites(request.websites);
    return this.store.get();
  }

  addSource(request: AddTrustedSourceRequest): AssetSearchPolicy {
    return this.store.addSource(request);
  }

  updateSource(id: string, request: UpdateTrustedSourceRequest): AssetSearchPolicy {
    return this.store.updateSource(id, request);
  }

  removeSource(id: string): AssetSearchPolicy {
    return this.store.removeSource(id);
  }

  restoreSources(): AssetSearchPolicy {
    return this.store.restoreBuiltIns();
  }

  private lock<T>(project: ResolvedProject, task: () => Promise<T>): Promise<T> {
    return serialized(`research\0${project.dir}`, task);
  }

  private context(
    domains: string[],
    scopeHttp: ConnectorContext["http"],
    signal?: AbortSignal,
  ): ConnectorContext {
    return { http: scopeHttp, webSearch: this.webSearch, domains, ...(signal && { signal }) };
  }

  // ── Search ────────────────────────────────────────────────────────────────

  async search(
    project: ResolvedProject,
    request: AssetSearchRequest,
    signal?: AbortSignal,
  ): Promise<AssetSearchResult> {
    const policy = this.store.get();
    const kind = request.mediaKind;
    const limit = Math.min(request.limit ?? DEFAULT_LIMIT, RESEARCH_LIMITS.searchResults);
    const blocked: AssetSearchResult["blocked"] = [];
    const notes: string[] = [];
    const wanted = new Set(
      request.sources ?? [
        ...policy.sources
          .filter((source) => source.enabled && source.kinds.includes(kind))
          .map((source) => source.id),
        ...(policy.mode === "any" ? [WEB_SOURCE_ID] : []),
      ],
    );

    interface Plan {
      ref: AssetSourceRef;
      connector: AssetConnector;
      domains: string[];
      source: TrustedSource | null;
    }
    const plans: Plan[] = [];
    for (const id of wanted) {
      if (id === WEB_SOURCE_ID) {
        if (policy.mode === "trusted") {
          blocked.push({
            source: id,
            reason:
              'Asset Search is in trusted mode: only the enabled trusted sources are searched, not the open web. Switch to "any" mode in the Asset Search settings to search the web.',
          });
        } else plans.push({ ref: WEB_REF, connector: webConnector, domains: [], source: null });
        continue;
      }
      const source = policy.sources.find((entry) => entry.id === id);
      if (!source) {
        blocked.push({
          source: id,
          reason: "There is no such trusted source in the Asset Search settings",
        });
        continue;
      }
      if (!source.enabled) {
        blocked.push({
          source: id,
          reason: `${source.name} is disabled in the Asset Search settings`,
        });
        continue;
      }
      if (!source.kinds.includes(kind)) {
        notes.push(`${source.name} has no ${kind} material; skipped.`);
        continue;
      }
      const connector = connectorFor(source.connector);
      if (!connector) {
        blocked.push({ source: id, reason: `${source.name} has no connector` });
        continue;
      }
      plans.push({
        ref: { id: source.id, name: source.name, trusted: true },
        connector,
        domains: source.domains,
        source,
      });
    }

    const http = this.fetcher.http({ policy, ...(signal && { signal }) });
    const answers = await Promise.all(
      plans.map(async (plan) => {
        try {
          const raw = await plan.connector.search(
            request.query,
            kind,
            limit,
            this.context(plan.domains, http, signal),
          );
          return { plan, raw: raw.slice(0, limit), error: null };
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          return { plan, raw: [], error: isResearchFailure(error) ? error.error.message : message };
        }
      }),
    );

    const seen = new Set<string>();
    const found: Found[] = [];
    const searched: SourceSearchReport[] = [];
    for (const { plan, raw, error } of answers) {
      let kept = 0;
      for (const candidate of raw) {
        const host = hostOf(candidate.mediaUrl);
        if (host === null || seen.has(candidate.mediaUrl)) continue;
        const grants =
          plan.source && plan.source.connector !== "site" && host !== null ? [host] : [];
        if (!hostAllowed(policy, host, grants)) continue;
        seen.add(candidate.mediaUrl);
        found.push({ candidate, source: plan.ref, grants });
        kept += 1;
      }
      searched.push({ source: plan.ref, results: kept, error });
    }

    const annotate = this.inProjectLookup(project);
    const candidates = found.map(({ candidate, source, grants }) => {
      const registered = this.registry.register(candidate, source, grants);
      return { ...registered, inProject: annotate(registered) };
    });
    if (
      candidates.length === 0 &&
      plans.length > 0 &&
      answers.every((answer) => answer.error === null)
    ) {
      notes.push("Nothing was found; try other words, another kind of material or more sources.");
    }
    if (policy.mode === "trusted") {
      notes.push(
        `Trusted mode: searched ${plans.length === 0 ? "nothing" : plans.map((plan) => plan.ref.name).join(", ")} only.`,
      );
    }
    return {
      mode: policy.mode,
      query: request.query,
      mediaKind: kind,
      candidates,
      searched,
      blocked,
      notes,
    };
  }

  /** Maps a candidate to the project file that already holds it (same URL, or same downloaded bytes). */
  private inProjectLookup(project: ResolvedProject): (candidate: AssetCandidate) => string | null {
    const records = readLedger(project.dir).records.filter((record) =>
      isPresent(project.dir, record.asset),
    );
    const byUrl = new Map(records.map((record) => [record.originalUrl, record.asset]));
    const bySha = new Map(records.map((record) => [record.originalSha256, record.asset]));
    const cache = new ResearchCache(project.dir);
    return (candidate) => {
      const direct = byUrl.get(candidate.mediaUrl);
      if (direct) return direct;
      const sha = cache.shaForUrl(candidate.mediaUrl);
      return sha ? (bySha.get(sha) ?? null) : null;
    };
  }

  // ── Inspect ───────────────────────────────────────────────────────────────

  async inspect(
    project: ResolvedProject,
    request: InspectUrlRequest,
    signal?: AbortSignal,
  ): Promise<InspectUrlResult> {
    const policy = this.store.get();
    const inspected = await this.inspectUrl(policy, request.url, request.mediaKind, signal);
    const annotate = this.inProjectLookup(project);
    return {
      url: request.url,
      finalUrl: inspected.finalUrl,
      title: inspected.title,
      source: inspected.source,
      author: inspected.author,
      license: inspected.license,
      candidates: inspected.found.map(({ candidate, source, grants }) => {
        const registered = this.registry.register(candidate, source, grants);
        return { ...registered, inProject: annotate(registered) };
      }),
      notes: inspected.notes,
    };
  }

  private async inspectUrl(
    policy: AssetSearchPolicy,
    rawUrl: string,
    kind: ResearchMediaKind | undefined,
    signal: AbortSignal | undefined,
  ): Promise<Inspected> {
    const scope = { policy, ...(signal && { signal }) };
    const url = await this.fetcher.check(rawUrl, scope);
    const vouching = sourceForHost(policy, url.hostname.toLowerCase());
    const http = this.fetcher.http(scope);
    const connector = vouching ? connectorFor(vouching.connector) : null;
    const described = connector?.describeUrl
      ? await connector.describeUrl(url, kind, this.context(vouching?.domains ?? [], http, signal))
      : null;
    const page = described
      ? {
          finalUrl: url.toString(),
          title: described.title,
          author: described.author,
          license: described.license,
          candidates: described.candidates,
          notes: described.notes,
        }
      : await inspectPage(url.toString(), kind, http);
    const refOf = (trusted: TrustedSource | null): AssetSourceRef =>
      trusted ? { id: trusted.id, name: trusted.name, trusted: true } : WEB_REF;
    // A connector answers from its own API, so what it lists carries its source's grants. A scraped page is plain
    // HTML anyone may have written (a wiki user page, an uploaded file, a redirect target): it vouches for nothing,
    // so each file is judged and labelled by its own host, and the page's license is not copied onto files that live
    // elsewhere than the page.
    const pageHost = hostOf(page.finalUrl);
    const pageSource = described
      ? vouching
      : pageHost === null
        ? null
        : sourceForHost(policy, pageHost);
    const source = refOf(pageSource);
    const notes = [...page.notes];
    const found: Found[] = [];
    let outside = 0;
    for (const candidate of page.candidates) {
      const host = hostOf(candidate.mediaUrl);
      const grants =
        described && vouching && vouching.connector !== "site" && host !== null ? [host] : [];
      if (!hostAllowed(policy, host, grants)) {
        outside += 1;
        continue;
      }
      if (described) {
        found.push({ candidate, source, grants });
        continue;
      }
      const own = refOf(host === null ? null : sourceForHost(policy, host));
      found.push({
        candidate:
          host !== pageHost
            ? {
                ...candidate,
                license: normalizeLicense({
                  confidence: "none",
                  basis:
                    "Hosted elsewhere than the page that links it: the page's license is not this file's",
                }),
              }
            : candidate,
        source: own,
        grants,
      });
    }
    if (outside > 0) {
      notes.push(
        `${outside} media file${outside === 1 ? "" : "s"} on this page ${outside === 1 ? "is" : "are"} hosted outside the trusted sources and ${outside === 1 ? "is" : "are"} not offered in trusted mode.`,
      );
    }
    return {
      finalUrl: page.finalUrl,
      title: page.title,
      source,
      author: page.author,
      license: page.license,
      found,
      notes,
    };
  }

  // ── Import ────────────────────────────────────────────────────────────────

  /**
   * Imports a candidate or URL. `client` is the request's abort signal (the caller went away); with
   * `request.requestId` the import can also be cancelled by {@link cancel}. A cancel before the commit discards
   * everything and answers `cancelled`; once the commit started the import finishes and answers normally.
   */
  async import(
    project: ResolvedProject,
    request: ImportAssetRequest,
    client?: AbortSignal,
  ): Promise<ImportAssetResult> {
    if ((request.candidate === undefined) === (request.url === undefined)) {
      throw new ResearchFailure("invalid_request", "Give exactly one of candidate or url");
    }
    const guard = this.requests.begin(project.dir, request.requestId, client);
    try {
      return await guard.race(this.lock(project, () => this.importLocked(project, request, guard)));
    } catch (error) {
      throw guard.normalize(error);
    } finally {
      this.requests.end(guard);
    }
  }

  /** Reads a page the user linked and extracts its visual identity (see `WebsiteReader`). */
  website(
    project: ResolvedProject,
    request: ReadWebsiteRequest,
    client?: AbortSignal,
  ): Promise<ReadWebsiteResult> {
    return this.websites.read(project, request, client);
  }

  /** Full access: downloads a file of a linked site, or returns its text (see `WebsiteFiles`). */
  websiteFile(
    project: ResolvedProject,
    request: WebsiteFileRequest,
    client?: AbortSignal,
  ): Promise<WebsiteFileResult> {
    return this.websiteFiles.file(project, request, client);
  }

  /** Full access: records a page of a linked site as an MP4 (see `WebsiteFiles`). */
  websiteRecord(
    project: ResolvedProject,
    request: RecordWebsiteRequest,
    client?: AbortSignal,
  ): Promise<RecordWebsiteResult> {
    return this.websiteFiles.record(project, request, client);
  }

  /**
   * The user allowed a Websites setting once from the chat ("Allow once"): until the turn's runtime revokes it or it
   * expires, website requests of this project carrying `turnId` pass the setting's check as if it were on (see
   * `WebsiteGrantStore`).
   */
  websiteGrant(project: ResolvedProject, request: WebsiteGrantRequest): WebsiteGrant {
    return this.grants.grant(project.dir, request.turnId, request.access);
  }

  /** Revokes the turn's one-time grant; `true` when there was one. Idempotent (the runtime calls it at turn end). */
  revokeWebsiteGrant(project: ResolvedProject, turnId: string): boolean {
    return this.grants.revoke(project.dir, turnId);
  }

  /** Cancels the import or resolution with this `requestId`; the answer says whether it can still write. */
  cancel(project: ResolvedProject, requestId: string): CancelRequestState {
    return this.requests.cancel(project.dir, requestId);
  }

  private async importLocked(
    project: ResolvedProject,
    request: ImportAssetRequest,
    guard: RequestGuard,
  ): Promise<ImportAssetResult> {
    guard.assertLive();
    const signal = guard.signal;
    if (request.resolveMissing) this.assertResolvable(project, request.resolveMissing);
    const policy = this.store.get();
    const target = await this.importTarget(project, policy, request, signal);
    const { candidate } = target.found;
    const scope = { policy, grants: target.found.grants, ...(signal && { signal }) };
    const expected = candidate.mediaKind;
    const originalUrl = candidate.mediaUrl;
    const ledger = readLedger(project.dir);
    const warnings: string[] = [];
    const finish = async (
      asset: string,
      provenance: AssetProvenance,
      fetch: ImportFetch,
      duplicate: ImportAssetResult["duplicate"],
    ): Promise<ImportAssetResult> => {
      // A resolution writes the story: that is the commit of a duplicate (a new file committed below already).
      if (request.resolveMissing) guard.commit();
      else guard.assertLive();
      const resolution = request.resolveMissing
        ? await this.resolveWith(project, request.resolveMissing, asset, request.turnId)
        : null;
      let record = provenance;
      if (resolution?.resolved) {
        record = await this.recordResolution(
          project,
          provenance,
          resolution.resolved,
          resolution.need,
        );
      }
      return {
        asset,
        provenance: record,
        fetch,
        duplicate,
        resolved: resolution?.resolved ?? null,
        resolveError: resolution?.error ?? null,
        warnings,
      };
    };

    // The same media URL already in the project: nothing to fetch.
    const sameUrl = ledger.records.find(
      (record) => record.originalUrl === originalUrl && isPresent(project.dir, record.asset),
    );
    if (sameUrl) {
      warnings.push(`${sameUrl.asset} already holds this media; nothing was downloaded.`);
      return finish(sameUrl.asset, sameUrl, "none", { asset: sameUrl.asset, reason: "same_url" });
    }

    // Policy first (also for cached bytes: a cache hit must not smuggle in what the policy now forbids).
    await this.fetcher.check(originalUrl, scope);
    const cache = new ResearchCache(project.dir);
    const scratch = cache.scratchDir(`import-${randomBytes(6).toString("hex")}`);
    try {
      let fetch: ImportFetch;
      let entry: CacheEntry;
      const cached = cache.lookup(originalUrl);
      if (cached) {
        fetch = "cache";
        entry = cached.entry;
      } else {
        const downloaded = `${scratch}/download.bin`;
        const result = await this.fetcher.download(originalUrl, scope, downloaded, {
          maxBytes: MAX_BYTES[expected],
          expect: expected,
          signal,
        });
        fetch = "network";
        entry = {
          sha256: result.sha256,
          bytes: result.bytes,
          contentType: result.contentType,
          mediaKind: result.mediaKind,
          extension:
            extensionFor(result.finalUrl, result.contentType) ??
            extensionFor(originalUrl, result.contentType),
          finalUrl: result.finalUrl,
          at: this.now(),
        };
        cache.store(originalUrl, downloaded, entry);
      }

      const sameOriginal = ledger.records.find(
        (record) => record.originalSha256 === entry.sha256 && isPresent(project.dir, record.asset),
      );
      if (sameOriginal) {
        warnings.push(`${sameOriginal.asset} already holds the same file; nothing was added.`);
        return finish(sameOriginal.asset, sameOriginal, fetch, {
          asset: sameOriginal.asset,
          reason: "same_content",
        });
      }

      const original = `${scratch}/original.${entry.extension ?? "bin"}`;
      cache.copyTo(entry, original);
      const inspection = await this.toolkit.inspect(original, signal);
      const plan = planNormalization(inspection, expected, entry.extension);
      let working = original;
      let converted: string | null = null;
      if (plan.action === "convert") {
        working = `${scratch}/converted.${plan.extension}`;
        await this.toolkit.convert(original, working, plan.kind, signal);
        converted = plan.label;
      }
      const sha256 = await sha256File(working);
      const bytes = statSync(working).size;

      const sameFinal = ledger.records.find(
        (record) => record.sha256 === sha256 && isPresent(project.dir, record.asset),
      );
      if (sameFinal) {
        warnings.push(`${sameFinal.asset} already holds the same file; nothing was added.`);
        return finish(sameFinal.asset, sameFinal, fetch, {
          asset: sameFinal.asset,
          reason: "same_content",
        });
      }

      const record = this.recordOf({
        request,
        found: target.found,
        policy,
        asset: "",
        sha256,
        originalSha256: entry.sha256,
        bytes,
        contentType: entry.contentType,
        converted,
      });
      const userFile = await this.findUserFile(project, sha256, bytes);
      if (userFile) {
        warnings.push(
          `The project already has this file as ${userFile} (not imported by Research); nothing was added and no provenance was recorded.`,
        );
        return finish(userFile, { ...record, asset: userFile }, fetch, {
          asset: userFile,
          reason: "same_content",
        });
      }

      guard.assertLive();
      const dir = resolveWithinProject(project.dir, RESEARCH_ASSET_DIR);
      if (!dir)
        throw new ResearchFailure(
          "invalid_request",
          `${RESEARCH_ASSET_DIR} is outside the project`,
        );
      const slug = slugOf(request.name ?? candidate.title ?? basename(originalUrl));
      const asset = posix.join(
        RESEARCH_ASSET_DIR,
        `${slug}-${sha256.slice(0, 8)}.${plan.extension}`,
      );
      const destination = resolveWithinProject(project.dir, asset);
      if (!destination)
        throw new ResearchFailure("invalid_request", `${asset} is outside the project`);
      const present = existsSync(destination) && (await sha256File(destination)) === sha256;
      // The commit: file and record land together, with no await in between; from here a cancel is told
      // `committed` and the import finishes and answers normally.
      guard.commit();
      mkdirSync(dir, { recursive: true });
      if (!present) renameSync(working, destination);

      const written: AssetProvenance = { ...record, asset };
      writeLedger(project.dir, {
        schema: ledger.schema,
        records: [
          ...ledger.records.filter((entry) => entry.id !== written.id && entry.asset !== asset),
          written,
        ],
      });
      return finish(asset, written, fetch, null);
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  }

  /**
   * What an import names: a registered candidate, the media URL of an earlier import (no page read needed: the ledger
   * still knows what it is), or the best media of a URL (a media file itself, or a page).
   */
  private async importTarget(
    project: ResolvedProject,
    policy: AssetSearchPolicy,
    request: ImportAssetRequest,
    signal: AbortSignal | undefined,
  ): Promise<{ found: Found }> {
    if (request.candidate !== undefined) {
      const stored = this.registry.get(request.candidate);
      if (!stored) {
        throw new ResearchFailure(
          "unknown_candidate",
          `Candidate "${request.candidate}" is not known (candidates last until the Studio server restarts); search again`,
        );
      }
      const { candidate, grants } = stored;
      const { source } = candidate;
      // A grant is only as good as the source that issued it: a source the user disabled since grants nothing.
      const issuer = policy.sources.find((entry) => entry.id === source.id);
      return { found: { candidate, source, grants: issuer?.enabled === true ? grants : [] } };
    }
    const url = request.url ?? "";
    // Website references (screenshots, logos, fonts of a page) are not importable media: the URL names a page.
    const known = readLedger(project.dir).records.find(
      (record) => record.originalUrl === url && record.source.id !== WEBSITE_SOURCE_ID,
    );
    const knownKind = RESEARCH_MEDIA_KINDS.find((kind) => kind === known?.mediaKind);
    if (known && knownKind) {
      const issuer = policy.sources.find((entry) => entry.id === known.source.id);
      const host = hostOf(url);
      return {
        found: {
          candidate: candidateOfRecord(known, knownKind),
          source: known.source,
          grants:
            issuer?.enabled === true && issuer.connector !== "site" && host !== null ? [host] : [],
        },
      };
    }
    const inspected = await this.inspectUrl(policy, url, undefined, signal);
    const best = inspected.found[0];
    if (!best) {
      throw new ResearchFailure(
        "not_media",
        `${inspected.finalUrl} offers no media file to import${inspected.notes.length > 0 ? ` (${inspected.notes.join(" ")})` : ""}`,
      );
    }
    return { found: best };
  }

  private recordOf(input: {
    request: ImportAssetRequest;
    found: Found;
    policy: AssetSearchPolicy;
    asset: string;
    sha256: string;
    originalSha256: string;
    bytes: number;
    contentType: string;
    converted: string | null;
  }): AssetProvenance {
    const { candidate, source } = input.found;
    const title = candidate.title.trim().slice(0, 200) || "Untitled";
    return {
      id: `prov-${createHash("sha256").update(`${input.sha256}\0${candidate.mediaUrl}`).digest("hex").slice(0, 12)}`,
      asset: input.asset,
      mediaKind: candidate.mediaKind,
      title,
      originalUrl: candidate.mediaUrl,
      pageUrl: candidate.pageUrl,
      source,
      author: candidate.author,
      authorUrl: candidate.authorUrl,
      license: candidate.license.name,
      licenseId: candidate.license.id,
      licenseUrl: candidate.license.url,
      licenseConfidence: candidate.license.confidence,
      licenseStatus: candidate.license.status,
      licenseBasis: candidate.license.basis,
      attribution: attributionLine({
        title,
        author: candidate.author,
        license: candidate.license.id === "unknown" ? "license unknown" : candidate.license.name,
        sourceName: source.name,
      }),
      retrievedAt: this.now(),
      retrievedBy: {
        agent: input.request.agent ?? "user",
        turnId: input.request.turnId ?? null,
        model: input.request.model ?? null,
      },
      policyMode: input.policy.mode,
      sha256: input.sha256,
      originalSha256: input.originalSha256,
      bytes: input.bytes,
      contentType: input.contentType,
      converted: input.converted,
      storyNode: null,
      need: null,
    };
  }

  /** A project media file (not one Research wrote) with exactly these bytes. */
  private async findUserFile(
    project: ResolvedProject,
    sha256: string,
    bytes: number,
  ): Promise<string | null> {
    for (const file of walkDir(project.dir)) {
      if (isInHiddenOrVendorDir(file) || file.startsWith("renders/")) continue;
      const kind = assetKindOf(file);
      if (kind !== "video" && kind !== "audio" && kind !== "image") continue;
      const abs = resolveWithinProject(project.dir, file);
      if (!abs || statSync(abs).size !== bytes) continue;
      if ((await sha256File(abs)) === sha256) return file;
    }
    return null;
  }

  // ── Missing Asset resolution ──────────────────────────────────────────────

  /** `resolve_missing` through the Story service; a refusal is reported, never thrown (the import stands). */
  private async resolveWith(
    project: ResolvedProject,
    missing: string,
    asset: string,
    turnId: string | undefined,
  ): Promise<{
    resolved: { missing: string; node: string } | null;
    error: StoryError | null;
    need: string | null;
  }> {
    const need = this.missingNeed(project, missing);
    try {
      const response = await this.options.story.edit(project, {
        ...(turnId !== undefined && { turnId }),
        operations: [{ op: "resolve_missing", id: missing, asset }],
      });
      const node = response.results[0]?.id;
      if (!node)
        return {
          resolved: null,
          error: { code: "invalid_request", message: "The story made no node" },
          need,
        };
      return { resolved: { missing, node }, error: null, need };
    } catch (error) {
      if (isStoryFailure(error)) return { resolved: null, error: error.error, need };
      throw error;
    }
  }

  /**
   * Refuses an import meant for a Missing Asset node the story would not let it resolve, before anything is
   * downloaded: the node must exist, be a Missing Asset node, and neither it nor a chapter it is attached to may be
   * locked (the story service applies the same rules to `resolve_missing`).
   */
  private assertResolvable(project: ResolvedProject, missing: string): void {
    const graph = readStoredStory(project.dir)?.graph;
    if (!graph) throw new ResearchFailure("no_story", "The project has no story to resolve.");
    const node = graph.nodes.find((entry) => entry.id === missing);
    if (!node || node.kind !== "missing") {
      throw new ResearchFailure(
        "unknown_node",
        `${missing} is not a Missing Asset node of the story (it may be resolved already); nothing was imported.`,
      );
    }
    if (node.locked) {
      throw new ResearchFailure(
        "locked",
        `Missing Asset node "${node.title}" is locked; nothing was imported. Ask the user to unlock it.`,
      );
    }
    const lockedChapter = graph.attachments
      .filter((attachment) => attachment.node === missing)
      .map((attachment) => graph.nodes.find((entry) => entry.id === attachment.chapter))
      .find((chapter) => chapter?.locked);
    if (lockedChapter) {
      throw new ResearchFailure(
        "locked",
        `Missing Asset node "${node.title}" is attached to the locked chapter "${lockedChapter.title}"; nothing was imported. Ask the user to unlock the chapter.`,
      );
    }
  }

  private missingNeed(project: ResolvedProject, missing: string): string | null {
    try {
      const node = readStoredStory(project.dir)?.graph.nodes.find((entry) => entry.id === missing);
      return node?.kind === "missing" ? node.need : null;
    } catch {
      return null;
    }
  }

  /** Notes on the record which Story node the asset resolved and what that node needed. */
  private async recordResolution(
    project: ResolvedProject,
    provenance: AssetProvenance,
    resolved: { missing: string; node: string },
    need: string | null,
  ): Promise<AssetProvenance> {
    const ledger = readLedger(project.dir);
    const current = ledger.records.find((record) => record.id === provenance.id);
    if (!current) return provenance;
    const updated: AssetProvenance = { ...current, storyNode: resolved.node, need };
    writeLedger(project.dir, {
      schema: ledger.schema,
      records: ledger.records.map((record) => (record.id === updated.id ? updated : record)),
    });
    return updated;
  }

  /** Resolves a Missing Asset node; cancellable like {@link import} (`cancelled` only before the story edit starts). */
  async resolve(
    project: ResolvedProject,
    request: ResolveMissingRequest,
    client?: AbortSignal,
  ): Promise<ResolveMissingResult> {
    const guard = this.requests.begin(project.dir, request.requestId, client);
    try {
      return await guard.race(
        this.lock(project, () => this.resolveLocked(project, request, guard)),
      );
    } catch (error) {
      throw guard.normalize(error);
    } finally {
      this.requests.end(guard);
    }
  }

  private async resolveLocked(
    project: ResolvedProject,
    request: ResolveMissingRequest,
    guard: RequestGuard,
  ): Promise<ResolveMissingResult> {
    const need = this.missingNeed(project, request.missing);
    let response;
    // The commit: the story edit is the write.
    guard.commit();
    try {
      response = await this.options.story.edit(project, {
        ...(request.turnId !== undefined && { turnId: request.turnId }),
        operations: [
          {
            op: "resolve_missing",
            id: request.missing,
            asset: request.asset,
            ...(request.title !== undefined && { title: request.title }),
          },
        ],
      });
    } catch (error) {
      throw isStoryFailure(error) ? fromStory(error) : error;
    }
    const node = response.results[0]?.id ?? "";
    const asset = posix.normalize(request.asset.replace(/^\.\//, ""));
    const ledger = readLedger(project.dir);
    const record = ledger.records.find((entry) => entry.asset === asset);
    if (record) {
      writeLedger(project.dir, {
        schema: ledger.schema,
        records: ledger.records.map((entry) =>
          entry.id === record.id ? { ...entry, storyNode: node, need } : entry,
        ),
      });
    }
    return { missing: request.missing, node, asset, view: response.view };
  }

  // ── Sources view and export check ─────────────────────────────────────────

  async sources(project: ResolvedProject): Promise<ProjectSourcesView> {
    return sourcesView(project.dir, readLedger(project.dir).records, this.store.get().mode);
  }

  async exportCheck(project: ResolvedProject, composition?: string): Promise<ExportLicenseCheck> {
    const path = normalizeCompositionPath(composition ?? MAIN_COMPOSITION);
    if (!compositionExists(project.dir, path)) {
      throw new ResearchFailure("unknown_asset", `No composition "${path}" in this project`);
    }
    return buildExportCheck(project.dir, path, readLedger(project.dir).records);
  }
}
