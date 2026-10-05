// @vitest-environment node
import { describe, expect, it } from "vitest";
import { isResearchFailure } from "../../errors.js";
import type { ConnectorContext, ResearchHttp } from "../types.js";
import { freesoundConnector } from "./freesound.js";

const KEY = "k3y-SECRET-0123456789abcdef";

/**
 * The shape the API documents for `GET /apiv2/search/` with the `fields` this connector asks for. Not a recording:
 * the API needs a key, which this repository does not have.
 */
const ANSWER = {
  count: 3,
  next: null,
  previous: null,
  results: [
    {
      id: 2523,
      name: "Rain on a tin roof.wav",
      description: "Heavy rain<br />recorded &amp; looped.  Two takes.",
      username: "field recorder",
      license: "Creative Commons 0",
      previews: {
        "preview-hq-mp3": "https://cdn.freesound.org/previews/2/2523_1-hq.mp3",
        "preview-lq-mp3": "https://cdn.freesound.org/previews/2/2523_1-lq.mp3",
      },
      images: { waveform_m: "https://cdn.freesound.org/displays/2/2523_1_wave_M.png" },
      duration: 12.5,
      url: "https://freesound.org/people/field%20recorder/sounds/2523/",
    },
    {
      id: 77,
      name: "Door slam",
      description: "",
      username: "foley",
      license: "https://creativecommons.org/licenses/by/4.0/",
      previews: { "preview-hq-mp3": "https://cdn.freesound.org/previews/0/77_9-hq.mp3" },
      duration: 0.8,
      url: "https://freesound.org/people/foley/sounds/77/",
    },
    {
      id: 78,
      name: "Door creak",
      username: "foley",
      license: "Attribution NonCommercial",
      previews: { "preview-hq-mp3": "https://cdn.freesound.org/previews/0/78_9-hq.mp3" },
      url: "https://freesound.org/people/foley/sounds/78/",
    },
    { id: 79, name: "No preview", username: "foley", license: "Attribution", previews: {} },
  ],
};

function fakeContext(
  answer: unknown,
  apiKey: string | null = KEY,
): {
  ctx: ConnectorContext;
  requested: Array<{ url: URL; headers: Record<string, string> | undefined }>;
} {
  const requested: Array<{ url: URL; headers: Record<string, string> | undefined }> = [];
  const http: ResearchHttp = {
    async getJson(url, options) {
      requested.push({ url: new URL(url), headers: options?.headers });
      return answer;
    },
    async getPage() {
      throw new Error("Freesound never reads pages");
    },
  };
  const ctx: ConnectorContext = {
    http,
    webSearch: {
      async search() {
        throw new Error("Freesound never uses web search");
      },
    },
    domains: ["freesound.org"],
    apiKey,
  };
  return { ctx, requested };
}

