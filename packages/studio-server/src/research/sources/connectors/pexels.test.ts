// @vitest-environment node
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { isResearchFailure, ResearchFailure } from "../../errors.js";
import type { ConnectorContext, ResearchHttp } from "../types.js";
import { pexelsConnector } from "./pexels.js";

const KEY = "pexels-secret-key-0123456789";

function fixture(name: string): unknown {
  return JSON.parse(
    readFileSync(fileURLToPath(new URL(`../fixtures/${name}`, import.meta.url)), "utf8"),
  );
}

interface Request {
  url: URL;
  headers: Record<string, string>;
}

/** An offline `ResearchHttp` that answers every API call with one recorded document and remembers the requests. */
function fakeContext(
  answer: unknown,
  apiKey: string | null = KEY,
): { ctx: ConnectorContext; requested: Request[] } {
  const requested: Request[] = [];
  const http: ResearchHttp = {
    async getJson(url, options) {
      requested.push({ url: new URL(url), headers: options?.headers ?? {} });
      return answer;
    },
    async getPage() {
      throw new Error("the Pexels connector must not read pages");
    },
  };
  return {
    ctx: { http, webSearch: { search: async () => [] }, domains: ["pexels.com"], apiKey },
    requested,
  };
}

describe("pexelsConnector.search", () => {
  it("asks the photo endpoint with the key in the Authorization header only", async () => {
    const { ctx, requested } = fakeContext(fixture("pexels-photos.json"));
    await pexelsConnector.search("rocks & sun", "picture", 3, ctx);
    const request = requested[0];
    expect(request?.url.origin + request?.url.pathname).toBe("https://api.pexels.com/v1/search");
    expect(request?.url.searchParams.get("query")).toBe("rocks & sun");
    expect(request?.url.searchParams.get("per_page")).toBe("3");
    expect(request?.headers).toEqual({ Authorization: KEY });
    expect(request?.url.href).not.toContain(KEY);
  });

  it("asks the video endpoint for videos and never asks for more than 80 per page", async () => {
    const { ctx, requested } = fakeContext(fixture("pexels-videos.json"));
    await pexelsConnector.search("nature", "video", 500, ctx);
    expect(requested[0]?.url.pathname).toBe("/v1/videos/search");
    expect(requested[0]?.url.searchParams.get("per_page")).toBe("80");
  });

  it("has no audio: answers immediately without a request", async () => {
    const { ctx, requested } = fakeContext(fixture("pexels-photos.json"));
    expect(await pexelsConnector.search("rain", "audio", 5, ctx)).toEqual([]);
    expect(requested).toHaveLength(0);
  });

  it("maps photos: the original when it is not huge, the 2x rendering when it is, free_stock license", async () => {
    const { ctx } = fakeContext(fixture("pexels-photos.json"));
    const found = await pexelsConnector.search("rocks", "picture", 10, ctx);
    // The third photo has no `src`: it cannot be imported.
    expect(found).toHaveLength(2);

    expect(found[0]).toEqual({
      mediaKind: "picture",
      title: "Brown Rocks During Golden Hour",
      description: "",
      pageUrl: "https://www.pexels.com/photo/brown-rocks-during-golden-hour-2014422/",
      mediaUrl: "https://images.pexels.com/photos/2014422/pexels-photo-2014422.jpeg",
      previewUrl:
        "https://images.pexels.com/photos/2014422/pexels-photo-2014422.jpeg?auto=compress&cs=tinysrgb&h=350",
      author: "Joey Farina",
      authorUrl: "https://www.pexels.com/@joey",
      license: {
        id: "free_stock",
        name: "Pexels License",
        url: "https://www.pexels.com/license/",
        confidence: "high",
        status: "clear",
        basis: "Pexels API (every Pexels file is under the Pexels License)",
      },
      width: 3024,
      height: 3024,
      duration: null,
      bytes: null,
      contentType: "image/jpeg",
    });

    // 6000 x 4000 is 24 megapixels: the fitted rendering, whose own size the answer does not give.
    expect(found[1]).toMatchObject({
      mediaUrl:
        "https://images.pexels.com/photos/3573351/pexels-photo-3573351.png?auto=compress&cs=tinysrgb&dpr=2&h=650&w=940",
      author: "Lukas Rodriguez",
      width: null,
      height: null,
      contentType: "image/png",
    });
  });

  it("picks the largest hd MP4 within Full HD, never an HLS entry", async () => {
    const { ctx } = fakeContext(fixture("pexels-videos.json"));
    const found = await pexelsConnector.search("nature", "video", 10, ctx);
    expect(found.map((entry) => entry.mediaUrl)).toEqual([
      "https://videos.pexels.com/video-files/1093662/1093662-hd_1920_1080_25fps.mp4",
      // Portrait: the longer side (1920) counts.
      "https://videos.pexels.com/video-files/2499611/2499611-hd_1080_1920_30fps.mp4",
      // Nothing fits Full HD: the smallest file.
      "https://videos.pexels.com/video-files/3571264/3571264-hd_2560_1440_30fps.mp4",
    ]);
    expect(found[0]).toEqual({
      mediaKind: "video",
      title: "Water crashing on rocks",
      description: "",
      pageUrl: "https://www.pexels.com/video/water-crashing-on-rocks-1093662/",
      mediaUrl: "https://videos.pexels.com/video-files/1093662/1093662-hd_1920_1080_25fps.mp4",
      previewUrl:
        "https://images.pexels.com/videos/1093662/free-video-1093662.jpg?auto=compress&cs=tinysrgb&fit=crop&h=630&w=1200",
      author: "Peter Fowler",
      authorUrl: "https://www.pexels.com/@peter-fowler-417939",
      license: expect.objectContaining({ id: "free_stock", status: "clear" }),
      width: 1920,
      height: 1080,
      duration: 8,
      bytes: null,
      contentType: "video/mp4",
    });
  });

  it("handles the id-only page address and a missing contributor name", async () => {
    const { ctx } = fakeContext(fixture("pexels-videos.json"));
    const found = await pexelsConnector.search("nature", "video", 10, ctx);
    expect(found[1]?.title).toBe("Untitled");
    expect(found[1]?.author).toBe("Joey Farina");
    // An empty name leaves no author, and then no author link either.
    expect(found[2]).toMatchObject({ author: null, authorUrl: null, title: "Clouds over hills" });
  });

  it("drops a video that has no MP4 file", async () => {
    const { ctx } = fakeContext(fixture("pexels-videos.json"));
    const found = await pexelsConnector.search("nature", "video", 10, ctx);
    expect(found.some((entry) => entry.pageUrl?.includes("stream-only"))).toBe(false);
  });

  it("returns at most the requested number of results", async () => {
    const { ctx } = fakeContext(fixture("pexels-videos.json"));
    expect(await pexelsConnector.search("nature", "video", 2, ctx)).toHaveLength(2);
  });

  it("never puts the key into a candidate", async () => {
    const photos = await pexelsConnector.search(
      "rocks",
      "picture",
      10,
      fakeContext(fixture("pexels-photos.json")).ctx,
    );
    const videos = await pexelsConnector.search(
      "nature",
      "video",
      10,
      fakeContext(fixture("pexels-videos.json")).ctx,
    );
    expect(JSON.stringify([...photos, ...videos])).not.toContain(KEY);
  });

  it("asks for a key instead of calling the API without one", async () => {
    const { ctx, requested } = fakeContext(fixture("pexels-photos.json"), null);
    const failure = await pexelsConnector
      .search("rocks", "picture", 3, ctx)
      .catch((e: unknown) => e);
    expect(isResearchFailure(failure)).toBe(true);
    expect(isResearchFailure(failure) && failure.error.code).toBe("invalid_request");
    expect(requested).toHaveLength(0);
  });

  it("treats an unexpected document as a provider error that does not mention the key", async () => {
    for (const answer of [{ videos: [] }, [], "nope", null]) {
      const { ctx } = fakeContext(answer);
      const failure = await pexelsConnector
        .search("rocks", "picture", 3, ctx)
        .catch((e: unknown) => e);
      expect(isResearchFailure(failure) && failure.error.code).toBe("provider_error");
      expect(String(isResearchFailure(failure) && failure.message)).not.toContain(KEY);
    }
  });

  it("passes the policy fetcher's failures through", async () => {
    const { ctx } = fakeContext(null);
    const failing: ConnectorContext = {
      ...ctx,
      http: {
        ...ctx.http,
        async getJson() {
          throw new ResearchFailure("rate_limited", "api.pexels.com answered 429");
        },
      },
    };
    const failure = await pexelsConnector
      .search("rocks", "picture", 3, failing)
      .catch((e: unknown) => e);
    expect(isResearchFailure(failure) && failure.error.code).toBe("rate_limited");
  });
});
