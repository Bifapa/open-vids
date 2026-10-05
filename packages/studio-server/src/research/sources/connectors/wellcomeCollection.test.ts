// @vitest-environment node
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ResearchFailure, isResearchFailure } from "../../errors.js";
import type { ConnectorContext, ResearchHttp } from "../types.js";
import { wellcomeCollectionConnector } from "./wellcomeCollection.js";

function fixture(name: string): unknown {
  return JSON.parse(
    readFileSync(fileURLToPath(new URL(`../fixtures/${name}`, import.meta.url)), "utf8"),
  );
}

function fakeContext(answer: unknown): { ctx: ConnectorContext; requested: URL[] } {
  const requested: URL[] = [];
  const http: ResearchHttp = {
    async getJson(url) {
      requested.push(new URL(url));
      if (answer instanceof Error) throw answer;
      return answer;
    },
    async getPage() {
      throw new Error("the Wellcome connector must not read pages");
    },
  };
  return {
    ctx: {
      http,
      webSearch: { search: async () => [] },
      domains: ["wellcomecollection.org"],
      apiKey: null,
    },
    requested,
  };
}

describe("wellcomeCollectionConnector.search", () => {
  it("filters for reusable licenses in the request and keeps the text exactly as typed", async () => {
    const { ctx, requested } = fakeContext(fixture("wellcome-images.json"));
    const query = "rock & roll/äö?x=1#y";
    await wellcomeCollectionConnector.search(query, "picture", 6, ctx);
    const url = requested[0];
    expect(url?.origin + url?.pathname).toBe(
      "https://api.wellcomecollection.org/catalogue/v2/images",
    );
    expect(url?.searchParams.get("query")).toBe(query);
    expect(url?.searchParams.getAll("x")).toEqual([]);
    expect(url?.searchParams.get("pageSize")).toBe("6");
    expect(url?.searchParams.get("locations.license")).toBe("cc-0,pdm,cc-by,cc-by-sa");
    expect(url?.searchParams.get("include")).toBe("source.contributors");
  });

  it("has only pictures: other kinds answer without a request", async () => {
    const { ctx, requested } = fakeContext(fixture("wellcome-images.json"));
    expect(await wellcomeCollectionConnector.search("ship", "video", 5, ctx)).toEqual([]);
    expect(requested).toHaveLength(0);
  });

  it("maps a work's image to a 2000 px IIIF JPEG with its license and main contributor", async () => {
    const { ctx } = fakeContext(fixture("wellcome-images.json"));
    const results = await wellcomeCollectionConnector.search("ship", "picture", 10, ctx);
    expect(results.map((r) => r.pageUrl)).toEqual([
      "https://wellcomecollection.org/works/cjdm6zdq",
      "https://wellcomecollection.org/works/seeuzmsh",
      "https://wellcomecollection.org/works/rbwnhhug",
    ]);

    const [pdm, ccBy, withAuthor] = results;
    expect(pdm).toMatchObject({
      mediaKind: "picture",
      mediaUrl: "https://iiif.wellcomecollection.org/image/V0024365/full/!2000,2000/0/default.jpg",
      previewUrl: "https://iiif.wellcomecollection.org/image/V0024365/full/!400,400/0/default.jpg",
      contentType: "image/jpeg",
      // No named contributor: the location's credit line is the attribution.
      author: "Wellcome Collection",
      license: { id: "pdm", status: "clear", confidence: "high" },
    });
    expect(ccBy).toMatchObject({
      author: "W. Parrott",
      license: { id: "cc_by", status: "attribution", confidence: "high" },
    });
    expect(withAuthor?.author).toBe("Quiller Lane, R.");
    expect(pdm?.title).toBe(
      "Ship-building: six kinds of ship (top), the hull of a ship of the line (centre and below). Engraving, 1806.",
    );
  });

  it("drops images under non-commercial or in-copyright terms even if the filter let them through", async () => {
    const { ctx } = fakeContext(fixture("wellcome-images.json"));
    const results = await wellcomeCollectionConnector.search("anatomy", "picture", 10, ctx);
    expect(results.some((r) => r.pageUrl?.endsWith("zaqes3gr"))).toBe(false);
    expect(results).toHaveLength(3);
  });

  it("drops images without a IIIF location, a work id or a license", async () => {
    const doc = fixture("wellcome-images.json");
    if (typeof doc !== "object" || doc === null || !("results" in doc)) throw new Error("fixture");
    const [good] = Array.isArray(doc.results) ? doc.results : [];
    const broken = [
      { ...good, locations: [] },
      { ...good, source: { title: "No id" } },
      { ...good, locations: [{ ...good.locations[0], license: undefined }] },
      { ...good, locations: [{ ...good.locations[0], url: "https://example.com/info.json" }] },
    ];
    const { ctx } = fakeContext({ results: broken });
    expect(await wellcomeCollectionConnector.search("ship", "picture", 10, ctx)).toEqual([]);
  });

  it("returns at most the requested number of results", async () => {
    const { ctx } = fakeContext(fixture("wellcome-images.json"));
    expect(await wellcomeCollectionConnector.search("ship", "picture", 1, ctx)).toHaveLength(1);
  });

  it("treats an unexpected document as a provider error and passes transport failures on", async () => {
    const odd = fakeContext({ error: "nope" });
    await expect(wellcomeCollectionConnector.search("a", "picture", 3, odd.ctx)).rejects.toSatisfy(
      (error) => isResearchFailure(error) && error.error.code === "provider_error",
    );
    const down = fakeContext(new ResearchFailure("network", "offline"));
    await expect(wellcomeCollectionConnector.search("a", "picture", 3, down.ctx)).rejects.toSatisfy(
      (error) => isResearchFailure(error) && error.error.code === "network",
    );
  });
});
