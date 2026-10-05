// @vitest-environment node
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { isRecord } from "@hyperframes/agent-protocol";
import { describe, expect, it } from "vitest";
import { isResearchFailure, ResearchFailure } from "../../errors.js";
import type { ConnectorContext, ResearchHttp } from "../types.js";
import { flickrConnector } from "./flickr.js";

const KEY = "0123456789abcdef0123456789abcdef";

function fixture(name: string): unknown {
  return JSON.parse(
    readFileSync(fileURLToPath(new URL(`../fixtures/${name}`, import.meta.url)), "utf8"),
  );
}

/** A recorded search answer as editable parts: the document and its `photos.photo` items. */
function editableSearch(name: string): { document: unknown; photos: Record<string, unknown>[] } {
  const document = fixture(name);
  const holder = isRecord(document) ? document.photos : null;
  if (!isRecord(holder) || !Array.isArray(holder.photo)) throw new Error("bad fixture");
  return { document, photos: holder.photo.filter(isRecord) };
}

interface Answers {
  search: unknown;
  /** `flickr.photos.getSizes` answers by photo id; a missing id is a failing call. */
  sizes?: Record<string, unknown>;
}

function fakeContext(answers: Answers, apiKey: string | null = KEY) {
  const calls: URL[] = [];
  const headers: Array<Record<string, string> | undefined> = [];
  let inFlight = 0;
  let peak = 0;
  const http: ResearchHttp = {
    async getJson(url, options) {
      const parsed = new URL(url);
      calls.push(parsed);
      headers.push(options?.headers);
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      try {
        // Lets the other workers of a bounded pool start before this call finishes.
        await Promise.resolve();
        const method = parsed.searchParams.get("method");
        if (method === "flickr.photos.search") return answers.search;
        if (method === "flickr.photos.getSizes") {
          const answer = answers.sizes?.[parsed.searchParams.get("photo_id") ?? ""];
          if (answer === undefined) throw new ResearchFailure("unavailable", "no such photo");
          return answer;
        }
        throw new Error(`unexpected method ${method}`);
      } finally {
        inFlight -= 1;
      }
    },
    async getPage() {
      throw new Error("Flickr never reads pages");
    },
  };
  const ctx: ConnectorContext = {
    http,
    webSearch: { search: async () => [] },
    domains: ["flickr.com", "staticflickr.com", "flic.kr"],
    apiKey,
  };
  return { ctx, calls, headers, peak: () => peak };
}

const videoAnswers: Answers = {
  search: fixture("flickr-search-videos.json"),
  sizes: {
    "33440001": fixture("flickr-sizes-video.json"),
    "33440002": fixture("flickr-sizes-video-legacy.json"),
    "33440004": fixture("flickr-sizes-flash-only.json"),
  },
};

