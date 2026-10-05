// @vitest-environment node
import { describe, expect, it } from "vitest";
import { ResearchFailure } from "../../errors.js";
import { fixtureText } from "../../testSupport.js";
import type { ConnectorContext, ResearchHttp } from "../types.js";
import { artInstituteChicagoConnector } from "./artInstituteChicago.js";

function fixture(): Record<string, unknown> & { data: Array<Record<string, unknown>> } {
  return JSON.parse(fixtureText("aic-search.json"));
}

function fakeContext(answer: unknown) {
  const requested: string[] = [];
  const http: ResearchHttp = {
    async getJson(url) {
      requested.push(url);
      return answer;
    },
    async getPage() {
      throw new Error("AIC never reads pages");
    },
  };
  const ctx: ConnectorContext = {
    http,
    webSearch: {
      async search() {
        throw new Error("AIC never uses web search");
      },
    },
    domains: ["artic.edu"],
    apiKey: null,
  };
  return { ctx, requested };
}

describe("artInstituteChicagoConnector.search", () => {
  it("filters on public domain in the request and maps works to IIIF best-fit JPEGs with the museum's CC0 license", async () => {
    const { ctx, requested } = fakeContext(fixture());

    const found = await artInstituteChicagoConnector.search("sunflowers", "picture", 4, ctx);

    const url = new URL(requested[0] ?? "");
    expect(`${url.origin}${url.pathname}`).toBe("https://api.artic.edu/api/v1/artworks/search");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      q: "sunflowers",
      "query[term][is_public_domain]": "true",
      fields:
        "id,title,image_id,artist_display,date_display,medium_display,is_public_domain,thumbnail",
      limit: "4",
    });
    expect(found).toHaveLength(4);
    expect(found[0]).toEqual({
      mediaKind: "picture",
      title: "Sunflowers, Marché St Germain, Paris",
      description: "1888/93, Etching with foul biting in black ink on ivory Japanese paper",
      pageUrl: "https://www.artic.edu/artworks/20029",
      mediaUrl:
        "https://www.artic.edu/iiif/2/2e9476db-2d28-c197-25d8-9b525d63d5a0/full/!1686,1686/0/default.jpg",
      previewUrl:
        "https://www.artic.edu/iiif/2/2e9476db-2d28-c197-25d8-9b525d63d5a0/full/!200,200/0/default.jpg",
      author: "James McNeill Whistler",
      authorUrl: null,
      license: expect.objectContaining({
        id: "cc0",
        status: "clear",
        confidence: "high",
        basis: "Art Institute of Chicago API (is_public_domain)",
      }),
      // The 2784 × 2250 original is fitted into a 1686 px box (never upscaled).
      width: 1686,
      height: 1363,
      duration: null,
      bytes: null,
      contentType: "image/jpeg",
    });
  });

  it("drops the life dates the museum appends to a one-line artist", async () => {
    const { ctx } = fakeContext(fixture());

    const found = await artInstituteChicagoConnector.search("clytie", "picture", 4, ctx);

    expect(found[3]?.author).toBe("George Frederick Watts");
  });

  it("keeps the image's own size when it is smaller than the box", async () => {
    const answer = fixture();
    const [first] = answer.data;
    answer.data = [{ ...first, thumbnail: { width: 1000, height: 500 } }];
    const { ctx } = fakeContext(answer);

    const [found] = await artInstituteChicagoConnector.search("x", "picture", 1, ctx);

    expect([found?.width, found?.height]).toEqual([1000, 500]);
  });

  it("skips works that are not public domain or have no image, and stops at the limit", async () => {
    const answer = fixture();
    const [first, second, third, fourth] = answer.data;
    answer.data = [
      { ...first, is_public_domain: false },
      { ...second, image_id: null },
      third,
      fourth,
    ];
    const { ctx } = fakeContext(answer);

    const found = await artInstituteChicagoConnector.search("sunflowers", "picture", 1, ctx);

    expect(found.map((candidate) => candidate.title)).toEqual(["Sunflowers"]);
  });

  it("drops hits below the relevance floor: a query without a match gets only filler scored ~5", async () => {
    const answer = fixture();
    // Real scores of "sunflowers" (page 2 of the ranking) and of the nonsense query "zzzqqxx".
    const scores = [52.8, 26.2, 13.1, 5.3, 5.2, 4.7];
    answer.data = scores.map((score, index) => ({ ...answer.data[index % 4], _score: score }));
    const { ctx } = fakeContext(answer);

    const found = await artInstituteChicagoConnector.search("sunflowers", "picture", 6, ctx);
    expect(found).toHaveLength(3);

    answer.data = answer.data.map((item) => ({ ...item, _score: 5.3 }));
    expect(await artInstituteChicagoConnector.search("zzzqqxx", "picture", 6, ctx)).toEqual([]);
  });

  it("fails with provider_error when the answer has no result list or IIIF base", async () => {
    for (const answer of [
      { error: "Not found" },
      { data: [], config: {} },
      { data: [], config: { iiif_url: "http://insecure.example/iiif/2" } },
    ]) {
      const { ctx } = fakeContext(answer);
      await expect(
        artInstituteChicagoConnector.search("x", "picture", 3, ctx),
      ).rejects.toBeInstanceOf(ResearchFailure);
    }
  });

  it("offers pictures only, without touching the network", async () => {
    const { ctx, requested } = fakeContext(fixture());

    expect(await artInstituteChicagoConnector.search("x", "video", 3, ctx)).toEqual([]);
    expect(requested).toEqual([]);
  });
});
