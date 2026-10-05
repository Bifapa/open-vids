// @vitest-environment node
import { describe, expect, it } from "vitest";
import { ResearchFailure } from "../../errors.js";
import { fixtureText } from "../../testSupport.js";
import type { ConnectorContext, ResearchHttp } from "../types.js";
import { metMuseumConnector } from "./metMuseum.js";

const SEARCH = "https://collectionapi.metmuseum.org/public/collection/v1.1/search";
const OBJECT = "https://collectionapi.metmuseum.org/public/collection/v1/objects";

function fixture(name: string): Record<string, unknown> {
  return JSON.parse(fixtureText(name));
}

/** Serves the recorded search answer and objects; `delayMs` lets requests overlap so concurrency is observable. */
function fakeContext(options: {
  search?: unknown;
  objects?: Record<string, unknown>;
  delayMs?: number;
}) {
  const requested: string[] = [];
  const objects = options.objects ?? fixture("met-objects.json");
  let inFlight = 0;
  let maxInFlight = 0;
  const http: ResearchHttp = {
    async getJson(url) {
      requested.push(url);
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      try {
        if (options.delayMs) await new Promise((resolve) => setTimeout(resolve, options.delayMs));
        if (url.startsWith(SEARCH)) return options.search ?? fixture("met-search.json");
        const object = objects[url.slice(`${OBJECT}/`.length)];
        if (object === undefined) throw new ResearchFailure("unavailable", `no object at ${url}`);
        return object;
      } finally {
        inFlight--;
      }
    },
    async getPage() {
      throw new Error("The Met never reads pages");
    },
  };
  const ctx: ConnectorContext = {
    http,
    webSearch: {
      async search() {
        throw new Error("The Met never uses web search");
      },
    },
    domains: ["metmuseum.org"],
    apiKey: null,
  };
  return { ctx, requested, maxInFlight: () => maxInFlight };
}

describe("metMuseumConnector.search", () => {
  it("asks v1.1 for image-bearing hits, checks each object and keeps only public-domain images in ranking order", async () => {
    const { ctx, requested } = fakeContext({});

    const found = await metMuseumConnector.search("sunflowers", "picture", 2, ctx);

    const search = new URL(requested[0] ?? "");
    expect(`${search.origin}${search.pathname}`).toBe(SEARCH);
    expect(Object.fromEntries(search.searchParams)).toEqual({
      q: "sunflowers",
      hasImages: "true",
      limit: "10",
    });
    expect(requested.slice(1)).toContain(`${OBJECT}/436524`);
    expect(found).toHaveLength(2);
    expect(found[0]).toEqual({
      mediaKind: "picture",
      title: "Sunflowers",
      description: "1887, Oil on canvas",
      pageUrl: "https://www.metmuseum.org/art/collection/search/436524",
      mediaUrl: "https://images.metmuseum.org/CRDImages/ep/original/DP-41223-001.jpg",
      previewUrl: "https://images.metmuseum.org/CRDImages/ep/web-large/DP-41223-001.jpg",
      author: "Vincent van Gogh",
      authorUrl: "https://www.wikidata.org/wiki/Q5582",
      license: expect.objectContaining({
        id: "cc0",
        status: "clear",
        confidence: "high",
        basis: "The Met API (isPublicDomain)",
      }),
      width: null,
      height: null,
      duration: null,
      bytes: null,
      contentType: "image/jpeg",
    });
    expect(found[1]?.title).toBe("Fan Design with Cats and Sunflowers");
  });

  it("stops reading objects once enough public-domain images are found", async () => {
    const { ctx, requested } = fakeContext({});

    const found = await metMuseumConnector.search("sunflowers", "picture", 1, ctx);

    expect(found).toHaveLength(1);
    // The first object is already a match: only the objects in flight with it are read.
    expect(requested).toHaveLength(1 + 4);
  });

  it("never reads more than four objects at a time", async () => {
    const { ctx, maxInFlight } = fakeContext({ delayMs: 2 });

    await metMuseumConnector.search("sunflowers", "picture", 10, ctx);

    expect(maxInFlight()).toBe(4);
  });

  it("skips public-domain objects without an image and objects that cannot be read", async () => {
    const objects = fixture("met-objects.json");
    const gogh = objects["436524"];
    objects["436524"] = { ...(typeof gogh === "object" ? gogh : {}), primaryImage: "" };
    delete objects["480725"];
    const { ctx } = fakeContext({ objects });

    const found = await metMuseumConnector.search("sunflowers", "picture", 5, ctx);

    expect(found.map((candidate) => candidate.title)).toEqual([
      "Fan Design with Cats and Sunflowers",
    ]);
  });

  it("answers an empty list for a search without hits", async () => {
    const { ctx, requested } = fakeContext({ search: { total: 0, objectIDs: null } });

    expect(await metMuseumConnector.search("zzzqqxx", "picture", 3, ctx)).toEqual([]);
    expect(requested).toHaveLength(1);
  });

  it("fails with provider_error when the search answer is not an id list", async () => {
    const { ctx } = fakeContext({ search: { message: "retired" } });

    await expect(metMuseumConnector.search("cat", "picture", 3, ctx)).rejects.toMatchObject({
      error: { code: "provider_error" },
    });
  });

  it("offers pictures only, without touching the network", async () => {
    const { ctx, requested } = fakeContext({});

    expect(await metMuseumConnector.search("cat", "video", 3, ctx)).toEqual([]);
    expect(await metMuseumConnector.search("cat", "audio", 3, ctx)).toEqual([]);
    expect(requested).toEqual([]);
  });
});
