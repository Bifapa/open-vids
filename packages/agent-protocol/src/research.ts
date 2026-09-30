/**
 * Research, sources and licensing (Milestone 7): the OpenVids-owned contract for finding missing material outside the
 * project, importing it, and keeping its provenance.
 *
 * - The **Asset Search policy** is global (per user, shared by every project; the Studio server keeps it in
 *   `~/.openvids/research/policy.json`): `trusted` — search and download only from the enabled trusted sources;
 *   `any` — any public web page, with the trusted sources searched first. The policy is enforced by the Studio
 *   server, which performs every search, page read and download (agents have no network access of their own).
 * - A **source** is data, not code: a connector (how to search it) plus the domains its pages and media live on.
 *   Built-in sources use built-in connectors (public APIs); a user-added source is a website (connector `site`):
 *   searched through the web search backend restricted to its domains and read by page inspection.
 * - Every imported asset gets an {@link AssetProvenance} record in `.hyperframes/research/provenance.json`
 *   (history-tracked: reverting the turn that imported an asset removes the file and its record together). The
 *   download cache (`.hyperframes/research/cache/`) sits outside history, so a repeated import never downloads the
 *   same asset twice.
 * - License facts are never taken from a model: they come from the source's API or the page, normalized by
 *   {@link normalizeLicense}; the confidence says how they were found.
 */

import type { AgentId } from "./types.js";
import type { MissingMediaKind, StoryError, StoryView } from "./story.js";
import { isRecord } from "./validate.js";

// ── Policy ───────────────────────────────────────────────────────────────────

export const ASSET_SEARCH_MODES = ["trusted", "any"] as const;
/** `trusted`: only enabled trusted sources. `any`: any public web page (trusted sources are searched first). */
export type AssetSearchMode = (typeof ASSET_SEARCH_MODES)[number];

export const RESEARCH_MEDIA_KINDS = ["video", "picture", "audio"] as const;
export type ResearchMediaKind = (typeof RESEARCH_MEDIA_KINDS)[number];

/**
 * How a source is searched. Built-in connectors speak a public API; `site` is a website searched through the web
 * search backend (`site:` restricted to the source's domains) and read by page inspection.
 */
export const SOURCE_CONNECTORS = [
  "wikimedia_commons",
  "openverse",
  "nasa_images",
  "internet_archive",
  "site",
] as const;
export type SourceConnector = (typeof SOURCE_CONNECTORS)[number];

export interface TrustedSource {
  /** Built-ins: a fixed slug (`wikimedia-commons`); user sources: `src-<random>`. */
  id: string;
  name: string;
  builtIn: boolean;
  enabled: boolean;
  connector: SourceConnector;
  /**
   * Hosts that belong to the source (suffix match: `wikimedia.org` covers `upload.wikimedia.org`). In trusted mode a
   * page or media URL may be read only when its host (and every redirect hop's) belongs to an enabled source.
   */
  domains: string[];
  kinds: ResearchMediaKind[];
  description: string;
  /** What the source says about licensing, shown to the user. */
  licenseNote: string;
  homepage: string | null;
}

export interface AssetSearchPolicy {
  mode: AssetSearchMode;
  /** Built-in sources (minus the ones the user removed) and the user's own, in display order. */
  sources: TrustedSource[];
  /** Built-in source ids the user removed; they do not come back on an update (only by "Restore built-in sources"). */
  removedBuiltIns: string[];
  updatedAt: number;
}

/** `PUT /api/research/policy`. */
export interface UpdateAssetSearchPolicyRequest {
  mode: AssetSearchMode;
}

/** `POST /api/research/sources` — a user-defined trusted website. */
export interface AddTrustedSourceRequest {
  name: string;
  /** Hosts or URLs; normalized to lower-case hosts without `www.`. */
  domains: string[];
  kinds?: ResearchMediaKind[];
  homepage?: string | null;
  licenseNote?: string;
}

/** `PATCH /api/research/sources/:id` — enable/disable, rename, change domains (domains only for user sources). */
export interface UpdateTrustedSourceRequest {
  enabled?: boolean;
  name?: string;
  domains?: string[];
  kinds?: ResearchMediaKind[];
  licenseNote?: string;
}

// `DELETE /api/research/sources/:id` removes a source (a built-in one is remembered in `removedBuiltIns`);
// `POST /api/research/sources/restore` brings back every removed built-in source (enabled).

