// @vitest-environment node
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { isRecord } from "@hyperframes/agent-protocol";
import { ResearchFailure } from "../../errors.js";
import type { ConnectorContext, ResearchHttp } from "../types.js";
import { nasaSvsConnector } from "./nasaSvs.js";

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
      throw new Error("NASA SVS never reads pages");
    },
  };
  const ctx: ConnectorContext = {
    http,
    webSearch: {
      async search() {
        throw new Error("NASA SVS never uses web search");
      },
    },
    domains: ["svs.gsfc.nasa.gov"],
    apiKey: null,
  };
  return { ctx, requested };
}

const API = "https://svs.gsfc.nasa.gov/api";
const SEARCH = `${API}/search/?search=hurricane&limit=3`;
const FILES = "https://svs.gsfc.nasa.gov/vis/a000000";

function answers() {
  return {
    [SEARCH]: fixture("nasa-svs-search.json"),
    [`${API}/5681/`]: fixture("nasa-svs-video.json"),
    [`${API}/5669/`]: fixture("nasa-svs-picture.json"),
    [`${API}/15035/`]: fixture("nasa-svs-video-main.json"),
  };
}

/** The fixture page with its media groups replaced, for cases the real pages do not cover. */
function pageWith(base: string, changes: Record<string, unknown>): unknown {
  const page = fixture(base);
  return isRecord(page) ? { ...page, ...changes } : page;
}

describe("nasaSvsConnector.search", () => {
  it("lists videos: an MP4 up to 1920 px (never frames or 5760 px), the main video first, credits and license", async () => {
    const { ctx, requested } = fakeContext(answers());

    const found = await nasaSvsConnector.search("hurricane", "video", 3, ctx);

    expect(requested[0]).toBe(SEARCH);
    expect(requested.slice(1).sort()).toEqual([`${API}/15035/`, `${API}/5669/`, `${API}/5681/`]);
    expect(found).toHaveLength(2); // 5669 is a still image page
    expect(found[0]).toEqual({
      mediaKind: "video",
      title: "Hurricane Polo Makes Landfall in Baja California",
      description: expect.stringContaining("Hurricane Polo became a Tropical Storm"),
      pageUrl: "https://svs.gsfc.nasa.gov/5681/",
      mediaUrl: `${FILES}/a005600/a005681/Polo_v07_stutter_with_dates.mp4`,
      previewUrl: `${FILES}/a005600/a005681/Polo_v07_stutter_with_dates.01500_print.jpg`,
      author: "Alex Kekesi",
      authorUrl: null,
      license: expect.objectContaining({
        id: "public_domain",
        name: "Public domain (NASA)",
        confidence: "high",
        status: "clear",
        basis: "NASA SVS (NASA media usage guidelines)",
      }),
      width: 1920,
      height: 1080,
      duration: null,
      bytes: 194091418, // from the "[185.1 MB]" entry of the page's file listing
      contentType: "video/mp4",
    });
    expect(found[0]?.description).not.toContain("||");
    expect(found[1]).toMatchObject({
      title: "Forty Years of Change in Louisiana’s Wetlands",
      mediaUrl: expect.stringMatching(/Louisiana_Wetlands_-_Web_-_1\.mp4$/),
      author: "NASA Scientific Visualization Studio",
      width: 1920,
    });
  });

  it("lists pictures: the largest still up to 4000 px, no thumbnails, color bars or video posters", async () => {
    const { ctx } = fakeContext(answers());

    const found = await nasaSvsConnector.search("hurricane", "picture", 3, ctx);

    expect(found).toHaveLength(1); // the two video pages only have poster frames
    expect(found[0]).toMatchObject({
      mediaKind: "picture",
      title: "GEOS Aerosols (2025)",
      pageUrl: "https://svs.gsfc.nasa.gov/5669/",
      mediaUrl: `${FILES}/a005600/a005669/Aerosols_2025-08-19T20_00_00_3840x2160.png`,
      width: 3840,
      height: 2160,
      author: "Joseph V. Ardizzone, Helen-Nicole Kostis",
      contentType: "image/png",
    });
  });

  it("never offers a 4K-only video and skips pages whose detail request fails", async () => {
    const fourK = pageWith("nasa-svs-video.json", {
      main_video: null,
      media_groups: [
        {
          id: 1,
          widget: "Video player",
          description: "",
          items: [
            {
              id: 1,
              instance: {
                url: `${FILES}/a005600/a005681/big.mp4`,
                filename: "big.mp4",
                media_type: "Movie",
                width: 3840,
                height: 2160,
              },
            },
            {
              id: 2,
              instance: {
                url: `${FILES}/a005600/a005681/big.mov`,
                filename: "big.mov",
                media_type: "Movie",
                width: 1280,
                height: 720,
              },
            },
          ],
        },
      ],
    });
    const { ctx } = fakeContext({
      [SEARCH]: fixture("nasa-svs-search.json"),
      [`${API}/5681/`]: fourK,
    });

    expect(await nasaSvsConnector.search("hurricane", "video", 3, ctx)).toEqual([]);
  });

  it("skips a listed MP4 beyond 500 MB for the next small one", async () => {
    const instance = (name: string) => ({
      id: 1,
      instance: {
        url: `${FILES}/a005600/a005681/${name}`,
        filename: name,
        media_type: "Movie",
        width: 1920,
        height: 1080,
      },
    });
    const page = pageWith("nasa-svs-video.json", {
      description:
        "Clips. || huge.mp4 (1920x1080) [700.0 MB] || small.mp4 (1920x1080) [90.5 MB] ||",
      media_groups: [
        {
          id: 1,
          widget: "Video player",
          description: "",
          items: [instance("huge.mp4"), instance("small.mp4")],
        },
      ],
    });
    const { ctx } = fakeContext({
      [`${API}/search/?search=clips&limit=1`]: { results: [{ id: 5681 }] },
      [`${API}/5681/`]: page,
    });

    const [found] = await nasaSvsConnector.search("clips", "video", 1, ctx);

    expect(found?.mediaUrl).toMatch(/small\.mp4$/);
    expect(found?.bytes).toBe(Math.round(90.5 * 1024 * 1024));
  });

  it("notes music credits of a video, which may be licensed separately", async () => {
    const withMusic = pageWith("nasa-svs-video.json", {
      media_groups: [
        {
          id: 1,
          widget: "Video player",
          description:
            "<p>Music is “Lunar Thistle” by Lucie Rose of Universal Production Music.</p>",
          items: [
            {
              id: 1,
              instance: {
                url: `${FILES}/a005600/a005681/clip.mp4`,
                filename: "clip.mp4",
                media_type: "Movie",
                width: 1280,
                height: 720,
              },
            },
          ],
        },
      ],
    });
    const { ctx } = fakeContext({
      [`${API}/search/?search=moon&limit=1`]: { results: [{ id: 5681 }] },
      [`${API}/5681/`]: withMusic,
    });

    const [found] = await nasaSvsConnector.search("moon", "video", 1, ctx);

    expect(found?.description).toContain("may be licensed separately");
    expect(found?.mediaUrl).toBe(`${FILES}/a005600/a005681/clip.mp4`);
    expect(found?.previewUrl).toBe(`${FILES}/a005600/a005681/Polo_v07_dates.02000_print.jpg`); // the page's main image
  });

  it("fetches details for at most `limit` results and never searches audio", async () => {
    const { ctx, requested } = fakeContext(answers());
    await expect(nasaSvsConnector.search("hurricane", "audio", 3, ctx)).resolves.toEqual([]);
    expect(requested).toEqual([]);

    const limited = fakeContext({
      ...answers(),
      [`${API}/search/?search=hurricane&limit=1`]: fixture("nasa-svs-search.json"),
    });
    await nasaSvsConnector.search("hurricane", "video", 1, limited.ctx);
    expect(limited.requested).toEqual([`${API}/search/?search=hurricane&limit=1`, `${API}/5681/`]);
  });

  it("rejects answers that are not an SVS search", async () => {
    const { ctx } = fakeContext({ [SEARCH]: { detail: "nope" } });
    await expect(nasaSvsConnector.search("hurricane", "video", 3, ctx)).rejects.toMatchObject({
      error: { code: "provider_error" },
    });
  });

  it("propagates a failed search request", async () => {
    const { ctx } = fakeContext({});
    await expect(nasaSvsConnector.search("hurricane", "video", 3, ctx)).rejects.toMatchObject({
      error: { code: "unavailable" },
    });
  });
});

