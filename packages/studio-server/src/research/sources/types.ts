import type {
  AssetCandidate,
  LicenseInfo,
  ResearchMediaKind,
  SourceConnector,
} from "@hyperframes/agent-protocol";

/**
 * What a connector (or the page inspector) found, before the service gives it an id, its source and `inProject`.
 * License and author come from the source's API or page, never from a model.
 */
export type RawCandidate = Omit<AssetCandidate, "id" | "source" | "inProject">;

/** A page read through {@link ResearchHttp.getPage}. */
export type FetchedPage =
  | { kind: "html"; finalUrl: string; html: string }
  | {
      kind: "media";
      finalUrl: string;
      contentType: string;
      bytes: number | null;
      mediaKind: ResearchMediaKind;
    }
  | { kind: "other"; finalUrl: string; contentType: string | null };

/**
 * The only way a connector touches the network. Every request (and every redirect hop) is checked against the
 * Asset Search policy in force (mode, enabled trusted sources, SSRF rules) by the implementation; a refused URL
 * throws `ResearchFailure("blocked_by_policy")`, a 404/410 `unavailable`, other failures `network` /
 * `provider_error`. Bodies are size-bounded.
 */
export interface ResearchHttp {
  /** GET a JSON document (an API answer). Non-JSON answers are `provider_error`. */
  getJson(url: string, options?: { headers?: Record<string, string> }): Promise<unknown>;
  /** GET a page: HTML (up to a size cap, truncated beyond it), or recognize a media file without downloading it. */
  getPage(url: string): Promise<FetchedPage>;
}

export interface WebSearchHit {
  url: string;
  title: string;
  snippet: string;
}

/** The web search backend (DuckDuckGo HTML by default). Infrastructure: allowed in both modes. */
export interface WebSearchBackend {
  search(query: string, limit: number, signal?: AbortSignal): Promise<WebSearchHit[]>;
}

export interface ConnectorContext {
  http: ResearchHttp;
  webSearch: WebSearchBackend;
  /** The source's domains (suffix match); empty for the `web` connector (unrestricted). */
  domains: string[];
  signal?: AbortSignal;
}

/** A page of a connector's own site, described through its API. */
export interface DescribedPage {
  title: string | null;
  author: string | null;
  license: LicenseInfo;
  candidates: RawCandidate[];
  notes: string[];
}

export interface AssetConnector {
  readonly id: SourceConnector | "web";
  /** Search for `kind`, at most `limit` results. Throws `ResearchFailure` on transport/provider errors. */
  search(
    query: string,
    kind: ResearchMediaKind,
    limit: number,
    ctx: ConnectorContext,
  ): Promise<RawCandidate[]>;
  /**
   * Describes a page of the source's own site (a Commons `File:` page, a NASA details page, archive.org/details/<id>)
   * through its API. Null when the URL is not one of those (the service then inspects the page like any other).
   */
  describeUrl?(
    url: URL,
    kind: ResearchMediaKind | undefined,
    ctx: ConnectorContext,
  ): Promise<DescribedPage | null>;
}