export const RESEARCH_LIMITS = {
  sources: 64,
  domainsPerSource: 16,
  nameChars: 80,
  noteChars: 500,
  queryChars: 300,
  urlChars: 2_048,
  searchResults: 20,
  fileNameChars: 80,
} as const;

// ── Licenses ─────────────────────────────────────────────────────────────────

export const LICENSE_IDS = [
  "cc0",
  /** Public Domain Mark. */
  "pdm",
  /** Public domain by the source's own statement (e.g. US government works). */
  "public_domain",
  "cc_by",
  "cc_by_sa",
  "cc_by_nd",
  "cc_by_nc",
  "cc_by_nc_sa",
  "cc_by_nc_nd",
  /** A named license whose terms OpenVids does not classify. */
  "other",
  "unknown",
] as const;
export type LicenseId = (typeof LICENSE_IDS)[number];

/**
 * How the license was found: `high` — a structured license field of the source's API with a license URL;
 * `medium` — a machine-readable declaration on the page (`rel="license"`, JSON-LD) or the source's documented
 * blanket policy; `low` — only a textual mention; `none` — nothing found.
 */
export const LICENSE_CONFIDENCES = ["high", "medium", "low", "none"] as const;
export type LicenseConfidence = (typeof LICENSE_CONFIDENCES)[number];

/**
 * What the user has to look at: `clear` — public domain / CC0 found with at least medium confidence; `attribution` —
 * CC BY / BY-SA: usable with a credit; `restricted` — non-commercial or no-derivatives terms, or an unclassified named
 * license; `unknown` — no license, or only a low-confidence one. `restricted` and `unknown` are warned about on
 * export (never blocked).
 */
export const LICENSE_STATUSES = ["clear", "attribution", "restricted", "unknown"] as const;
export type LicenseStatus = (typeof LICENSE_STATUSES)[number];

export interface LicenseInfo {
  id: LicenseId;
  /** Display name: "CC BY-SA 4.0", "Public domain (NASA)", "Unknown". */
  name: string;
  url: string | null;
  confidence: LicenseConfidence;
  status: LicenseStatus;
  /** Where the license came from: "Wikimedia Commons API (LicenseShortName)", "rel=license link on the page". */
  basis: string;
}

const CC_LICENSES: Array<{ id: LicenseId; path: string; label: string }> = [
  { id: "cc_by_nc_sa", path: "by-nc-sa", label: "CC BY-NC-SA" },
  { id: "cc_by_nc_nd", path: "by-nc-nd", label: "CC BY-NC-ND" },
  { id: "cc_by_nc", path: "by-nc", label: "CC BY-NC" },
  { id: "cc_by_nd", path: "by-nd", label: "CC BY-ND" },
  { id: "cc_by_sa", path: "by-sa", label: "CC BY-SA" },
  { id: "cc_by", path: "by", label: "CC BY" },
];

function ccFromUrl(url: string): { id: LicenseId; name: string } | null {
  const match =
    /creativecommons\.org\/(licenses|publicdomain)\/([a-z-]+)(?:\/(\d+(?:\.\d+)?))?/i.exec(url);
  if (!match) return null;
  const [, family, kind, version] = match;
  const suffix = version ? ` ${version}` : "";
  if (family?.toLowerCase() === "publicdomain") {
    if (kind?.toLowerCase() === "zero") return { id: "cc0", name: `CC0${suffix}` };
    if (kind?.toLowerCase() === "mark") return { id: "pdm", name: `Public Domain Mark${suffix}` };
    return null;
  }
  const found = CC_LICENSES.find((entry) => entry.path === kind?.toLowerCase());
  return found ? { id: found.id, name: `${found.label}${suffix}` } : null;
}

function ccFromName(name: string): { id: LicenseId; name: string } | null {
  const text = name.trim().toLowerCase().replaceAll("_", "-");
  if (/\bcc0\b|cc-zero|creative commons zero/.test(text)) return { id: "cc0", name: "CC0" };
  if (/public domain mark|\bpdm\b/.test(text)) return { id: "pdm", name: "Public Domain Mark" };
  if (/^(pd|public[ -]domain)\b|\bpublic domain\b|^pd-/.test(text))
    return { id: "public_domain", name: "Public domain" };
  const cc = /\bcc[ -]?(by(?:[ -](?:nc|nd|sa))*)(?:[ -](\d+(?:\.\d+)?))?/.exec(text);
  if (!cc) return null;
  const parts = (cc[1] ?? "by").split(/[ -]/);
  const path = ["by", ...["nc", "nd", "sa"].filter((part) => parts.includes(part))]
    .join("-")
    .replace("by-nd-sa", "by-nd");
  const found = CC_LICENSES.find((entry) => entry.path === path);
  if (!found) return null;
  return { id: found.id, name: `${found.label}${cc[2] ? ` ${cc[2]}` : ""}` };
}