describe("flickrConnector.search (pictures)", () => {
  it("searches reusable licenses, photos only, with the key as an API parameter", async () => {
    const { ctx, calls } = fakeContext({ search: fixture("flickr-search-photos.json") });
    await flickrConnector.search("volcano & ash", "picture", 6, ctx);

    expect(calls).toHaveLength(1);
    const url = calls[0];
    expect(url?.origin + url?.pathname).toBe("https://api.flickr.com/services/rest/");
    const param = (name: string) => url?.searchParams.get(name);
    expect(param("method")).toBe("flickr.photos.search");
    expect(param("api_key")).toBe(KEY);
    expect(param("text")).toBe("volcano & ash");
    expect(param("license")).toBe("4,5,7,8,9,10,11,12");
    expect(param("media")).toBe("photos");
    expect(param("content_types")).toBe("0");
    expect(param("safe_search")).toBe("1");
    expect(param("per_page")).toBe("6");
    expect(param("format")).toBe("json");
    expect(param("nojsoncallback")).toBe("1");
    expect(param("extras")?.split(",")).toEqual(
      expect.arrayContaining(["license", "owner_name", "description", "media", "url_l", "url_o"]),
    );
  });

  it("maps a photo: largest size offered, page, author, cleaned description, license", async () => {
    const { ctx } = fakeContext({ search: fixture("flickr-search-photos.json") });
    const found = await flickrConnector.search("volcano", "picture", 6, ctx);

    expect(found[0]).toEqual({
      mediaKind: "picture",
      title: "Chaparrastique Volcano Eruption Captured by Satellite",
      description: "The Chaparrastique volcano erupted on Dec. 29, 2013. More at NASA & partners.",
      pageUrl: "https://www.flickr.com/photos/24662369@N07/11653609255",
      mediaUrl: "https://live.staticflickr.com/2818/11653609255_0a1b2c3d4e_k.jpg",
      previewUrl: "https://live.staticflickr.com/2818/11653609255_5ddd09754a.jpg",
      author: "NASA Goddard Photo and Video",
      authorUrl: "https://www.flickr.com/people/24662369@N07/",
      license: {
        id: "cc_by",
        name: "CC BY 2.0",
        url: "https://creativecommons.org/licenses/by/2.0/",
        confidence: "high",
        status: "attribution",
        basis: "Flickr API (photo license)",
      },
      width: 2048,
      height: 1152,
      duration: null,
      bytes: null,
      contentType: "image/jpeg",
    });
  });

  it("falls back to smaller renditions, reads string sizes, and types an original by its extension", async () => {
    const { ctx } = fakeContext({ search: fixture("flickr-search-photos.json") });
    const found = await flickrConnector.search("library", "picture", 6, ctx);

    // No url_k/h/l: the 800 px rendering wins over the original.
    expect(found[1]).toMatchObject({
      title: "Hall of the Library, 1923",
      mediaUrl: "https://live.staticflickr.com/8366/8540012345_a1b2c3d4e5_c.jpg",
      width: 800,
      height: 600,
      description: "",
    });

    const originalOnly = editableSearch("flickr-search-photos.json");
    delete originalOnly.photos[1]?.url_c;
    const second = await flickrConnector.search(
      "library",
      "picture",
      6,
      fakeContext({ search: originalOnly.document }).ctx,
    );
    expect(second[1]).toMatchObject({
      mediaUrl: "https://live.staticflickr.com/8366/8540012345_f0e1d2c3b4_o.png",
      width: 2400,
      height: 1800,
      contentType: "image/png",
    });
  });

  it("keeps only reusable licenses and importable items, in source order", async () => {
    const { ctx } = fakeContext({ search: fixture("flickr-search-photos.json") });
    const found = await flickrConnector.search("volcano", "picture", 6, ctx);
    // Dropped: CC BY-NC (2), a photo without any file URL, and a video returned as a photo.
    expect(found.map((c) => c.title)).toEqual([
      "Chaparrastique Volcano Eruption Captured by Satellite",
      "Hall of the Library, 1923",
      "Space Shuttle at dawn",
    ]);
  });

  it("maps every reusable Flickr license id, and refuses the rest", async () => {
    const expected: Record<
      string,
      { id: string; name: string; status: string; confidence: string }
    > = {
      "4": { id: "cc_by", name: "CC BY 2.0", status: "attribution", confidence: "high" },
      "5": { id: "cc_by_sa", name: "CC BY-SA 2.0", status: "attribution", confidence: "high" },
      "7": {
        id: "public_domain",
        name: "No known copyright restrictions",
        status: "clear",
        confidence: "medium",
      },
      "8": {
        id: "public_domain",
        name: "Public domain (United States Government Work)",
        status: "clear",
        confidence: "medium",
      },
      "9": { id: "cc0", name: "CC0 1.0", status: "clear", confidence: "high" },
      "10": { id: "pdm", name: "Public Domain Mark 1.0", status: "clear", confidence: "high" },
      "11": { id: "cc_by", name: "CC BY 4.0", status: "attribution", confidence: "high" },
      "12": { id: "cc_by_sa", name: "CC BY-SA 4.0", status: "attribution", confidence: "high" },
    };
    const photo = (license: string | number) => ({
      id: `p${license}`,
      owner: "1@N01",
      title: `License ${license}`,
      license,
      media: "photo",
      url_l: `https://live.staticflickr.com/1/p${license}_aa_b.jpg`,
    });
    const ids = [...Object.keys(expected), "0", "1", "2", "3", "6", "13", "14", "15", "16", "99"];
    const { ctx } = fakeContext({
      search: { stat: "ok", photos: { photo: ids.map((id) => photo(id)) } },
    });
    const found = await flickrConnector.search("x", "picture", 100, ctx);

    expect(found.map((c) => c.title)).toEqual(Object.keys(expected).map((id) => `License ${id}`));
    for (const candidate of found) {
      const id = candidate.title.replace("License ", "");
      expect(candidate.license).toMatchObject(expected[id] ?? {});
    }
    expect(found[2]?.license.url).toBe("http://rightsstatements.org/vocab/NKC/1.0/");

    // A numeric license field is read like a string one.
    const numeric = fakeContext({ search: { stat: "ok", photos: { photo: [photo(9)] } } });
    expect((await flickrConnector.search("x", "picture", 5, numeric.ctx))[0]?.license.id).toBe(
      "cc0",
    );
  });

  it("returns at most `limit` results and never asks for more than that per page", async () => {
    const { ctx, calls } = fakeContext({ search: fixture("flickr-search-photos.json") });
    const found = await flickrConnector.search("volcano", "picture", 2, ctx);
    expect(found).toHaveLength(2);
    expect(calls[0]?.searchParams.get("per_page")).toBe("2");

    const many = fakeContext({ search: fixture("flickr-search-photos.json") });
    await flickrConnector.search("volcano", "picture", 5000, many.ctx);
    expect(many.calls[0]?.searchParams.get("per_page")).toBe("100");
  });

  it("never puts the key in a candidate URL", async () => {
    const { ctx } = fakeContext({ search: fixture("flickr-search-photos.json") });
    const found = await flickrConnector.search("volcano", "picture", 6, ctx);
    expect(found.length).toBeGreaterThan(0);
    for (const c of found) {
      for (const url of [c.mediaUrl, c.pageUrl, c.previewUrl, c.authorUrl]) {
        expect(url ?? "").not.toContain(KEY);
      }
    }
  });
});

