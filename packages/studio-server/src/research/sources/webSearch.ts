import { parseHTML } from "linkedom";
import { ResearchFailure } from "../errors.js";
import { clip } from "./htmlText.js";
import type { WebSearchBackend, WebSearchHit } from "./types.js";

export const DEFAULT_WEB_SEARCH_ENDPOINT = "https://html.duckduckgo.com/html/";

export interface WebSearchResponse {
  status: number;
  text(): Promise<string>;
}

export type WebSearchTransport = (
  url: string,
  init: { headers: Record<string, string>; signal?: AbortSignal },
) => Promise<WebSearchResponse>;

const BROWSER_HEADERS: Record<string, string> = {
  "User-Agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  Accept: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9",
};
const CHALLENGE = /anomaly-modal|Unfortunately, bots use DuckDuckGo too/i;
const MAX_TITLE_CHARS = 200;
const MAX_SNIPPET_CHARS = 400;

const fetchTransport: WebSearchTransport = (url, init) =>
  fetch(url, { headers: init.headers, signal: init.signal, redirect: "follow" });

/** The real destination of a result link: DuckDuckGo's `/l/?uddg=` redirect is unwrapped, `y.js` ads are dropped. */
function destinationOf(href: string): string | null {
  let url: URL;
  try {
    url = new URL(href, DEFAULT_WEB_SEARCH_ENDPOINT);
  } catch {
    return null;
  }
  if (url.hostname === "duckduckgo.com" || url.hostname.endsWith(".duckduckgo.com")) {
    if (url.pathname !== "/l/" && url.pathname !== "/l") return null; // /y.js (ads) and DDG's own pages
    const target = url.searchParams.get("uddg");
    if (!target) return null;
    try {
      url = new URL(target);
    } catch {
      return null;
    }
  }
  return url.protocol === "http:" || url.protocol === "https:" ? url.href : null;
}

/** DuckDuckGo's HTML endpoint as a {@link WebSearchBackend}. */
export class DuckDuckGoSearch implements WebSearchBackend {
  constructor(private readonly transport: WebSearchTransport = fetchTransport) {}

  async search(query: string, limit: number, signal?: AbortSignal): Promise<WebSearchHit[]> {
    const url = `${DEFAULT_WEB_SEARCH_ENDPOINT}?${new URLSearchParams({ q: query }).toString()}`;
    let body: string;
    try {
      const response = await this.transport(url, { headers: BROWSER_HEADERS, signal });
      body = await response.text();
      if (CHALLENGE.test(body)) {
        throw new ResearchFailure(
          "provider_error",
          "DuckDuckGo asked for a human check (too many searches from this machine); try again later",
        );
      }
      if (response.status !== 200) {
        throw new ResearchFailure(
          "provider_error",
          `DuckDuckGo web search answered HTTP ${response.status}`,
        );
      }
    } catch (error) {
      if (error instanceof ResearchFailure) throw error;
      if (signal?.aborted) throw error;
      throw new ResearchFailure(
        "network",
        `DuckDuckGo web search is unreachable: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    const { document } = parseHTML(body);
    const hits: WebSearchHit[] = [];
    const seen = new Set<string>();
    for (const link of document.querySelectorAll("a.result__a")) {
      if (hits.length >= limit) break;
      const container = link.closest(".result");
      if (container?.classList.contains("result--ad")) continue;
      const target = destinationOf(link.getAttribute("href") ?? "");
      if (!target || seen.has(target)) continue;
      seen.add(target);
      hits.push({
        url: target,
        title: clip(link.textContent ?? "", MAX_TITLE_CHARS),
        snippet: clip(
          container?.querySelector(".result__snippet")?.textContent ?? "",
          MAX_SNIPPET_CHARS,
        ),
      });
    }
    return hits;
  }
}
