// @vitest-environment node
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { isRecord } from "@hyperframes/agent-protocol";
import { isResearchFailure } from "../../errors.js";
import type { ConnectorContext, ResearchHttp } from "../types.js";
import { iconifyConnector } from "./iconify.js";

function fixture(name: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(
    readFileSync(fileURLToPath(new URL(`../fixtures/${name}`, import.meta.url)), "utf8"),
  );
  if (!isRecord(parsed)) throw new Error(`${name} is not an object`);
  return parsed;
}

function fakeContext(answer: unknown): { ctx: ConnectorContext; requested: URL[] } {
  const requested: URL[] = [];
  const http: ResearchHttp = {
    async getJson(url) {
      requested.push(new URL(url));
      return answer;
    },
    async getPage() {
      throw new Error("Iconify never reads pages");
    },
  };
  const ctx: ConnectorContext = {
    http,
    webSearch: {
      async search() {
        throw new Error("Iconify never uses web search");
      },
    },
    domains: ["iconify.design"],
    apiKey: null,
  };
  return { ctx, requested };
}

describe("iconifyConnector.search", () => {
  it("has pictures only: other kinds answer without a request", async () => {
    const { ctx, requested } = fakeContext({});
    expect(await iconifyConnector.search("pencil", "audio", 5, ctx)).toEqual([]);
    expect(await iconifyConnector.search("pencil", "video", 5, ctx)).toEqual([]);
    expect(requested).toHaveLength(0);
  });

  it("asks for at least 32 results (the API's minimum) and more when many are wanted", async () => {
    const { ctx, requested } = fakeContext(fixture("iconify-pencil.json"));
    await iconifyConnector.search("pencil & ink", "picture", 3, ctx);
    await iconifyConnector.search("pencil", "picture", 40, ctx);
    await iconifyConnector.search("pencil", "picture", 500, ctx);

    expect(requested[0]?.origin + requested[0]?.pathname).toBe("https://api.iconify.design/search");
    expect(requested[0]?.searchParams.get("query")).toBe("pencil & ink");
    expect(requested.map((url) => url.searchParams.get("limit"))).toEqual(["32", "80", "100"]);
  });

  it("maps an icon to a sized SVG with its set's author, page and license", async () => {
    const { ctx } = fakeContext(fixture("iconify-pencil.json"));

    const [first] = await iconifyConnector.search("pencil", "picture", 5, ctx);

    expect(first).toEqual({
      mediaKind: "picture",
      title: "pencil (Material Design Icons)",
      description: "Icon “pencil” from the Material Design Icons icon set.",
      pageUrl: "https://icon-sets.iconify.design/mdi/pencil/",
      // Without an explicit height the SVG is 1em wide and rasterizes at 16 px.
      mediaUrl: "https://api.iconify.design/mdi/pencil.svg?height=512",
      previewUrl: null,
      author: "Pictogrammers",
      authorUrl: "https://github.com/Templarian/MaterialDesign",
      license: expect.objectContaining({
        id: "permissive",
        name: "Apache-2.0",
        confidence: "high",
        status: "attribution",
        basis: "Iconify API (icon set license)",
      }),
      width: null,
      height: null,
      duration: null,
      bytes: null,
      contentType: "image/svg+xml",
    });
  });

  it("keeps MIT, CC BY and CC BY-SA sets and drops GPL ones", async () => {
    const { ctx } = fakeContext(fixture("iconify-pencil.json"));

    const found = await iconifyConnector.search("pencil", "picture", 10, ctx);

    // wordpress:pencil is GPL-2.0-or-later.
    expect(found.map((candidate) => [candidate.mediaUrl, candidate.license.id])).toEqual([
      ["https://api.iconify.design/mdi/pencil.svg?height=512", "permissive"],
      ["https://api.iconify.design/tabler/pencil.svg?height=512", "permissive"],
      ["https://api.iconify.design/typcn/pencil.svg?height=512", "cc_by_sa"],
      ["https://api.iconify.design/pixel/pencil.svg?height=512", "cc_by"],
    ]);
    expect(found.map((candidate) => candidate.license.name)).toEqual([
      "Apache-2.0",
      "MIT",
      "CC BY-SA 4.0",
      "CC BY 4.0",
    ]);
  });

  it("recognizes CC0 sets as clear and drops non-commercial, MPL and unlicensed ones", async () => {
    const answer = fixture("iconify-pencil.json");
    const collections = answer.collections;
    if (!isRecord(collections)) throw new Error("bad fixture");
    const withLicense = (prefix: string, license: unknown) => ({
      ...(isRecord(collections[prefix]) ? collections[prefix] : {}),
      license,
    });
    const { ctx } = fakeContext({
      ...answer,
      collections: {
        mdi: withLicense("mdi", {
          title: "CC0",
          spdx: "CC0-1.0",
          url: "https://creativecommons.org/publicdomain/zero/1.0/",
        }),
        tabler: withLicense("tabler", { title: "CC BY-NC 4.0", spdx: "CC-BY-NC-4.0" }),
        typcn: withLicense("typcn", { title: "MPL 2.0", spdx: "MPL-2.0" }),
        pixel: withLicense("pixel", undefined),
        wordpress: withLicense("wordpress", { title: "Custom license" }),
      },
    });

    const found = await iconifyConnector.search("pencil", "picture", 10, ctx);

    expect(found).toHaveLength(1);
    expect(found[0]?.license).toMatchObject({ id: "cc0", status: "clear", confidence: "high" });
  });

  it("returns at most the requested number of icons, in the API's order", async () => {
    const { ctx } = fakeContext(fixture("iconify-pencil.json"));
    const found = await iconifyConnector.search("pencil", "picture", 2, ctx);
    expect(found.map((candidate) => candidate.title)).toEqual([
      "pencil (Material Design Icons)",
      "pencil (Tabler Icons)",
    ]);
  });

  it("skips icons with a malformed id or without a collection entry", async () => {
    const answer = fixture("iconify-pencil.json");
    const { ctx } = fakeContext({
      ...answer,
      icons: ["mdi", "mdi:pen cil", "../x:y", 7, "ghost:pencil", "mdi:pencil"],
    });
    const found = await iconifyConnector.search("pencil", "picture", 10, ctx);
    expect(found.map((candidate) => candidate.mediaUrl)).toEqual([
      "https://api.iconify.design/mdi/pencil.svg?height=512",
    ]);
  });

  it("answers an empty search with no results", async () => {
    const { ctx } = fakeContext({ icons: [], total: 0, limit: 32, start: 0, collections: {} });
    expect(await iconifyConnector.search("zzzqqq", "picture", 5, ctx)).toEqual([]);
  });

  it("treats an unexpected document as a provider error", async () => {
    const { ctx } = fakeContext({ icons: "none" });
    const failure = await iconifyConnector.search("pencil", "picture", 5, ctx).catch((e) => e);
    expect(isResearchFailure(failure)).toBe(true);
    expect(failure.error.code).toBe("provider_error");
  });
});