/** Whether a license (by id) with a given confidence is clear, needs attribution, is restricted or unknown. */
export function licenseStatusOf(id: LicenseId, confidence: LicenseConfidence): LicenseStatus {
  if (id === "unknown" || confidence === "none" || confidence === "low") return "unknown";
  switch (id) {
    case "cc0":
    case "pdm":
    case "public_domain":
      return "clear";
    case "cc_by":
    case "cc_by_sa":
      return "attribution";
    default:
      return "restricted";
  }
}

/**
 * Normalizes what a source says about a license (a name, a URL, or both) into a {@link LicenseInfo}. A URL on
 * creativecommons.org wins over the name; a name that is not recognized becomes `other` (restricted: the user has to
 * read it); nothing at all is `unknown`.
 */
export function normalizeLicense(input: {
  name?: string | null;
  url?: string | null;
  confidence: LicenseConfidence;
  basis: string;
}): LicenseInfo {
  const url = input.url?.trim() || null;
  const name = input.name?.trim() || null;
  const found = (url ? ccFromUrl(url) : null) ?? (name ? ccFromName(name) : null);
  if (!found && !name && !url) {
    return {
      id: "unknown",
      name: "Unknown",
      url: null,
      confidence: "none",
      status: "unknown",
      basis: input.basis,
    };
  }
  const id: LicenseId = found?.id ?? "other";
  const confidence = input.confidence;
  return {
    id,
    name: found ? (name && id === "public_domain" ? name : found.name) : (name ?? url ?? "Unknown"),
    url,
    confidence,
    status: licenseStatusOf(id, confidence),
    basis: input.basis,
  };
}

// ── Sources of candidates and records ────────────────────────────────────────

/** Which source a candidate or record came from. `id` is a trusted source's id, or `web` for a web result. */
export interface AssetSourceRef {
  id: string;
  name: string;
  /** Whether the source was an enabled trusted source when the asset was found. */
  trusted: boolean;
}

export const WEB_SOURCE_ID = "web";

/** Maps a Missing Asset node's media kind to what Research searches for. */
export function researchKindOf(kind: MissingMediaKind): ResearchMediaKind {
  switch (kind) {
    case "video":
      return "video";
    case "picture":
    case "graphics":
      return "picture";
    case "music":
    case "sfx":
      return "audio";
  }
}

// ── Search ───────────────────────────────────────────────────────────────────

/**
 * A search result. `id` is issued by the Studio server and names the server's own record of the result (its URLs,
 * author and license as the source reported them): importing by candidate id is how a found asset is downloaded
 * with the source's metadata. Candidate ids live as long as the Studio server process.
 */
export interface AssetCandidate {
  id: string;
  mediaKind: ResearchMediaKind;
  title: string;
  description: string;
  source: AssetSourceRef;
  /** The page a person would open to see the asset and its terms. */
  pageUrl: string | null;
  /** The file that would be downloaded. */
  mediaUrl: string;
  previewUrl: string | null;
  author: string | null;
  authorUrl: string | null;
  license: LicenseInfo;
  width: number | null;
  height: number | null;
  /** Seconds (video/audio), when the source says. */
  duration: number | null;
  bytes: number | null;
  contentType: string | null;
  /** Project path when this asset (same URL or same content) is already in the project. */
  inProject: string | null;
}

/** `POST /api/projects/:id/research/search`. */
export interface AssetSearchRequest {
  query: string;
  mediaKind: ResearchMediaKind;
  /** Only these sources (ids; `web` for the web backend). Default: every enabled source for the kind (+ web in `any`). */
  sources?: string[];
  /** Results per source (default 6, at most {@link RESEARCH_LIMITS.searchResults}). */
  limit?: number;
}

export interface SourceSearchReport {
  source: AssetSourceRef;
  results: number;
  /** Why the source returned nothing (network error, provider error); null when it answered. */
  error: string | null;
}

