// @vitest-environment node
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { DuckDuckGoSearch, type WebSearchResponse } from "./webSearch.js";

function html(name: string): string {
  return readFileSync(fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url)), "utf8");
}

function transportAnswering(status: number, body: string) {
  const calls: Array<{ url: string; headers: Record<string, string>; signal?: AbortSignal }> = [];
  const transport = async (
    url: string,
    init: { headers: Record<string, string>; signal?: AbortSignal },
  ): Promise<WebSearchResponse> => {
    calls.push({ url, ...init });
    return { status, text: async () => body };
  };
  return { transport, calls };
}

describe("DuckDuckGoSearch", () => {
  it("asks the HTML endpoint with a browser-like user agent and the encoded query", async () => {
    const { transport, calls } = transportAnswering(200, html("ddg-results.html"));
    const controller = new AbortController();

    await new DuckDuckGoSearch(transport).search(
      "site:nasa.gov apollo & moon",
      5,
      controller.signal,
    );

    expect(calls).toHaveLength(1);
    const url = new URL(calls[0]?.url ?? "");
    expect(url.origin + url.pathname).toBe("https://html.duckduckgo.com/html/");
    expect(url.searchParams.get("q")).toBe("site:nasa.gov apollo & moon");
    expect(calls[0]?.headers["User-Agent"]).toMatch(/^Mozilla\/5\.0 .*Chrome\//);
    expect(calls[0]?.signal).toBe(controller.signal);
  });

  it("unwraps redirect links, keeps direct ones, drops ads, non-http(s) and duplicates", async () => {
    const { transport } = transportAnswering(200, html("ddg-results.html"));

    const hits = await new DuckDuckGoSearch(transport).search("apollo", 10);

    expect(hits).toEqual([
      {
        url: "https://images.nasa.gov/details/AS11-40-5903",
        title: "Apollo 11 – Buzz Aldrin | NASA",
        snippet: "Astronaut Buzz Aldrin on the lunar surface.",
      },
      {
        url: "https://www.nasa.gov/mission/apollo-11/",
        title: "Apollo 11 mission",
        snippet: "Direct link, no redirect.",
      },
      {
        url: "https://commons.wikimedia.org/wiki/File:Apollo_11.jpg",
        title: "Apollo 11.jpg - Wikimedia Commons",
        snippet: "A photograph.",
      },
    ]);
  });

  it("returns at most `limit` hits, in page order", async () => {
    const { transport } = transportAnswering(200, html("ddg-results.html"));
    const hits = await new DuckDuckGoSearch(transport).search("apollo", 2);
    expect(hits.map((hit) => hit.url)).toEqual([
      "https://images.nasa.gov/details/AS11-40-5903",
      "https://www.nasa.gov/mission/apollo-11/",
    ]);
  });

  it("returns no hits for a page without results", async () => {
    const { transport } = transportAnswering(
      200,
      "<html><body><div class='no-results'>No results.</div></body></html>",
    );
    expect(await new DuckDuckGoSearch(transport).search("zzzz", 5)).toEqual([]);
  });

  it("explains a human-check page (DuckDuckGo answers 202 for it) as a provider error", async () => {
    const { transport } = transportAnswering(202, html("ddg-anomaly.html"));
    await expect(new DuckDuckGoSearch(transport).search("apollo", 5)).rejects.toMatchObject({
      error: { code: "provider_error", message: expect.stringContaining("human check") },
    });
    // The same page with a 200 status is still a challenge, not an empty result list.
    const ok = transportAnswering(200, html("ddg-anomaly.html"));
    await expect(new DuckDuckGoSearch(ok.transport).search("apollo", 5)).rejects.toMatchObject({
      error: { code: "provider_error" },
    });
  });

  it("maps a non-200 answer to provider_error and a transport failure to network", async () => {
    const { transport } = transportAnswering(503, "busy");
    await expect(new DuckDuckGoSearch(transport).search("apollo", 5)).rejects.toMatchObject({
      error: { code: "provider_error", message: expect.stringContaining("503") },
    });
    const failing = async (): Promise<WebSearchResponse> => {
      throw new Error("getaddrinfo ENOTFOUND");
    };
    await expect(new DuckDuckGoSearch(failing).search("apollo", 5)).rejects.toMatchObject({
      error: { code: "network" },
    });
  });
});
