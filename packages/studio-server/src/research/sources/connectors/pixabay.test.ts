// @vitest-environment node
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { isResearchFailure } from "../../errors.js";
import type { ConnectorContext, ResearchHttp } from "../types.js";
import { pixabayConnector } from "./pixabay.js";

const KEY = "12345678-pixabaysecretkey0123456789";

function fixture(name: string): unknown {
  return JSON.parse(
    readFileSync(fileURLToPath(new URL(`../fixtures/${name}`, import.meta.url)), "utf8"),
  );
}

/** An offline `ResearchHttp` that answers every API call with one recorded document and remembers the URLs asked. */
function fakeContext(
  answer: unknown,
  apiKey: string | null = KEY,
): { ctx: ConnectorContext; requested: URL[] } {
  const requested: URL[] = [];
  const http: ResearchHttp = {
    async getJson(url) {
      requested.push(new URL(url));
      return answer;
    },
    async getPage() {
      throw new Error("the Pixabay connector must not read pages");
    },
  };
  return {
    ctx: { http, webSearch: { search: async () => [] }, domains: ["pixabay.com"], apiKey },
    requested,
  };
}

describe("pixabayConnector.search", () => {
  it("asks the image endpoint with the key as a query parameter and safe search on", async () => {
    const { ctx, requested } = fakeContext(fixture("pixabay-images.json"));
    await pixabayConnector.search("yellow flowers & bees", "picture", 5, ctx);
    const request = requested[0];
    expect(request?.origin + request?.pathname).toBe("https://pixabay.com/api/");
    expect(request?.searchParams.get("key")).toBe(KEY);
    expect(request?.searchParams.get("q")).toBe("yellow flowers & bees");
    expect(request?.searchParams.get("per_page")).toBe("5");
    expect(request?.searchParams.get("safesearch")).toBe("true");
  });

  it("asks the video endpoint for videos", async () => {
    const { ctx, requested } = fakeContext(fixture("pixabay-videos.json"));
    await pixabayConnector.search("flowers", "video", 5, ctx);
    expect(requested[0]?.pathname).toBe("/api/videos/");
    expect(requested[0]?.searchParams.get("key")).toBe(KEY);
  });

  it("keeps per_page inside the 3-200 range and the query inside 100 characters", async () => {
    const small = fakeContext(fixture("pixabay-images.json"));
    await pixabayConnector.search("x".repeat(150), "picture", 1, small.ctx);
    expect(small.requested[0]?.searchParams.get("per_page")).toBe("3");
    expect(small.requested[0]?.searchParams.get("q")).toHaveLength(100);

    const big = fakeContext(fixture("pixabay-images.json"));
    await pixabayConnector.search("flowers", "picture", 1000, big.ctx);
    expect(big.requested[0]?.searchParams.get("per_page")).toBe("200");
  });

  it("has no audio: answers immediately without a request", async () => {
    const { ctx, requested } = fakeContext(fixture("pixabay-images.json"));
    expect(await pixabayConnector.search("rain", "audio", 5, ctx)).toEqual([]);
    expect(requested).toHaveLength(0);
  });

  it("maps images: large rendering, scaled size, contributor page, Pixabay Content License", async () => {
    const { ctx } = fakeContext(fixture("pixabay-images.json"));
    const found = await pixabayConnector.search("flowers", "picture", 10, ctx);
    // The third hit has no large image: it cannot be imported.
    expect(found).toHaveLength(2);

    expect(found[0]).toEqual({
      mediaKind: "picture",
      title: "blossom, bloom, flower",
      description: "",
      pageUrl: "https://pixabay.com/photos/blossom-bloom-flower-195893/",
      mediaUrl: "https://pixabay.com/get/g5e1f4a3b2c9d8e7f6a5b_1280.jpg",
      previewUrl: "https://pixabay.com/get/g0d3a2b6f1c7e5d4a9b8c_640.jpg",
      author: "Josch13",
      authorUrl: "https://pixabay.com/users/Josch13-48777/",
      license: {
        id: "free_stock",
        name: "Pixabay Content License",
        url: "https://pixabay.com/service/license-summary/",
        confidence: "high",
        status: "clear",
        basis: "Pixabay API (every Pixabay file is under the Pixabay Content License)",
      },
      // 4000 x 2250 scaled to 1280 px on the longer side.
      width: 1280,
      height: 720,
      duration: null,
      bytes: null,
      contentType: "image/jpeg",
    });

    // A small original is not scaled up; names with spaces are encoded in the contributor's address.
    expect(found[1]).toMatchObject({
      mediaUrl: "https://pixabay.com/get/g9f8e7d6c5b4a39281706_1280.png",
      authorUrl: "https://pixabay.com/users/Star%20Gazer-1234/",
      width: 900,
      height: 600,
      contentType: "image/png",
    });
  });

  it("picks the largest video rendition within Full HD", async () => {
    const { ctx } = fakeContext(fixture("pixabay-videos.json"));
    const found = await pixabayConnector.search("flowers", "video", 10, ctx);
    expect(found.map((entry) => entry.mediaUrl)).toEqual([
      // `large` is Full HD here.
      "https://cdn.pixabay.com/video/2015/08/08/125-135736646_large.mp4",
      // `large` is 4K: `medium` it is.
      "https://cdn.pixabay.com/video/2023/01/02/2001-800000000_medium.mp4",
      // `large` is empty and `medium` is bigger than Full HD.
      "https://cdn.pixabay.com/video/2016/01/01/3002-1_small.mp4",
    ]);
    expect(found[0]).toEqual({
      mediaKind: "video",
      title: "flowers, yellow, blossom",
      description: "",
      pageUrl: "https://pixabay.com/videos/id-125/",
      mediaUrl: "https://cdn.pixabay.com/video/2015/08/08/125-135736646_large.mp4",
      previewUrl: "https://cdn.pixabay.com/video/2015/08/08/125-135736646_large.jpg",
      author: "Coverr-Free-Footage",
      authorUrl: "https://pixabay.com/users/Coverr-Free-Footage-1281706/",
      license: expect.objectContaining({ id: "free_stock", status: "clear" }),
      width: 1920,
      height: 1080,
      duration: 12,
      bytes: 6615235,
      contentType: "video/mp4",
    });
  });

  it("drops a video hit that has no renditions", async () => {
    const { ctx } = fakeContext(fixture("pixabay-videos.json"));
    const found = await pixabayConnector.search("flowers", "video", 10, ctx);
    expect(found.some((entry) => entry.pageUrl?.includes("empty-4003"))).toBe(false);
  });

  it("returns at most the requested number of results, even when it asked Pixabay for the minimum of 3", async () => {
    const { ctx } = fakeContext(fixture("pixabay-videos.json"));
    expect(await pixabayConnector.search("flowers", "video", 2, ctx)).toHaveLength(2);
  });

  it("never puts the key into a candidate", async () => {
    const pictures = await pixabayConnector.search(
      "flowers",
      "picture",
      10,
      fakeContext(fixture("pixabay-images.json")).ctx,
    );
    const videos = await pixabayConnector.search(
      "flowers",
      "video",
      10,
      fakeContext(fixture("pixabay-videos.json")).ctx,
    );
    expect(JSON.stringify([...pictures, ...videos])).not.toContain(KEY);
  });

  it("asks for a key instead of calling the API without one", async () => {
    const { ctx, requested } = fakeContext(fixture("pixabay-images.json"), null);
    const failure = await pixabayConnector
      .search("flowers", "picture", 3, ctx)
      .catch((e: unknown) => e);
    expect(isResearchFailure(failure) && failure.error.code).toBe("invalid_request");
    expect(requested).toHaveLength(0);
  });

  it("treats an unexpected document as a provider error that does not mention the key", async () => {
    for (const answer of [{ photos: [] }, [], "nope", null]) {
      const { ctx } = fakeContext(answer);
      const failure = await pixabayConnector
        .search("flowers", "picture", 3, ctx)
        .catch((e: unknown) => e);
      expect(isResearchFailure(failure) && failure.error.code).toBe("provider_error");
      expect(String(isResearchFailure(failure) && failure.message)).not.toContain(KEY);
    }
  });
});