export interface AssetSearchResult {
  mode: AssetSearchMode;
  query: string;
  mediaKind: ResearchMediaKind;
  candidates: AssetCandidate[];
  searched: SourceSearchReport[];
  /** Requested sources the policy did not allow (trusted mode: not an enabled trusted source), with the reason. */
  blocked: Array<{ source: string; reason: string }>;
  notes: string[];
}

/** `POST /api/projects/:id/research/inspect` — read one page (or media URL) and list the media it offers. */
export interface InspectUrlRequest {
  url: string;
  mediaKind?: ResearchMediaKind;
}

export interface InspectUrlResult {
  url: string;
  /** After redirects. */
  finalUrl: string;
  title: string | null;
  source: AssetSourceRef;
  /** Page-level author/license (each candidate carries its own too). */
  author: string | null;
  license: LicenseInfo;
  candidates: AssetCandidate[];
  notes: string[];
}

// ── Import and resolution ────────────────────────────────────────────────────

/**
 * `POST /api/projects/:id/research/import` — download a candidate (or, by URL, a media file or a page's main media)
 * into the project, record its provenance and optionally resolve a Missing Asset node with it. Exactly one of
 * `candidate` / `url`. Written unclaimed, so an agent turn's import is part of its checkpoint.
 */
export interface ImportAssetRequest {
  candidate?: string;
  url?: string;
  /** File name to use (without extension); default from the title. The file goes to `assets/research/`. */
  name?: string;
  /** Missing Asset node to resolve with the imported asset (`resolve_missing`). */
  resolveMissing?: string;
  /** Set by the runtime, never the model. */
  turnId?: string;
  agent?: AgentId | "user";
  model?: string | null;
}

/** How the bytes were obtained: from the network, from the project's download cache, or not at all (duplicate). */
export const IMPORT_FETCHES = ["network", "cache", "none"] as const;
export type ImportFetch = (typeof IMPORT_FETCHES)[number];

export interface ImportAssetResult {
  asset: string;
  provenance: AssetProvenance;
  fetch: ImportFetch;
  /** Set when the project already had this asset; `asset` is then that file and nothing new was written. */
  duplicate: { asset: string; reason: "same_url" | "same_content" } | null;
  /** The Missing Asset node resolved, and the node that replaced it. */
  resolved: { missing: string; node: string } | null;
  /** Why `resolveMissing` failed (the import itself stands). */
  resolveError: StoryError | null;
  warnings: string[];
}

/** `POST /api/projects/:id/research/resolve` — resolve a Missing Asset node with a file already in the project. */
export interface ResolveMissingRequest {
  missing: string;
  asset: string;
  title?: string;
  turnId?: string;
}

export interface ResolveMissingResult {
  missing: string;
  node: string;
  asset: string;
  view: StoryView;
}

// ── Provenance ───────────────────────────────────────────────────────────────

export const PROVENANCE_PATH = ".hyperframes/research/provenance.json";
export const PROVENANCE_SCHEMA = "openvids.provenance/1";
/** Where imported assets are written (project-relative). */
export const RESEARCH_ASSET_DIR = "assets/research";

export interface AssetProvenance {
  /** Stable record id (`prov-<hash>`). */
  id: string;
  /** Project-relative path of the imported file. */
  asset: string;
  mediaKind: ResearchMediaKind;
  title: string;
  /** The media URL the bytes came from (as requested; before redirects). */
  originalUrl: string;
  /** The page describing the asset, when known. */
  pageUrl: string | null;
  source: AssetSourceRef;
  author: string | null;
  authorUrl: string | null;
  /** Display name of the license ("CC BY 4.0", "Unknown"). */
  license: string;
  licenseId: LicenseId;
  licenseUrl: string | null;
  licenseConfidence: LicenseConfidence;
  licenseStatus: LicenseStatus;
  licenseBasis: string;
  /** Suggested credit line ("“Ocean waves” by Jane Doe, CC BY 4.0, via Wikimedia Commons"). */
  attribution: string;
  retrievedAt: number;
  retrievedBy: { agent: AgentId | "user"; turnId: string | null; model: string | null };
  /** The policy mode in force when it was retrieved. */
  policyMode: AssetSearchMode;
  /** sha256 of the project file, and of the downloaded original (they differ when it was converted). */
  sha256: string;
  originalSha256: string;
  bytes: number;
  contentType: string;
  /** How the original was converted for the editor ("VP9/WebM → H.264/MP4"); null when kept as downloaded. */
  converted: string | null;
  /**
   * The Story node that uses the asset because it resolved a Missing Asset node (the Missing Asset node's id is in
   * that node's `resolvedFrom`), and what the Missing Asset node needed.
   */
  storyNode: string | null;
  need: string | null;
}

