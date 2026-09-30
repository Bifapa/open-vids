import type { ResearchMediaKind } from "@hyperframes/agent-protocol";
import { hostMatchesDomains, hostOf } from "../domains.js";
import { inspectPage } from "../pageInspector.js";
import type { AssetConnector, ConnectorContext, RawCandidate, WebSearchHit } from "../types.js";

const KIND_HINT: Record<ResearchMediaKind, string> = {
  video: "video",
  picture: "photo",
  audio: "audio",
};
const MAX_SITE_TERMS = 4;
const SITE_PAGES = 3;
const HITS_PER_PAGE = 3;

/**
 * Finds media by web search and page inspection. With `domains` the search is restricted to those sites and only
 * media hosted on them is kept (a trusted source must not lead the user off its domains); without, anything goes.
 */
export async function searchThroughWeb(options: {
  query: string;
  kind: ResearchMediaKind;
  limit: number;
  ctx: ConnectorContext;
  domains: readonly string[] | null;
  pages: number;
}): Promise<RawCandidate[]> {
  const { query, kind, limit, ctx, domains, pages } = options;
  if (domains && domains.length === 0) return [];
  const sites = domains
    ? `${domains
        .slice(0, MAX_SITE_TERMS)
        .map((domain) => `site:${domain}`)
        .join(" OR ")} `
    : "";
  const allHits = await ctx.webSearch.search(
    `${sites}${query} ${KIND_HINT[kind]}`,
    pages * HITS_PER_PAGE,
    ctx.signal,
  );
  const hits: WebSearchHit[] = domains
    ? allHits.filter((hit) => {
        const host = hostOf(hit.url);
        return host !== null && hostMatchesDomains(host, domains);
      })
    : allHits;

  const inspected = await Promise.allSettled(
    hits.slice(0, pages).map((hit) => inspectPage(hit.url, kind, ctx.http)),
  );

  const found: RawCandidate[] = [];
  const seen = new Set<string>();
  for (const [index, outcome] of inspected.entries()) {
    if (outcome.status === "rejected") {
      if (ctx.signal?.aborted) throw outcome.reason;
      continue; // a page that cannot be read is skipped, not fatal
    }
    const hit = hits[index];
    for (const candidate of outcome.value.candidates) {
      if (found.length >= limit) return found;
      if (candidate.mediaKind !== kind || seen.has(candidate.mediaUrl)) continue;
      if (domains) {
        const host = hostOf(candidate.mediaUrl);
        if (host === null || !hostMatchesDomains(host, domains)) continue;
      }
      seen.add(candidate.mediaUrl);
      found.push({
        ...candidate,
        title: outcome.value.title ?? (hit?.title.trim() || candidate.title),
      });
    }
  }
  return found;
}

export const siteConnector: AssetConnector = {
  id: "site",
  search(query, kind, limit, ctx) {
    return searchThroughWeb({ query, kind, limit, ctx, domains: ctx.domains, pages: SITE_PAGES });
  },
};
