// @vitest-environment node
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { isRecord } from "@hyperframes/agent-protocol";
import { describe, expect, it } from "vitest";
import { isResearchFailure, ResearchFailure } from "../../errors.js";
import type { ConnectorContext, ResearchHttp } from "../types.js";
import { smithsonianConnector } from "./smithsonian.js";

const KEY = "sk-test-0123456789abcdef";

function fixtureText(name: string): string {
  return readFileSync(fileURLToPath(new URL(`../fixtures/${name}`, import.meta.url)), "utf8");
}

interface Call {
  url: URL;
  headers: Record<string, string>;
}

function fakeContext(answer: unknown, apiKey: string | null = KEY) {
  const calls: Call[] = [];
  const http: ResearchHttp = {
    async getJson(url, options) {
      calls.push({ url: new URL(url), headers: options?.headers ?? {} });
      if (answer instanceof Error) throw answer;
      return answer;
    },
    async getPage() {
      throw new Error("Smithsonian never reads pages");
    },
  };
  const ctx: ConnectorContext = {
    http,
    webSearch: { search: async () => [] },
    domains: ["si.edu"],
    apiKey,
  };
  return { ctx, calls };
}

type Rec = Record<string, unknown>;

/** The recorded answer, fresh for each test (tests edit it). */
function searchAnswer(): { response: { rows: Rec[] } } {
  const json: unknown = JSON.parse(fixtureText("smithsonian-search.json"));
  if (!isRecord(json) || !isRecord(json.response) || !Array.isArray(json.response.rows)) {
    throw new Error("bad fixture");
  }
  return { response: { rows: json.response.rows.filter(isRecord) } };
}

/** The `online_media.media` list of a recorded record, to edit in place. */
function mediaOf(row: Rec | undefined): Rec[] {
  const content = row?.content;
  const descriptive = isRecord(content) ? content.descriptiveNonRepeating : null;
  const online = isRecord(descriptive) ? descriptive.online_media : null;
  if (!isRecord(online) || !Array.isArray(online.media)) throw new Error("bad fixture row");
  return online.media.filter(isRecord);
}

