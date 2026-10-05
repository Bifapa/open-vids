// @vitest-environment node
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ResearchFailure, isResearchFailure } from "../../errors.js";
import type { ConnectorContext, ResearchHttp } from "../types.js";
import { smkConnector } from "./smk.js";

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
      throw new Error("the SMK connector must not read pages");
    },
  };
  return {
    ctx: { http, webSearch: { search: async () => [] }, domains: ["smk.dk"], apiKey: null },
    requested,
  };
}

/** The recorded answer with `change` applied to its first work. */
function withFirstItem(change: Record<string, unknown>): unknown {
  const doc = fixture("smk-search.json");
  if (typeof doc !== "object" || doc === null || !("items" in doc) || !Array.isArray(doc.items)) {
    throw new Error("unexpected fixture");
  }
  return { ...doc, items: [{ ...doc.items[0], ...change }] };
}

describe("smkConnector.search", () => {
  it("asks for public-domain works with an image, with the text exactly as typed", async () => {
    const { ctx, requested } = fakeContext(fixture("smk-search.json"));
    const query = "rock & roll/äö?x=1#y";
    await smkConnector.search(query, "picture", 7, ctx);
    const url = requested[0];
    expect(url?.origin + url?.pathname).toBe("https://api.smk.dk/api/v1/art/search/");
    expect(url?.searchParams.get("keys")).toBe(query);
    expect(url?.searchParams.getAll("x")).toEqual([]);
    expect(url?.searchParams.get("filters")).toBe("[has_image:true],[public_domain:true]");
    expect(url?.searchParams.get("rows")).toBe("7");
    expect(url?.searchParams.get("offset")).toBe("0");
    // The artists' biographies in `production` would multiply the answer several times.
    expect(url?.searchParams.get("fields")).not.toContain("production");
  });

  it("has only pictures: other kinds answer without a request", async () => {
    const { ctx, requested } = fakeContext(fixture("smk-search.json"));
    expect(await smkConnector.search("ship", "video", 5, ctx)).toEqual([]);
    expect(await smkConnector.search("ship", "audio", 5, ctx)).toEqual([]);
    expect(requested).toHaveLength(0);
  });

  it("offers a bounded IIIF JPEG rendering with the Public Domain Mark", async () => {
    const { ctx } = fakeContext(fixture("smk-search.json"));
    const [first] = await smkConnector.search("flower", "picture", 5, ctx);
    expect(first).toMatchObject({
      mediaKind: "picture",
      title: "Flower Piece",
      author: "Franz Werner Tamm",
      pageUrl: "https://open.smk.dk/artwork/image/KMS1029",
      // 1692 x 2353 original, long side capped at 2000 px.
      mediaUrl:
        "https://iip.smk.dk/iiif/jp2/pr76f7348_KMS1029_crop.tif.jp2/full/!2000,2000/0/default.jpg",
      width: 1438,
      height: 2000,
      contentType: "image/jpeg",
      license: {
        id: "pdm",
        status: "clear",
        confidence: "high",
        url: "https://creativecommons.org/publicdomain/mark/1.0/",
        basis: "SMK API (rights)",
      },
    });
    expect(first?.previewUrl).toMatch(/^https:\/\/iip-thumb\.smk\.dk\/.+\/default\.jpg$/);
  });

  it("never asks the image server for more pixels than the scan has", async () => {
    const { ctx } = fakeContext(withFirstItem({ image_width: 800, image_height: 600 }));
    const [small] = await smkConnector.search("flower", "picture", 5, ctx);
    expect(small?.mediaUrl).toMatch(/\/full\/!800,800\/0\/default\.jpg$/);
    expect([small?.width, small?.height]).toEqual([800, 600]);
  });

  it("falls back to the stored JPEG of a work without IIIF, and to the first title", async () => {
    const { ctx } = fakeContext(fixture("smk-search.json"));
    const results = await smkConnector.search("flower", "picture", 5, ctx);
    const stored = results.find((r) => r.pageUrl?.endsWith("/KMS626"));
    expect(stored).toMatchObject({
      mediaUrl: "https://api.smk.dk/api/v1/thumbnail/0af32a42-f986-487d-b659-02b241e79af2.jpg",
      width: 1213,
      height: 1600,
    });
    const danish = results.find((r) => r.pageUrl?.endsWith("/KKS411"));
    expect(danish?.title).toBe("Tre Russiske linieskibe.");
  });

  it("drops works that are not public domain, lack a rights URL or an image, or only have a TIFF", async () => {
    for (const change of [
      { public_domain: false },
      { rights: null },
      { has_image: false },
      { image_iiif_id: null, image_native: "https://api.smk.dk/api/v1/download/abc/KMS1.tif" },
      { object_number: null },
    ]) {
      const { ctx } = fakeContext(withFirstItem(change));
      expect(await smkConnector.search("flower", "picture", 5, ctx)).toEqual([]);
    }
  });

  it("returns at most the requested number of results, in source order", async () => {
    const { ctx } = fakeContext(fixture("smk-search.json"));
    const two = await smkConnector.search("flower", "picture", 2, ctx);
    expect(two.map((r) => r.pageUrl?.split("/").pop())).toEqual(["KMS1029", "KMS626"]);
  });

  it("treats an unexpected document as a provider error and passes transport failures on", async () => {
    const odd = fakeContext({ error: "nope" });
    await expect(smkConnector.search("a", "picture", 3, odd.ctx)).rejects.toSatisfy(
      (error) => isResearchFailure(error) && error.error.code === "provider_error",
    );
    const down = fakeContext(new ResearchFailure("rate_limited", "slow down"));
    await expect(smkConnector.search("a", "picture", 3, down.ctx)).rejects.toSatisfy(
      (error) => isResearchFailure(error) && error.error.code === "rate_limited",
    );
  });
});
