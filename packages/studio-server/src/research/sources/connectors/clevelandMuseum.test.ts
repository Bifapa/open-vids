// @vitest-environment node
import { describe, expect, it } from "vitest";
import { fixtureText } from "../../testSupport.js";
import type { ConnectorContext, ResearchHttp } from "../types.js";
import { clevelandMuseumConnector } from "./clevelandMuseum.js";

type Answer = { data: Array<Record<string, unknown>> };

function fixture(): Answer {
  return JSON.parse(fixtureText("cleveland-search.json"));
}

function fakeContext(answer: unknown) {
  const requested: string[] = [];
  const http: ResearchHttp = {
    async getJson(url) {
      requested.push(url);
      return answer;
    },
    async getPage() {
      throw new Error("Cleveland never reads pages");
    },
  };
  const ctx: ConnectorContext = {
    http,
    webSearch: {
      async search() {
        throw new Error("Cleveland never uses web search");
      },
    },
    domains: ["clevelandart.org"],
    apiKey: null,
  };
  return { ctx, requested };
}

describe("clevelandMuseumConnector.search", () => {
  it("asks for CC0 items with images and maps them to the print JPEG with the web rendition as preview", async () => {
    const { ctx, requested } = fakeContext(fixture());

    const found = await clevelandMuseumConnector.search("sunflowers", "picture", 3, ctx);

    const url = new URL(requested[0] ?? "");
    expect(`${url.origin}${url.pathname}`).toBe(
      "https://openaccess-api.clevelandart.org/api/artworks/",
    );
    expect(Object.fromEntries(url.searchParams)).toEqual({
      q: "sunflowers",
      has_image: "1",
      cc0: "1",
      limit: "3",
    });
    expect(found).toHaveLength(3);
    expect(found[0]).toEqual({
      mediaKind: "picture",
      title: "Vase Decorated with Sunflowers",
      description: expect.stringContaining("Rookwood Pottery Company"),
      pageUrl: "https://clevelandart.org/art/1984.10",
      mediaUrl: "https://openaccess-cdn.clevelandart.org/1984.10/1984.10_print.jpg",
      previewUrl: "https://openaccess-cdn.clevelandart.org/1984.10/1984.10_web.jpg",
      author: "John D. Wareham",
      authorUrl: null,
      license: expect.objectContaining({
        id: "cc0",
        status: "clear",
        confidence: "high",
        basis: "Cleveland Museum of Art Open Access API (share_license_status)",
      }),
      width: 2922,
      height: 3400,
      duration: null,
      bytes: 4548088,
      contentType: "image/jpeg",
    });
    expect(found[1]?.author).toBeNull();
  });

  it("falls back to the web rendition when there is no print file", async () => {
    const answer = fixture();
    const [first] = answer.data;
    const images = typeof first?.images === "object" ? first.images : {};
    answer.data = [{ ...first, images: { ...images, print: null } }];
    const { ctx } = fakeContext(answer);

    const [found] = await clevelandMuseumConnector.search("sunflowers", "picture", 1, ctx);

    expect(found?.mediaUrl).toBe("https://openaccess-cdn.clevelandart.org/1984.10/1984.10_web.jpg");
    expect([found?.width, found?.height, found?.bytes]).toEqual([767, 893, 294775]);
  });

  it("skips items that are not CC0 or have no image, and stops at the limit", async () => {
    const answer = fixture();
    const [first, second, third] = answer.data;
    answer.data = [
      { ...first, share_license_status: "Copyrighted" },
      { ...second, images: { annotation: null, web: null, print: null } },
      third,
      third,
    ];
    const { ctx } = fakeContext(answer);

    const found = await clevelandMuseumConnector.search("sunflowers", "picture", 1, ctx);

    expect(found.map((candidate) => candidate.title)).toEqual(["Hollyhock-shaped Cup"]);
  });

  it("fails with provider_error when the answer has no result list", async () => {
    const { ctx } = fakeContext({ detail: [{ msg: "value is not a valid integer" }] });

    await expect(clevelandMuseumConnector.search("x", "picture", 3, ctx)).rejects.toMatchObject({
      error: { code: "provider_error" },
    });
  });

  it("offers pictures only, without touching the network", async () => {
    const { ctx, requested } = fakeContext(fixture());

    expect(await clevelandMuseumConnector.search("x", "audio", 3, ctx)).toEqual([]);
    expect(requested).toEqual([]);
  });
});