describe("smithsonianConnector.search", () => {
  it("asks for CC0 images with the key in a header, and only there", async () => {
    const { ctx, calls } = fakeContext(searchAnswer());
    await smithsonianConnector.search("butterfly", "picture", 3, ctx);

    expect(calls).toHaveLength(1);
    expect(calls[0]?.url.origin + calls[0]?.url.pathname).toBe(
      "https://api.si.edu/openaccess/api/v1.0/search",
    );
    expect(calls[0]?.url.searchParams.get("q")).toBe(
      "(butterfly) AND online_media_type:Images AND media_usage:CC0",
    );
    expect(calls[0]?.url.searchParams.get("rows")).toBe("3");
    expect(calls[0]?.headers).toEqual({ "X-Api-Key": KEY });
    expect(calls[0]?.url.toString()).not.toContain(KEY);
  });

  it("turns the user's words into plain terms: no query syntax gets through", async () => {
    const { ctx, calls } = fakeContext(searchAnswer());
    await smithsonianConnector.search('red "fox": (winter) OR title:x*', "picture", 3, ctx);
    expect(calls[0]?.url.searchParams.get("q")).toBe(
      "(red AND fox AND winter AND title AND x) AND online_media_type:Images AND media_usage:CC0",
    );

    const empty = fakeContext(searchAnswer());
    expect(await smithsonianConnector.search(' "" ( ) ', "picture", 3, empty.ctx)).toEqual([]);
    expect(empty.calls).toHaveLength(0);
  });

  it("offers only pictures, and caps the page size", async () => {
    const other = fakeContext(searchAnswer());
    expect(await smithsonianConnector.search("butterfly", "video", 3, other.ctx)).toEqual([]);
    expect(other.calls).toHaveLength(0);

    const { ctx, calls } = fakeContext(searchAnswer());
    await smithsonianConnector.search("butterfly", "picture", 500, ctx);
    expect(calls[0]?.url.searchParams.get("rows")).toBe("100");
  });

  it("maps a record to a sized JPEG candidate with its CC0 license, author and description", async () => {
    const { ctx } = fakeContext(searchAnswer());
    const found = await smithsonianConnector.search("butterfly", "picture", 3, ctx);

    expect(found).toHaveLength(3);
    expect(found[0]).toEqual({
      mediaKind: "picture",
      title: "Le Blessé",
      description: expect.stringContaining("An injured butterfly is shown"),
      pageUrl: "https://collection.cooperhewitt.org/view/objects/asitem/id/34063",
      mediaUrl: "https://ids.si.edu/ids/deliveryService?id=CHSDM-34063_02-000001&max=2000",
      previewUrl: "https://ids.si.edu/ids/deliveryService?id=CHSDM-34063_02-000001&max=400",
      author: "Charles-Germain de Saint-Aubin, French, 1721–1786",
      authorUrl: null,
      license: {
        id: "cc0",
        name: "CC0 1.0",
        url: "https://creativecommons.org/publicdomain/zero/1.0/",
        confidence: "high",
        status: "clear",
        basis: "Smithsonian Open Access API (media usage CC0)",
      },
      // The record's scan is 7037x4344; the 2000 px rendering keeps its proportions.
      width: 2000,
      height: 1235,
      duration: null,
      bytes: null,
      contentType: "image/jpeg",
    });
    // No artist label: the first listed name is the credit.
    expect(found[1]?.author).toBe(
      "Gorham Manufacturing Company, Providence, Rhode Island, USA, founded 1818",
    );
  });

  it("skips what is not a CC0 picture: restricted scans, other media types, records without media", async () => {
    const answer = searchAnswer();
    const [restricted, model, none] = answer.response.rows;
    for (const media of mediaOf(restricted)) media.usage = { access: "Usage conditions apply" };
    for (const media of mediaOf(model)) media.type = "3D Models";
    for (const media of mediaOf(none)) media.type = "Sound recordings";
    // The second scan of the last record stays CC0: it is picked after the first one is refused.
    answer.response.rows.push({
      title: "Second scan",
      content: {
        descriptiveNonRepeating: {
          record_link: "https://example.si.edu/object/1",
          online_media: {
            media: [
              {
                type: "Images",
                usage: { access: "Usage conditions apply" },
                content: "https://ids.si.edu/ids/deliveryService?id=A",
              },
              {
                type: "Images",
                usage: { access: "CC0" },
                content: "https://ids.si.edu/ids/deliveryService?id=B",
              },
            ],
          },
        },
      },
    });

    const { ctx } = fakeContext(answer);
    const found = await smithsonianConnector.search("butterfly", "picture", 10, ctx);
    expect(found.map((c) => c.title)).toEqual(["Second scan"]);
    expect(found[0]).toMatchObject({
      mediaUrl: "https://ids.si.edu/ids/deliveryService?id=B&max=2000",
      width: null,
      height: null,
      author: null,
      description: "",
    });
  });

  it("returns at most `limit` candidates, in source order", async () => {
    const { ctx } = fakeContext(searchAnswer());
    const found = await smithsonianConnector.search("butterfly", "picture", 2, ctx);
    expect(found.map((c) => c.title)).toEqual(["Le Blessé", "Female Mask and Butterflies"]);
  });

  it("never puts the key in a candidate URL", async () => {
    const { ctx } = fakeContext(searchAnswer());
    const found = await smithsonianConnector.search("butterfly", "picture", 3, ctx);
    for (const candidate of found) {
      for (const url of [
        candidate.mediaUrl,
        candidate.pageUrl,
        candidate.previewUrl,
        candidate.authorUrl,
      ]) {
        expect(url ?? "").not.toContain(KEY);
      }
    }
  });

  it("refuses to run without a key", async () => {
    const { ctx, calls } = fakeContext(searchAnswer(), null);
    const failure = await smithsonianConnector
      .search("butterfly", "picture", 3, ctx)
      .catch((e: unknown) => e);
    expect(isResearchFailure(failure) && failure.error.code).toBe("invalid_request");
    expect(isResearchFailure(failure) && failure.message).toBe("Smithsonian needs an API key");
    expect(calls).toHaveLength(0);
  });

  it("reports an unexpected document as a provider error", async () => {
    for (const answer of [{ error: { code: "API_KEY_INVALID" } }, [], null, { response: {} }]) {
      const { ctx } = fakeContext(answer);
      const failure = await smithsonianConnector
        .search("butterfly", "picture", 3, ctx)
        .catch((e: unknown) => e);
      expect(isResearchFailure(failure) && failure.error.code).toBe("provider_error");
    }
  });

  it("passes a transport failure on", async () => {
    const { ctx } = fakeContext(new ResearchFailure("rate_limited", "Too many requests"));
    const failure = await smithsonianConnector
      .search("butterfly", "picture", 3, ctx)
      .catch((e: unknown) => e);
    expect(isResearchFailure(failure) && failure.error.code).toBe("rate_limited");
  });
});
