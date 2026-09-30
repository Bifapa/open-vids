// @vitest-environment node
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { isResearchFailure } from "../../errors.js";
import type { ConnectorContext, ResearchHttp } from "../types.js";
import { openverseConnector } from "./openverse.js";

function fixture(name: string): unknown {
  return JSON.parse(
    readFileSync(fileURLToPath(new URL(`../fixtures/${name}`, import.meta.url)), "utf8"),
  );
}

/** An offline `ResearchHttp` that answers every API call with one recorded document and remembers the URLs asked. */
function fakeContext(answer: unknown): { ctx: ConnectorContext; requested: URL[] } {
  const requested: URL[] = [];
  const http: ResearchHttp = {
    async getJson(url) {
      requested.push(new URL(url));
      return answer;
    },
    async getPage() {
      throw new Error("the Openverse connector must not read pages");
    },
  };
  return {
    ctx: {
      http,
      webSearch: { search: async () => [] },
      domains: ["api.openverse.org", "openverse.org"],
    },
    requested,
  };
}

describe("openverseConnector.search", () => {
  it("has no video: answers immediately without a request", async () => {
    const { ctx, requested } = fakeContext(fixture("openverse-images.json"));
    expect(await openverseConnector.search("volcano", "video", 5, ctx)).toEqual([]);
    expect(requested).toHaveLength(0);
  });

  it("searches images and audio on their own endpoints, with mature content excluded", async () => {
    const images = fakeContext(fixture("openverse-images.json"));
    await openverseConnector.search("volcano", "picture", 7, images.ctx);
    expect(images.requested[0]?.origin + images.requested[0]?.pathname).toBe(
      "https://api.openverse.org/v1/images/",
    );
    expect(images.requested[0]?.searchParams.get("page_size")).toBe("7");
    expect(images.requested[0]?.searchParams.get("mature")).toBe("false");

    const audio = fakeContext(fixture("openverse-audio.json"));
    await openverseConnector.search("thunder", "audio", 5, audio.ctx);
    expect(audio.requested[0]?.pathname).toBe("/v1/audio/");
  });

  it("keeps user text in the q parameter, exactly as typed", async () => {
    const { ctx, requested } = fakeContext(fixture("openverse-images.json"));
    const query = "rock & roll/äö?x=1#y";
    await openverseConnector.search(query, "picture", 3, ctx);
    expect(requested[0]?.searchParams.get("q")).toBe(query);
    expect(requested[0]?.searchParams.getAll("x")).toEqual([]);
    expect(requested[0]?.hash).toBe("");
  });

  it("never asks for more results per page than an anonymous client may", async () => {
    const { ctx, requested } = fakeContext(fixture("openverse-images.json"));
    await openverseConnector.search("volcano", "picture", 50, ctx);
    expect(requested[0]?.searchParams.get("page_size")).toBe("20");
  });

  it("maps picture fields and license, in source order, dropping results that cannot be imported", async () => {
    const { ctx } = fakeContext(fixture("openverse-images.json"));
    const found = await openverseConnector.search("volcano", "picture", 20, ctx);
    // Dropped: no file URL, a video behind an "image", mature, and a relative URL.
    expect(found.map((c) => c.title)).toEqual([
      "Chaparrastique Volcano Eruption Captured by Satellite",
      "Volcano",
      "Lava in Hawaii, public domain dedication",
      "Old engraving of Vesuvius",
      "Non-commercial shot",
    ]);
    const [first, second, cc0, pdm, nc] = found;
    expect(first).toEqual({
      mediaKind: "picture",
      title: "Chaparrastique Volcano Eruption Captured by Satellite",
      description: "",
      pageUrl: "https://www.flickr.com/photos/24662369@N07/11653609255",
      mediaUrl: "https://live.staticflickr.com/2818/11653609255_5ddd09754a_b.jpg",
      previewUrl: "https://api.openverse.org/v1/images/9b2e4a0c-65e2-4123-9664-76c940c801fa/thumb/",
      author: "NASA Goddard Photo and Video",
      authorUrl: "https://www.flickr.com/photos/24662369@N07",
      license: {
        id: "cc_by",
        name: "CC BY 2.0",
        url: "https://creativecommons.org/licenses/by/2.0/",
        confidence: "high",
        status: "attribution",
        basis: "Openverse API (license field)",
      },
      width: 1024,
      height: 576,
      duration: null,
      bytes: null,
      contentType: "image/jpeg",
    });
    expect(second).toMatchObject({
      description: "A cone rising out of the mist.",
      bytes: 284_117,
      contentType: "image/jpeg",
      license: { id: "cc_by_sa", name: "CC BY-SA 2.0" },
    });
    expect(cc0).toMatchObject({
      author: null,
      authorUrl: null,
      contentType: "image/png",
      width: 2000,
      height: 1500,
      license: { id: "cc0", status: "clear", confidence: "high" },
    });
    expect(pdm?.license).toMatchObject({
      id: "pdm",
      name: "Public Domain Mark 1.0",
      status: "clear",
    });
    expect(nc?.license).toMatchObject({
      id: "cc_by_nc",
      name: "CC BY-NC 3.0",
      status: "restricted",
    });
    expect(nc?.authorUrl).toBe("https://example.org/anna");
  });

  it("converts audio durations from milliseconds and keeps provider file types honest", async () => {
    const { ctx } = fakeContext(fixture("openverse-audio.json"));
    const found = await openverseConnector.search("thunder", "audio", 20, ctx);
    // Dropped: an HLS manifest and a record without a file.
    expect(found.map((c) => c.title)).toEqual([
      "Thunder God",
      "Heart Thunder (C.Rizzo)",
      "Rolling storm field recording",
      "Wave capture",
    ]);
    const [god, heart, storm, wave] = found;
    expect(god).toMatchObject({
      mediaKind: "audio",
      mediaUrl: "https://prod-1.storage.jamendo.com/?trackid=1465419&format=mp32",
      duration: 368,
      contentType: "audio/mpeg",
      width: null,
      height: null,
      author: "Ivan Tregub (BER)",
      authorUrl: "https://www.jamendo.com/artist/501822/Ivan_Tregub",
      pageUrl: "https://www.jamendo.com/track/8bee50",
      license: { id: "cc_by", name: "CC BY 3.0", status: "attribution" },
    });
    expect(heart?.license).toMatchObject({ id: "cc_by_nc_nd", status: "restricted" });
    expect(storm).toMatchObject({ duration: 9.044, contentType: "audio/ogg", bytes: 411_421 });
    expect(wave).toMatchObject({ duration: null, contentType: "audio/wav", bytes: 6_190_364 });
  });

  it("returns at most the requested number of results", async () => {
    const { ctx, requested } = fakeContext(fixture("openverse-images.json"));
    const found = await openverseConnector.search("volcano", "picture", 2, ctx);
    expect(requested[0]?.searchParams.get("page_size")).toBe("2");
    expect(found.map((c) => c.title)).toEqual([
      "Chaparrastique Volcano Eruption Captured by Satellite",
      "Volcano",
    ]);
  });

  it("marks a result without any license information as unknown instead of guessing", async () => {
    const { ctx } = fakeContext({
      results: [
        {
          title: "Bare",
          url: "https://cdn.example.org/bare.jpg",
          foreign_landing_url: "https://example.org/bare",
        },
      ],
    });
    const [bare] = await openverseConnector.search("bare", "picture", 5, ctx);
    expect(bare?.license).toMatchObject({ id: "unknown", confidence: "none", status: "unknown" });
    expect(bare?.author).toBeNull();
  });

  it("treats an unexpected document as a provider error", async () => {
    const { ctx } = fakeContext({ detail: "Invalid input." });
    const failure = await openverseConnector
      .search("x", "picture", 5, ctx)
      .catch((error: unknown) => error);
    expect(isResearchFailure(failure) && failure.error.code).toBe("provider_error");
  });
});