describe("flickrConnector.search (videos)", () => {
  it("searches videos only and sizes each video with the key as an API parameter", async () => {
    const { ctx, calls, headers } = fakeContext(videoAnswers);
    await flickrConnector.search("waves", "video", 4, ctx);

    const search = calls[0];
    expect(search?.searchParams.get("media")).toBe("videos");
    expect(search?.searchParams.get("per_page")).toBe("4");
    expect(search?.searchParams.get("license")).toBe("4,5,7,8,9,10,11,12");
    // content_types would filter videos by the photo content types.
    expect(search?.searchParams.has("content_types")).toBe(false);
    const sizing = calls.slice(1);
    // The CC BY-NC video (license 3) is not sized: it is dropped before any detail request.
    expect(sizing.map((url) => url.searchParams.get("photo_id")).sort()).toEqual([
      "33440001",
      "33440002",
      "33440003",
      "33440004",
    ]);
    for (const url of sizing) {
      expect(url.searchParams.get("method")).toBe("flickr.photos.getSizes");
      expect(url.searchParams.get("api_key")).toBe(KEY);
    }
    expect(headers.every((value) => value === undefined)).toBe(true);
  });

  it("offers the best MP4 rendition of each video as a play URL and drops unusable ones", async () => {
    const { ctx } = fakeContext(videoAnswers);
    const found = await flickrConnector.search("waves", "video", 5, ctx);

    // Dropped: sizing failed (33440003), only the Flash player (33440004), CC BY-NC (33440005).
    expect(found.map((c) => c.title)).toEqual(["Waves at the pier", "Old reel, 1950"]);
    expect(found[0]).toEqual({
      mediaKind: "video",
      title: "Waves at the pier",
      description: "A short clip.",
      pageUrl: "https://www.flickr.com/photos/55555555@N05/33440001",
      mediaUrl: "https://www.flickr.com/photos/55555555@N05/33440001/play/720p/61a9486355/",
      previewUrl: "https://live.staticflickr.com/65535/33440001_61a9486355.jpg",
      author: "Dora",
      authorUrl: "https://www.flickr.com/people/55555555@N05/",
      license: expect.objectContaining({ id: "cc_by", status: "attribution" }),
      width: 1280,
      height: 720,
      duration: null,
      bytes: null,
      contentType: "video/mp4",
    });
    // The older rendition names: HD MP4 beats Site MP4 and Mobile MP4.
    expect(found[1]).toMatchObject({
      mediaUrl: "https://www.flickr.com/photos/66666666@N06/33440002/play/hd/7b8c9d0e1f/",
      width: 1280,
      license: { id: "pdm", status: "clear" },
    });
  });

  it("sizes at most `limit` videos, with at most four requests in flight", async () => {
    const limited = fakeContext(videoAnswers);
    const found = await flickrConnector.search("waves", "video", 2, limited.ctx);
    expect(found).toHaveLength(2);
    expect(
      limited.calls.filter((u) => u.searchParams.get("method") === "flickr.photos.getSizes"),
    ).toHaveLength(2);

    const first = editableSearch("flickr-search-videos.json").photos[0] ?? {};
    const photo = Array.from({ length: 12 }, (_, index) => ({
      ...first,
      id: `v${index}`,
      license: "4",
    }));
    const sizes = Object.fromEntries(photo.map((p) => [p.id, fixture("flickr-sizes-video.json")]));
    const busy = fakeContext({ search: { stat: "ok", photos: { photo } }, sizes });
    expect(await flickrConnector.search("waves", "video", 12, busy.ctx)).toHaveLength(12);
    expect(busy.peak()).toBe(4);
  });

  it("never puts the key in a candidate URL", async () => {
    const { ctx } = fakeContext(videoAnswers);
    const found = await flickrConnector.search("waves", "video", 5, ctx);
    expect(found.length).toBeGreaterThan(0);
    for (const c of found) {
      for (const url of [c.mediaUrl, c.pageUrl, c.previewUrl, c.authorUrl]) {
        expect(url ?? "").not.toContain(KEY);
      }
    }
  });
});