describe("freesoundConnector.search", () => {
  it("has audio only: other kinds answer without a request", async () => {
    const { ctx, requested } = fakeContext(ANSWER);
    expect(await freesoundConnector.search("rain", "picture", 5, ctx)).toEqual([]);
    expect(await freesoundConnector.search("rain", "video", 5, ctx)).toEqual([]);
    expect(requested).toHaveLength(0);
  });

  it("sends the key in the Authorization header only, and asks for reusable licenses and the needed fields", async () => {
    const { ctx, requested } = fakeContext(ANSWER);

    await freesoundConnector.search("rain & wind", "audio", 20, ctx);

    const [request] = requested;
    expect(request?.headers).toEqual({ Authorization: `Token ${KEY}` });
    expect(request?.url.origin + request?.url.pathname).toBe("https://freesound.org/apiv2/search/");
    expect(Object.fromEntries(request?.url.searchParams ?? [])).toEqual({
      query: "rain & wind",
      page_size: "20",
      fields: "id,name,description,username,license,previews,images,duration,url",
      filter: 'license:("Creative Commons 0" OR "Attribution")',
    });
    expect(request?.url.toString()).not.toContain(KEY);
  });

  it("never asks for more than the 150 sounds a page may hold", async () => {
    const { ctx, requested } = fakeContext(ANSWER);
    await freesoundConnector.search("rain", "audio", 1000, ctx);
    expect(requested[0]?.url.searchParams.get("page_size")).toBe("150");
  });

  it("maps a sound to its HQ MP3 preview, page, author, duration and a CC0 license", async () => {
    const { ctx } = fakeContext(ANSWER);

    const [rain] = await freesoundConnector.search("rain", "audio", 10, ctx);

    expect(rain).toEqual({
      mediaKind: "audio",
      title: "Rain on a tin roof.wav",
      description:
        "MP3 preview (128 kbps) of a Freesound sound; the original file is not downloaded. Heavy rain recorded & looped. Two takes.",
      pageUrl: "https://freesound.org/people/field%20recorder/sounds/2523/",
      mediaUrl: "https://cdn.freesound.org/previews/2/2523_1-hq.mp3",
      previewUrl: "https://cdn.freesound.org/displays/2/2523_1_wave_M.png",
      author: "field recorder",
      authorUrl: "https://freesound.org/people/field%20recorder/",
      license: expect.objectContaining({
        id: "cc0",
        name: "CC0",
        confidence: "high",
        status: "clear",
        basis: "Freesound API (license)",
      }),
      width: null,
      height: null,
      duration: 12.5,
      bytes: null,
      contentType: "audio/mpeg",
    });
  });

  it("reads the license from its URL (with the version) or from the prose name", async () => {
    const { ctx } = fakeContext(ANSWER);

    const found = await freesoundConnector.search("door", "audio", 10, ctx);

    expect(found.map((candidate) => candidate.license)).toEqual([
      expect.objectContaining({ id: "cc0", status: "clear" }),
      expect.objectContaining({
        id: "cc_by",
        name: "CC BY 4.0",
        url: "https://creativecommons.org/licenses/by/4.0/",
        status: "attribution",
      }),
      expect.objectContaining({ id: "cc_by_nc", name: "CC BY-NC", status: "restricted" }),
    ]);
    const prose = await freesoundConnector.search(
      "door",
      "audio",
      10,
      fakeContext({ results: [{ ...ANSWER.results[2], license: "Attribution" }] }).ctx,
    );
    expect(prose[0]?.license).toMatchObject({ id: "cc_by", name: "CC BY", status: "attribution" });
  });

  it("skips sounds without an MP3 preview and returns at most the requested number", async () => {
    const { ctx } = fakeContext(ANSWER);
    expect(await freesoundConnector.search("x", "audio", 10, ctx)).toHaveLength(3);
    expect(await freesoundConnector.search("x", "audio", 2, ctx)).toHaveLength(2);
  });

  it("a sound without a license is unknown, not guessed", async () => {
    const { ctx } = fakeContext({ results: [{ ...ANSWER.results[1], license: undefined }] });
    const [only] = await freesoundConnector.search("door", "audio", 5, ctx);
    expect(only?.license).toMatchObject({ id: "unknown", status: "unknown" });
  });

  it("keeps the key out of every URL it returns and out of its errors", async () => {
    const { ctx } = fakeContext(ANSWER);
    const found = await freesoundConnector.search("rain", "audio", 10, ctx);
    const urls = found.flatMap((candidate) => [
      candidate.mediaUrl,
      candidate.pageUrl,
      candidate.previewUrl,
      candidate.authorUrl,
    ]);
    expect(urls.length).toBeGreaterThan(0);
    expect(urls.join(" ")).not.toContain(KEY);

    const failure = await freesoundConnector
      .search("rain", "audio", 5, fakeContext({ detail: `bad key ${KEY}` }).ctx)
      .catch((e) => e);
    expect(isResearchFailure(failure)).toBe(true);
    expect(failure.message).not.toContain(KEY);
    expect(failure.error.code).toBe("provider_error");
  });

  it("refuses to search without a key", async () => {
    const { ctx, requested } = fakeContext(ANSWER, null);
    const failure = await freesoundConnector.search("rain", "audio", 5, ctx).catch((e) => e);
    expect(isResearchFailure(failure)).toBe(true);
    expect(failure.error).toEqual({
      code: "invalid_request",
      message: "Freesound needs an API key",
    });
    expect(requested).toHaveLength(0);
  });

  it("treats a document without results as a provider error", async () => {
    const { ctx } = fakeContext({ results: "none" });
    const failure = await freesoundConnector.search("rain", "audio", 5, ctx).catch((e) => e);
    expect(failure.error.code).toBe("provider_error");
  });
});
