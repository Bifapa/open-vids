// @vitest-environment node
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { isRecord } from "@hyperframes/agent-protocol";
import { isResearchFailure } from "../../errors.js";
import type { ConnectorContext, ResearchHttp } from "../types.js";
import { ccmixterConnector } from "./ccmixter.js";

function fixture(name: string): unknown[] {
  const parsed: unknown = JSON.parse(
    readFileSync(fileURLToPath(new URL(`../fixtures/${name}`, import.meta.url)), "utf8"),
  );
  if (!Array.isArray(parsed)) throw new Error(`${name} is not a list`);
  return parsed;
}

/** An offline `ResearchHttp` that answers every API call with one document and remembers the URLs asked. */
function fakeContext(answer: unknown): { ctx: ConnectorContext; requested: URL[] } {
  const requested: URL[] = [];
  const http: ResearchHttp = {
    async getJson(url) {
      requested.push(new URL(url));
      return answer;
    },
    async getPage() {
      throw new Error("ccMixter never reads pages");
    },
  };
  const ctx: ConnectorContext = {
    http,
    webSearch: {
      async search() {
        throw new Error("ccMixter never uses web search");
      },
    },
    domains: ["ccmixter.org"],
    apiKey: null,
  };
  return { ctx, requested };
}

describe("ccmixterConnector.search", () => {
  it("has audio only: other kinds answer without a request", async () => {
    const { ctx, requested } = fakeContext([]);
    expect(await ccmixterConnector.search("ambient", "video", 5, ctx)).toEqual([]);
    expect(await ccmixterConnector.search("ambient", "picture", 5, ctx)).toEqual([]);
    expect(requested).toHaveLength(0);
  });

  it("queries the JSON API by rank with user text in `search`, over-fetching up to the server's cap", async () => {
    const { ctx, requested } = fakeContext([]);
    await ccmixterConnector.search("piano & strings", "audio", 4, ctx);
    await ccmixterConnector.search("ambient", "audio", 50, ctx);

    expect(requested[0]?.origin + requested[0]?.pathname).toBe("https://ccmixter.org/api/query");
    expect(Object.fromEntries(requested[0]?.searchParams ?? [])).toEqual({
      f: "json",
      search: "piano & strings",
      limit: "12",
      sort: "rank",
    });
    // Beyond 20 results the server answers 200 with an empty body.
    expect(requested[1]?.searchParams.get("limit")).toBe("20");
  });

  it("maps the mix: MP3 download, page, author, duration, size and the license from the license URL", async () => {
    const { ctx } = fakeContext(fixture("ccmixter-ambient.json"));

    const found = await ccmixterConnector.search("ambient", "audio", 10, ctx);
    const persephone = found.find((candidate) => candidate.title === "Persephone");

    expect(persephone).toEqual({
      mediaKind: "audio",
      title: "Persephone",
      description: expect.stringContaining("Vidian is one of my favorite Mixters"),
      pageUrl: "https://ccmixter.org/files/snowflake/22364",
      mediaUrl: "https://ccmixter.org/content/snowflake/snowflake_-_Persephone.mp3",
      previewUrl: null,
      author: "Madam Snowflake",
      authorUrl: "https://ccmixter.org/people/snowflake",
      license: expect.objectContaining({
        id: "cc_by",
        name: "CC BY 2.5",
        url: "http://creativecommons.org/licenses/by/2.5/",
        confidence: "high",
        status: "attribution",
        basis: "ccMixter API (license_url)",
      }),
      width: null,
      height: null,
      duration: 238,
      bytes: 9569034,
      contentType: "audio/mpeg",
    });
    expect(persephone?.description.length).toBeLessThanOrEqual(500);
  });

  it("lists reusable licenses first, keeping rank inside each group, and marks the rest restricted", async () => {
    const { ctx } = fakeContext(fixture("ccmixter-ambient.json"));

    const found = await ccmixterConnector.search("ambient", "audio", 10, ctx);

    expect(found.map((candidate) => [candidate.title, candidate.license.id])).toEqual([
      ["Persephone", "cc_by"],
      ["Parametaphoriquement", "cc_by"],
      ["Almost Given Up", "cc_by_nc"],
      // Sampling Plus is a legacy license the protocol does not know: the user has to read it.
      ["Black Rainbow", "other"],
    ]);
    expect(found.slice(2).map((candidate) => candidate.license.status)).toEqual([
      "restricted",
      "restricted",
    ]);
  });

  it("returns at most the requested number of results, usable ones first", async () => {
    const { ctx } = fakeContext(fixture("ccmixter-ambient.json"));
    const found = await ccmixterConnector.search("ambient", "audio", 3, ctx);
    expect(found.map((candidate) => candidate.title)).toEqual([
      "Persephone",
      "Parametaphoriquement",
      "Almost Given Up",
    ]);
  });

  it("downloads the mix rather than a stem, and a stem only when it is all there is", async () => {
    const persephone = fixture("ccmixter-ambient.json")[2];
    if (!isRecord(persephone) || !Array.isArray(persephone.files)) throw new Error("bad fixture");
    const [mix, stem] = persephone.files;
    if (!isRecord(mix) || !isRecord(stem)) throw new Error("bad fixture");
    const asStem = { ...stem, file_nicname: "Lead Vox", file_extra: { type: "pella" } };
    const withStemFirst = { ...persephone, files: [asStem, mix] };
    const stemOnly = { ...persephone, files: [asStem] };

    const { ctx } = fakeContext([withStemFirst, { ...stemOnly, upload_name: "Vocal" }]);
    const found = await ccmixterConnector.search("persephone", "audio", 5, ctx);

    expect(found[0]?.mediaUrl).toBe(
      "https://ccmixter.org/content/snowflake/snowflake_-_Persephone.mp3",
    );
    expect(found[0]?.title).toBe("Persephone");
    expect(found[1]?.mediaUrl).toBe(
      "https://ccmixter.org/content/snowflake/snowflake_-_Persephone_3.mp3",
    );
    expect(found[1]?.title).toBe("Vocal (Lead Vox)");
  });

  it("skips uploads without an MP3 and adult-flagged ones", async () => {
    const [base] = fixture("ccmixter-ambient.json");
    if (!isRecord(base) || !isRecord(base.upload_extra)) throw new Error("bad fixture");
    const { ctx } = fakeContext([
      { ...base, files: [] },
      {
        ...base,
        files: [
          {
            download_url: "https://ccmixter.org/x.zip",
            file_format_info: { "default-ext": "zip" },
          },
        ],
      },
      { ...base, upload_extra: { ...base.upload_extra, nsfw: true } },
      "not an upload",
    ]);
    expect(await ccmixterConnector.search("ambient", "audio", 5, ctx)).toEqual([]);
  });

  it("an upload without a license is unknown, not guessed", async () => {
    const [base] = fixture("ccmixter-ambient.json");
    if (!isRecord(base)) throw new Error("bad fixture");
    const { ctx } = fakeContext([{ ...base, license_url: "", license_name: "" }]);
    const [only] = await ccmixterConnector.search("ambient", "audio", 5, ctx);
    expect(only?.license).toMatchObject({ id: "unknown", status: "unknown", confidence: "none" });
  });

  it("treats a document that is not a list as a provider error", async () => {
    const { ctx } = fakeContext({ error: "nope" });
    const failure = await ccmixterConnector.search("ambient", "audio", 5, ctx).catch((e) => e);
    expect(isResearchFailure(failure)).toBe(true);
    expect(failure.error.code).toBe("provider_error");
  });
});
