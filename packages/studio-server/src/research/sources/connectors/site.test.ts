// @vitest-environment node
import { describe, expect, it } from "vitest";
import { ResearchFailure } from "../../errors.js";
import type {
  ConnectorContext,
  FetchedPage,
  ResearchHttp,
  WebSearchBackend,
  WebSearchHit,
} from "../types.js";
import { siteConnector } from "./site.js";
import { webConnector } from "./web.js";

function htmlPage(url: string, html: string): FetchedPage {
  return { kind: "html", finalUrl: url, html };
}

function hit(url: string, title = `Hit ${url}`): WebSearchHit {
  return { url, title, snippet: "" };
}

function fakeContext(options: {
  hits: WebSearchHit[];
  pages: Record<string, FetchedPage>;
  domains: string[];
}) {
  const searches: Array<{ query: string; limit: number }> = [];
  const fetched: string[] = [];
  const webSearch: WebSearchBackend = {
    async search(query, limit) {
      searches.push({ query, limit });
      return options.hits;
    },
  };
  const http: ResearchHttp = {
    async getJson() {
      throw new Error("not used");
    },
    async getPage(url) {
      fetched.push(url);
      const page = options.pages[url];
      if (!page) throw new ResearchFailure("unavailable", `gone: ${url}`);
      return page;
    },
  };
  const ctx: ConnectorContext = { http, webSearch, domains: options.domains };
  return { ctx, searches, fetched };
}

const PHOTO = (src: string, title = "") =>
  `<html><head>${title ? `<title>${title}</title>` : ""}</head><body><img src="${src}" width="800"></body></html>`;

describe("siteConnector", () => {
  it("searches `site:` terms for the source's domains (at most four) with a kind hint", async () => {
    const { ctx, searches } = fakeContext({
      hits: [],
      pages: {},
      domains: ["a.org", "b.org", "c.org", "d.org", "e.org"],
    });

    await siteConnector.search("sunrise", "picture", 5, ctx);
    await siteConnector.search("sunrise", "video", 5, ctx);
    await siteConnector.search("sunrise", "audio", 5, ctx);

    expect(searches.map((s) => s.query)).toEqual([
      "site:a.org OR site:b.org OR site:c.org OR site:d.org sunrise photo",
      "site:a.org OR site:b.org OR site:c.org OR site:d.org sunrise video",
      "site:a.org OR site:b.org OR site:c.org OR site:d.org sunrise audio",
    ]);
  });

  it("keeps only hits on the source's domains, inspects three pages, tolerates a failing one", async () => {
    const { ctx, fetched } = fakeContext({
      domains: ["example.org", "photos.test"],
      hits: [
        hit("https://www.example.org/a", "Hit A"),
        hit("https://evil.com/x"),
        hit("https://example.org.evil.com/y"),
        hit("https://notexample.org/z"),
        hit("https://cdn.example.org/broken"),
        hit("https://photos.test/b", "Hit B"),
        hit("https://example.org/d"),
      ],
      pages: {
        "https://www.example.org/a": htmlPage(
          "https://www.example.org/a",
          PHOTO("https://img.example.org/a.jpg"),
        ),
        "https://photos.test/b": htmlPage("https://photos.test/b", PHOTO("/p/1.jpg", "Photo B")),
        "https://example.org/d": htmlPage("https://example.org/d", PHOTO("/d.jpg")),
      },
    });

    const found = await siteConnector.search("sunrise", "picture", 10, ctx);

    // Three pages are read (the third one, cdn.example.org/broken, fails); example.org/d is never reached.
    expect(fetched).toEqual([
      "https://www.example.org/a",
      "https://cdn.example.org/broken",
      "https://photos.test/b",
    ]);
    expect(found.map((c) => [c.mediaUrl, c.title, c.pageUrl])).toEqual([
      // No <title> on the page: the search hit's title is used.
      ["https://img.example.org/a.jpg", "Hit A", "https://www.example.org/a"],
      ["https://photos.test/p/1.jpg", "Photo B", "https://photos.test/b"],
    ]);
  });

  it("drops media hosted outside the source's domains", async () => {
    const { ctx } = fakeContext({
      domains: ["example.org"],
      hits: [hit("https://example.org/a")],
      pages: {
        "https://example.org/a": htmlPage(
          "https://example.org/a",
          `<html><head><title>T</title></head><body>
            <img src="https://hotlink.other.net/x.jpg" width="800">
            <a href="https://stock.example.com/big.jpg">big</a>
            <a href="/files/local.png">local</a>
          </body></html>`,
        ),
      },
    });

    const found = await siteConnector.search("sunrise", "picture", 10, ctx);

    expect(found.map((c) => c.mediaUrl)).toEqual(["https://example.org/files/local.png"]);
  });

  it("keeps candidates of the requested kind only, at most `limit`", async () => {
    const page = `<html><head><title>Mixed</title></head><body>
      <video src="/v.mp4"></video><audio src="/a.mp3"></audio>
      <a href="/1.jpg">1</a><a href="/2.jpg">2</a><a href="/3.jpg">3</a></body></html>`;
    const { ctx } = fakeContext({
      domains: ["example.org"],
      hits: [hit("https://example.org/m")],
      pages: { "https://example.org/m": htmlPage("https://example.org/m", page) },
    });

    expect((await siteConnector.search("q", "video", 5, ctx)).map((c) => c.mediaUrl)).toEqual([
      "https://example.org/v.mp4",
    ]);
    expect((await siteConnector.search("q", "picture", 2, ctx)).map((c) => c.mediaUrl)).toEqual([
      "https://example.org/1.jpg",
      "https://example.org/2.jpg",
    ]);
  });

  it("adds nothing without hits, or when the source has no domains (no unrestricted search)", async () => {
    const none = fakeContext({ hits: [], pages: {}, domains: ["example.org"] });
    expect(await siteConnector.search("q", "video", 5, none.ctx)).toEqual([]);
    expect(none.fetched).toEqual([]);

    const noDomains = fakeContext({ hits: [hit("https://example.org/a")], pages: {}, domains: [] });
    expect(await siteConnector.search("q", "video", 5, noDomains.ctx)).toEqual([]);
    expect(noDomains.searches).toEqual([]);
  });

  it("lets a web search failure through", async () => {
    const { ctx } = fakeContext({ hits: [], pages: {}, domains: ["example.org"] });
    ctx.webSearch = {
      async search() {
        throw new ResearchFailure("provider_error", "DuckDuckGo asked for a human check");
      },
    };
    await expect(siteConnector.search("q", "video", 5, ctx)).rejects.toMatchObject({
      error: { code: "provider_error" },
    });
  });
});