export interface ProvenanceLedger {
  schema: typeof PROVENANCE_SCHEMA;
  records: AssetProvenance[];
}

/** A provenance record as the project sees it now. */
export interface ProjectSourceEntry extends AssetProvenance {
  /** The file still exists in the project. */
  present: boolean;
  /** Compositions whose timeline uses the asset (directly or through a sub-composition). */
  usedIn: string[];
  /** What the user should look at ("License unknown", "Non-commercial license", "Low confidence"). */
  issues: string[];
}

/** `GET /api/projects/:id/research/sources` — the project's Sources/Licenses view. */
export interface ProjectSourcesView {
  records: ProjectSourceEntry[];
  summary: Record<LicenseStatus, number> & { total: number; missingFiles: number };
  /** Credit lines of the present records that need attribution (or whose license is unknown). */
  credits: string[];
  mode: AssetSearchMode;
}

/**
 * `GET /api/projects/:id/research/export-check?composition=…` — what an export of a composition would ship: the
 * researched assets it uses whose license is unknown or restricted (warned about, never blocking) and the credits it
 * needs. Studio asks before every export; the agent `render_video` tool reports it with the render.
 */
export interface ExportLicenseCheck {
  composition: string;
  assets: ProjectSourceEntry[];
  warnings: ExportLicenseWarning[];
  credits: string[];
}

export interface ExportLicenseWarning {
  asset: string;
  status: LicenseStatus;
  license: string;
  message: string;
}

// ── Errors ───────────────────────────────────────────────────────────────────

export const RESEARCH_ERROR_CODES = [
  "invalid_request",
  /** The Asset Search policy does not allow this source or URL. */
  "blocked_by_policy",
  "unknown_source",
  /** The candidate id is not known (expired with a server restart): search again. */
  "unknown_candidate",
  /** The URL answered 404/410 or the asset was removed. */
  "unavailable",
  /** The URL is not a media file of a supported kind (an HTML page with no media, a stream manifest). */
  "not_media",
  "too_large",
  "unsupported",
  /** Network failure or timeout. */
  "network",
  /** The source's API answered with an error. */
  "provider_error",
  "unknown_node",
  "unknown_asset",
  "locked",
  "conflict",
  "no_story",
] as const;
export type ResearchErrorCode = (typeof RESEARCH_ERROR_CODES)[number];

export interface ResearchError {
  code: ResearchErrorCode;
  message: string;
}

export function isResearchError(value: unknown): value is ResearchError {
  return (
    isRecord(value) &&
    typeof value.message === "string" &&
    RESEARCH_ERROR_CODES.some((code) => code === value.code)
  );
}

// ── Guards (shallow: the Studio server is the producer) ──────────────────────

export function isAssetSearchPolicy(value: unknown): value is AssetSearchPolicy {
  return (
    isRecord(value) &&
    ASSET_SEARCH_MODES.some((mode) => mode === value.mode) &&
    Array.isArray(value.sources)
  );
}

export function isAssetSearchResult(value: unknown): value is AssetSearchResult {
  return (
    isRecord(value) &&
    typeof value.query === "string" &&
    Array.isArray(value.candidates) &&
    Array.isArray(value.searched)
  );
}

export function isInspectUrlResult(value: unknown): value is InspectUrlResult {
  return isRecord(value) && typeof value.finalUrl === "string" && Array.isArray(value.candidates);
}

export function isImportAssetResult(value: unknown): value is ImportAssetResult {
  return isRecord(value) && typeof value.asset === "string" && isRecord(value.provenance);
}

export function isResolveMissingResult(value: unknown): value is ResolveMissingResult {
  return isRecord(value) && typeof value.node === "string" && typeof value.missing === "string";
}

export function isProjectSourcesView(value: unknown): value is ProjectSourcesView {
  return isRecord(value) && Array.isArray(value.records) && isRecord(value.summary);
}

export function isExportLicenseCheck(value: unknown): value is ExportLicenseCheck {
  return isRecord(value) && typeof value.composition === "string" && Array.isArray(value.warnings);
}