describe("nasaSvsConnector.describeUrl", () => {
  it("describes an SVS page, one candidate per requested kind", async () => {
    const { ctx } = fakeContext(answers());

    const video = await nasaSvsConnector.describeUrl?.(
      new URL("https://svs.gsfc.nasa.gov/5681/"),
      "video",
      ctx,
    );
    expect(video?.title).toBe("Hurricane Polo Makes Landfall in Baja California");
    expect(video?.author).toBe("Alex Kekesi");
    expect(video?.candidates.map((candidate) => candidate.mediaKind)).toEqual(["video"]);

    const any = await nasaSvsConnector.describeUrl?.(
      new URL("https://svs.gsfc.nasa.gov/5669"),
      undefined,
      ctx,
    );
    expect(any?.candidates.map((candidate) => candidate.mediaKind)).toEqual(["picture"]);

    const wrong = await nasaSvsConnector.describeUrl?.(
      new URL("https://svs.gsfc.nasa.gov/5669/"),
      "video",
      ctx,
    );
    expect(wrong?.candidates).toEqual([]);
    expect(wrong?.notes[0]).toContain("no usable video");
  });

  it("ignores URLs that are not SVS pages", async () => {
    const { ctx, requested } = fakeContext({});
    for (const url of [
      "https://svs.gsfc.nasa.gov/api/5681/",
      "https://svs.gsfc.nasa.gov/gallery/",
      "https://example.com/5681/",
    ]) {
      expect(await nasaSvsConnector.describeUrl?.(new URL(url), "video", ctx)).toBeNull();
    }
    expect(requested).toEqual([]);
  });
});