describe("webConnector", () => {
  it("searches the open web, inspects four pages, keeps media from any host, de-duplicates", async () => {
    const urls = [
      "https://one.test/",
      "https://two.test/",
      "https://three.test/",
      "https://four.test/",
      "https://five.test/",
    ];
    const { ctx, searches, fetched } = fakeContext({
      domains: [],
      hits: urls.map((url) => hit(url)),
      pages: Object.fromEntries(
        urls.map((url, index) => [
          url,
          htmlPage(
            url,
            `<html><head><title>Page ${index + 1}</title></head><body>
              <a href="https://shared.cdn.test/same.mp4">same</a>
              <a href="/own-${index + 1}.mp4">own</a></body></html>`,
          ),
        ]),
      ),
    });

    const found = await webConnector.search("sunrise", "video", 20, ctx);

    expect(searches[0]?.query).toBe("sunrise video");
    expect(fetched).toEqual(urls.slice(0, 4));
    expect(found.map((c) => c.mediaUrl)).toEqual([
      "https://shared.cdn.test/same.mp4",
      "https://one.test/own-1.mp4",
      "https://two.test/own-2.mp4",
      "https://three.test/own-3.mp4",
      "https://four.test/own-4.mp4",
    ]);
    expect(found[0]).toMatchObject({ title: "Page 1", pageUrl: "https://one.test/" });
  });

  it("finds a direct media hit and skips non-media results", async () => {
    const { ctx } = fakeContext({
      domains: [],
      hits: [
        hit("https://files.test/clip.mp4", "Direct clip"),
        hit("https://files.test/data.json"),
      ],
      pages: {
        "https://files.test/clip.mp4": {
          kind: "media",
          finalUrl: "https://files.test/clip.mp4",
          contentType: "video/mp4",
          bytes: 99,
          mediaKind: "video",
        },
        "https://files.test/data.json": {
          kind: "other",
          finalUrl: "https://files.test/data.json",
          contentType: "application/json",
        },
      },
    });

    const found = await webConnector.search("clip", "video", 5, ctx);

    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({
      mediaUrl: "https://files.test/clip.mp4",
      bytes: 99,
      license: { id: "unknown", confidence: "none" },
    });
  });
});