describe("flickrConnector errors", () => {
  it("has no audio", async () => {
    const { ctx, calls } = fakeContext({ search: fixture("flickr-search-photos.json") });
    expect(await flickrConnector.search("rain", "audio", 5, ctx)).toEqual([]);
    expect(calls).toHaveLength(0);
  });

  it("refuses to run without a key", async () => {
    const { ctx, calls } = fakeContext({ search: fixture("flickr-search-photos.json") }, null);
    const failure = await flickrConnector.search("x", "picture", 5, ctx).catch((e: unknown) => e);
    expect(isResearchFailure(failure) && failure.error.code).toBe("invalid_request");
    expect(isResearchFailure(failure) && failure.message).toBe("Flickr needs an API key");
    expect(calls).toHaveLength(0);
  });

  it("reports a rejected key without echoing it", async () => {
    const { ctx } = fakeContext({ search: fixture("flickr-error-key.json") });
    const failure = await flickrConnector.search("x", "picture", 5, ctx).catch((e: unknown) => e);
    expect(isResearchFailure(failure) && failure.error.code).toBe("invalid_request");
    expect(isResearchFailure(failure) && failure.message).toBe("Flickr rejected the API key");
  });

  it("reports other Flickr failures and malformed answers as provider errors", async () => {
    const answers = [
      { stat: "fail", code: 105, message: "Service currently unavailable" },
      { stat: "ok" },
      { stat: "ok", photos: { photo: "none" } },
      "<html>",
      null,
    ];
    for (const search of answers) {
      const { ctx } = fakeContext({ search });
      const failure = await flickrConnector.search("x", "picture", 5, ctx).catch((e: unknown) => e);
      expect(isResearchFailure(failure) && failure.error.code).toBe("provider_error");
    }
  });

  it("passes a transport failure on", async () => {
    const http: ResearchHttp = {
      async getJson() {
        throw new ResearchFailure("rate_limited", "Too many requests");
      },
      async getPage() {
        throw new Error("never");
      },
    };
    const ctx: ConnectorContext = {
      http,
      webSearch: { search: async () => [] },
      domains: ["flickr.com"],
      apiKey: KEY,
    };
    const failure = await flickrConnector.search("x", "video", 5, ctx).catch((e: unknown) => e);
    expect(isResearchFailure(failure) && failure.error.code).toBe("rate_limited");
  });
});
