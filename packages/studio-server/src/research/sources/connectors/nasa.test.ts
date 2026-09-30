// @vitest-environment node
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ResearchFailure } from "../../errors.js";
import type { ConnectorContext, ResearchHttp } from "../types.js";
import { nasaConnector } from "./nasa.js";

function fixture(name: string): unknown {
  return JSON.parse(
    readFileSync(fileURLToPath(new URL(`../fixtures/${name}`, import.meta.url)), "utf8"),
  );
}

function fakeContext(answers: Record<string, unknown>) {
  const requested: string[] = [];
  const http: ResearchHttp = {
    async getJson(url) {
      requested.push(url);
      const answer = answers[url];
      if (answer === undefined) throw new ResearchFailure("unavailable", `no fixture for ${url}`);
      return answer;
    },
    async getPage() {
      throw new Error("NASA never reads pages");
    },
  };
  const ctx: ConnectorContext = {
    http,
    webSearch: {
      async search() {
        throw new Error("NASA never uses web search");
      },
    },
    domains: ["images-api.nasa.gov", "images-assets.nasa.gov", "images.nasa.gov"],
  };
  return { ctx, requested };
}

const ASSETS = "https://images-assets.nasa.gov";
const IMAGE_SEARCH = "https://images-api.nasa.gov/search?q=apollo&media_type=image&page_size=3";

describe("nasaConnector.search", () => {
  it("maps an image item: large rendering over orig, https, dimensions, author, cleaned description, license", async () => {
    const { ctx, requested } = fakeContext({
      [IMAGE_SEARCH]: fixture("nasa-search-image.json"),
      [`${ASSETS}/image/AS11-40-5903/collection.json`]: fixture("nasa-collection-image.json"),
      [`${ASSETS}/image/APOLLO%2050th_FULL%20COLOR_300DPI/collection.json`]: fixture(
        "nasa-collection-image-medium.json",
      ),
    });

    const found = await nasaConnector.search("apollo", "picture", 3, ctx);

    expect(requested[0]).toBe(IMAGE_SEARCH);
    expect(found).toHaveLength(2); // the third item's listing fails and is skipped
    expect(found[0]).toEqual({
      mediaKind: "picture",
      title: "Apollo 11 Buzz Aldrin",
      description: "Astronaut Buzz Aldrin on the lunar surface & the Lunar Module.",
      pageUrl: "https://images.nasa.gov/details/AS11-40-5903",
      mediaUrl: `${ASSETS}/image/AS11-40-5903/AS11-40-5903~large.jpg`,
      previewUrl: `${ASSETS}/image/AS11-40-5903/AS11-40-5903~thumb.jpg`,
      author: "Neil Armstrong",
      authorUrl: null,
      license: expect.objectContaining({
        id: "public_domain",
        name: "Public domain (NASA)",
        confidence: "medium",
        status: "clear",
        basis: "NASA Image and Video Library media usage guidelines",
      }),
      width: 1920,
      height: 1194,
      duration: null,
      bytes: 143000,
      contentType: "image/jpeg",
    });
  });

  it("falls back to ~medium when there is no ~large, encodes spaces once, reads description_508", async () => {
    const { ctx } = fakeContext({
      [IMAGE_SEARCH]: fixture("nasa-search-image.json"),
      [`${ASSETS}/image/AS11-40-5903/collection.json`]: fixture("nasa-collection-image.json"),
      [`${ASSETS}/image/APOLLO%2050th_FULL%20COLOR_300DPI/collection.json`]: fixture(
        "nasa-collection-image-medium.json",
      ),
    });

    const found = await nasaConnector.search("apollo", "picture", 3, ctx);

    expect(found[1]?.mediaUrl).toBe(
      `${ASSETS}/image/APOLLO%2050th_FULL%20COLOR_300DPI/APOLLO%2050th_FULL%20COLOR_300DPI~medium.jpg`,
    );
    expect(found[1]?.width).toBe(1280);
    expect(found[1]?.description).toBe(
      "Full color logo for the 50th anniversary of the Apollo program",
    );
    expect(found[1]?.author).toBeNull();
  });

  it("picks the ~medium mp4 for video (never subtitles), and a mobile rendering only when nothing else exists", async () => {
    const url = "https://images-api.nasa.gov/search?q=apollo&media_type=video&page_size=3";
    const { ctx } = fakeContext({
      [url]: fixture("nasa-search-video.json"),
      [`${ASSETS}/video/KSC-1985-Apollo_11/collection.json`]: fixture("nasa-collection-video.json"),
      [`${ASSETS}/video/MOBILE-ONLY/collection.json`]: fixture("nasa-collection-video-mobile.json"),
      [`${ASSETS}/video/SUBS-ONLY/collection.json`]: fixture("nasa-collection-video-subs.json"),
    });

    const found = await nasaConnector.search("apollo", "video", 3, ctx);

    // ~medium.mp4 wins over ~orig.mp4; ~mobile.mp4 is used only when nothing else exists; subtitles never.
    expect(found.map((c) => c.mediaUrl)).toEqual([
      `${ASSETS}/video/KSC-1985-Apollo_11/KSC-1985-Apollo_11~medium.mp4`,
      `${ASSETS}/video/MOBILE-ONLY/MOBILE-ONLY~mobile.mp4`,
    ]);
    expect(found[0]?.author).toBe("Kennedy Space Center");
    expect(found[0]?.contentType).toBe("video/mp4");
    expect(found[0]?.previewUrl).toBe(
      `${ASSETS}/video/KSC-1985-Apollo_11/KSC-1985-Apollo_11~thumb.jpg`,
    );
  });

  it("picks ~128k.mp3 for audio", async () => {
    const url = "https://images-api.nasa.gov/search?q=apollo&media_type=audio&page_size=5";
    const { ctx } = fakeContext({
      [url]: fixture("nasa-search-audio.json"),
      [`${ASSETS}/audio/Ep433_Callsign%20White%20Flight/collection.json`]: fixture(
        "nasa-collection-audio.json",
      ),
    });

    const found = await nasaConnector.search("apollo", "audio", 5, ctx);

    expect(found).toHaveLength(1);
    expect(found[0]?.mediaUrl).toBe(
      `${ASSETS}/audio/Ep433_Callsign%20White%20Flight/Ep433_Callsign%20White%20Flight~128k.mp3`,
    );
    expect(found[0]?.contentType).toBe("audio/mpeg");
  });

  it("fetches asset listings for at most `limit` items", async () => {
    const url = "https://images-api.nasa.gov/search?q=apollo&media_type=image&page_size=1";
    const { ctx, requested } = fakeContext({
      [url]: fixture("nasa-search-image.json"), // the API may answer with more items than asked for
      [`${ASSETS}/image/AS11-40-5903/collection.json`]: fixture("nasa-collection-image.json"),
    });

    const found = await nasaConnector.search("apollo", "picture", 1, ctx);

    expect(found).toHaveLength(1);
    expect(requested).toEqual([url, `${ASSETS}/image/AS11-40-5903/collection.json`]);
  });

  it("rejects an answer that is not a NASA collection", async () => {
    const url = "https://images-api.nasa.gov/search?q=apollo&media_type=image&page_size=3";
    const { ctx } = fakeContext({ [url]: { error: "nope" } });
    await expect(nasaConnector.search("apollo", "picture", 3, ctx)).rejects.toMatchObject({
      error: { code: "provider_error" },
    });
  });
});

describe("nasaConnector.describeUrl", () => {
  const API = "https://images-api.nasa.gov/search?nasa_id=KSC-1985-Apollo_11";
  const answers = {
    [API]: fixture("nasa-search-video.json"),
    [`${ASSETS}/video/KSC-1985-Apollo_11/collection.json`]: fixture("nasa-collection-video.json"),
  };

  it("describes images.nasa.gov/details/<id> through the API, single candidate", async () => {
    const { ctx, requested } = fakeContext(answers);

    const page = await nasaConnector.describeUrl?.(
      new URL("https://images.nasa.gov/details/KSC-1985-Apollo_11"),
      undefined,
      ctx,
    );

    expect(requested[0]).toBe(API);
    expect(page?.title).toBe("Apollo 11 Productions");
    expect(page?.license.id).toBe("public_domain");
    expect(page?.candidates.map((c) => c.mediaUrl)).toEqual([
      `${ASSETS}/video/KSC-1985-Apollo_11/KSC-1985-Apollo_11~medium.mp4`,
    ]);
  });

  it("accepts the old /details-<id> form and decodes the id", async () => {
    const { ctx, requested } = fakeContext({
      "https://images-api.nasa.gov/search?nasa_id=Ep433_Callsign+White+Flight":
        fixture("nasa-search-audio.json"),
      [`${ASSETS}/audio/Ep433_Callsign%20White%20Flight/collection.json`]: fixture(
        "nasa-collection-audio.json",
      ),
    });

    const page = await nasaConnector.describeUrl?.(
      new URL("https://images.nasa.gov/details-Ep433_Callsign%20White%20Flight"),
      "audio",
      ctx,
    );

    expect(requested[0]).toBe(
      "https://images-api.nasa.gov/search?nasa_id=Ep433_Callsign+White+Flight",
    );
    expect(page?.candidates).toHaveLength(1);
  });

  it("returns no candidate, with a note, when the requested kind differs", async () => {
    const { ctx } = fakeContext(answers);
    const page = await nasaConnector.describeUrl?.(
      new URL("https://images.nasa.gov/details/KSC-1985-Apollo_11"),
      "picture",
      ctx,
    );
    expect(page?.candidates).toEqual([]);
    expect(page?.notes.join(" ")).toContain("video");
  });

  it("ignores URLs that are not NASA details pages", async () => {
    const { ctx, requested } = fakeContext({});
    for (const url of [
      "https://images.nasa.gov/",
      "https://images.nasa.gov/search?q=apollo",
      "https://www.nasa.gov/details/KSC-1985-Apollo_11",
      "https://example.com/details/KSC-1985-Apollo_11",
    ]) {
      expect(await nasaConnector.describeUrl?.(new URL(url), undefined, ctx)).toBeNull();
    }
    expect(requested).toEqual([]);
  });

  it("reports an unknown id as unavailable", async () => {
    const { ctx } = fakeContext({
      "https://images-api.nasa.gov/search?nasa_id=nope": {
        collection: { version: "1.1", items: [] },
      },
    });
    await expect(
      nasaConnector.describeUrl?.(new URL("https://images.nasa.gov/details/nope"), undefined, ctx),
    ).rejects.toMatchObject({ error: { code: "unavailable" } });
  });
});
