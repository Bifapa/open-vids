// @vitest-environment node
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ResearchFailure } from "../../errors.js";
import type { ConnectorContext, ResearchHttp } from "../types.js";
import { archiveConnector } from "./archive.js";

function fixture(name: string): unknown {
  return JSON.parse(
    readFileSync(fileURLToPath(new URL(`../fixtures/${name}`, import.meta.url)), "utf8"),
  );
}

const META = "https://archive.org/metadata/";
const SEARCH = "https://archive.org/advancedsearch.php?";

/**
 * `search` answers every advancedsearch request; `items` maps an item identifier to its /metadata/ answer (an
 * identifier that is not listed fails like a dead request).
 */
function fakeContext(search: unknown, items: Record<string, unknown> = {}) {
  const requested: string[] = [];
  const http: ResearchHttp = {
    async getJson(url) {
      requested.push(url);
      if (url.startsWith(SEARCH)) return search;
      if (url.startsWith(META)) {
        const answer = items[decodeURIComponent(url.slice(META.length))];
        if (answer !== undefined) return answer;
      }
      throw new ResearchFailure("unavailable", `no fixture for ${url}`);
    },
    async getPage() {
      throw new Error("Internet Archive never reads pages");
    },
  };
  const ctx: ConnectorContext = {
    http,
    webSearch: {
      async search() {
        throw new Error("Internet Archive never uses web search");
      },
    },
    domains: ["archive.org"],
  };
  return { ctx, requested };
}

function queryOf(requested: string[]): string | null {
  const url = requested.find((entry) => entry.startsWith(SEARCH));
  return url ? new URL(url).searchParams.get("q") : null;
}

describe("archiveConnector.search", () => {
  it("queries advancedsearch by media type and maps items through /metadata/", async () => {
    const { ctx, requested } = fakeContext(fixture("archive-search-video.json"), {
      Popeye_forPresident: fixture("archive-meta-popeye.json"),
      clip_two: fixture("archive-meta-clip-two.json"),
      dark_item: {},
    });

    const found = await archiveConnector.search("popeye", "video", 4, ctx);

    const search = new URL(requested[0] ?? "");
    expect(search.origin + search.pathname).toBe("https://archive.org/advancedsearch.php");
    expect(search.searchParams.get("q")).toBe("(popeye) AND mediatype:(movies)");
    expect(search.searchParams.getAll("fl[]")).toEqual([
      "identifier",
      "title",
      "creator",
      "licenseurl",
      "description",
    ]);
    expect(search.searchParams.get("rows")).toBe("4");
    expect(search.searchParams.get("output")).toBe("json");
    expect(requested.slice(1)).toEqual([
      `${META}Popeye_forPresident`,
      `${META}clip_two`,
      `${META}broken_item`,
      `${META}dark_item`,
    ]);
    // broken_item (metadata request fails) and dark_item (no files) are dropped.
    expect(found).toHaveLength(2);
    expect(found[0]).toEqual({
      mediaKind: "video",
      title: "Popeye for President",
      description: "Popeye & Bluto run for office. Public domain cartoon.",
      pageUrl: "https://archive.org/details/Popeye_forPresident",
      // The MPEG4 derivative wins over the 512Kb copy, the Ogg derivative and the original MPEG2; the name is encoded.
      mediaUrl: "https://archive.org/download/Popeye_forPresident/Popeye%20for%20President.mp4",
      previewUrl: "https://archive.org/services/img/Popeye_forPresident",
      author: "Paramount Pictures",
      authorUrl: null,
      license: expect.objectContaining({
        id: "public_domain",
        url: "http://creativecommons.org/licenses/publicdomain/",
        confidence: "high",
        status: "clear",
        basis: "Internet Archive metadata (licenseurl)",
      }),
      width: 640,
      height: 480,
      duration: 370.3,
      bytes: 60123456,
      contentType: "video/mp4",
    });
  });

  it("prefers h.264, skips files over 400 MB, reads clock durations, joins creators and reports a missing license", async () => {
    const { ctx } = fakeContext(
      { response: { docs: [{ identifier: "clip_two" }] } },
      { clip_two: fixture("archive-meta-clip-two.json") },
    );

    const [clip] = await archiveConnector.search("clip", "video", 5, ctx);

    expect(clip?.mediaUrl).toBe("https://archive.org/download/clip_two/clip_two.ia.mp4");
    expect(clip?.bytes).toBe(12582912);
    expect(clip?.duration).toBe(90);
    expect(clip?.author).toBe("Jane Doe, John Roe");
    expect(clip?.description).toBe("A short clip & more");
    expect(clip?.license).toMatchObject({ id: "unknown", confidence: "none", status: "unknown" });
    expect(clip?.license.basis).toBe("Internet Archive item has no license field");
  });

  it("falls back to .ogv only when the item has no mp4, and drops items without a usable file", async () => {
    const { ctx } = fakeContext(fixture("archive-search-ogv.json"), {
      ogv_only: fixture("archive-meta-ogv-only.json"),
      mpeg_only: fixture("archive-meta-mpeg-only.json"),
    });

    const found = await archiveConnector.search("clip", "video", 5, ctx);

    expect(found.map((c) => c.mediaUrl)).toEqual([
      "https://archive.org/download/ogv_only/clip.ogv",
    ]);
    expect(found[0]?.contentType).toBe("video/ogg");
    expect(found[0]?.license).toMatchObject({ id: "cc_by", confidence: "high" });
  });

  it("audio: picks the VBR MP3 derivative (not the original WAV, the 64Kbps copy or the Ogg)", async () => {
    const { ctx, requested } = fakeContext(fixture("archive-search-audio.json"), {
      podcast_one: fixture("archive-meta-audio.json"),
    });

    const [episode] = await archiveConnector.search("podcast", "audio", 3, ctx);

    expect(queryOf(requested)).toBe("(podcast) AND mediatype:(audio)");
    expect(episode?.mediaUrl).toBe("https://archive.org/download/podcast_one/ep%201.mp3");
    expect(episode?.duration).toBe(1800.5);
    expect(episode?.contentType).toBe("audio/mpeg");
    expect(episode?.license).toMatchObject({ id: "cc_by_sa", confidence: "high" });
  });

  it("picture: picks the original JPEG, never a thumbnail or item tile", async () => {
    const { ctx, requested } = fakeContext(fixture("archive-search-image.json"), {
      photo_one: fixture("archive-meta-image.json"),
    });

    const [photo] = await archiveConnector.search("photo", "picture", 3, ctx);

    expect(queryOf(requested)).toBe("(photo) AND mediatype:(image)");
    expect(photo?.mediaUrl).toBe("https://archive.org/download/photo_one/photo_one.jpg");
    expect(photo).toMatchObject({ width: 4000, height: 3000, bytes: 2000000, duration: null });
  });

  it("keeps Lucene syntax in the user's words out of the query and does not search an empty one", async () => {
    const { ctx, requested } = fakeContext({ response: { docs: [] } });

    await archiveConnector.search('moon AND (landing) OR "x" collection:evil', "video", 3, ctx);
    const empty = await archiveConnector.search('()"', "video", 3, ctx);

    expect(queryOf(requested)).toBe(
      "(moon AND landing OR x collection evil) AND mediatype:(movies)",
    );
    expect(empty).toEqual([]);
    expect(requested).toHaveLength(1);
  });

  it("rejects an answer that is not an advancedsearch response", async () => {
    const { ctx } = fakeContext({ error: "nope" });
    await expect(archiveConnector.search("x", "video", 3, ctx)).rejects.toMatchObject({
      error: { code: "provider_error" },
    });
  });
});

describe("archiveConnector.describeUrl", () => {
  it("describes archive.org/details/<id> from /metadata/ and honors the kind", async () => {
    const { ctx, requested } = fakeContext(null, {
      Popeye_forPresident: fixture("archive-meta-popeye.json"),
    });

    const page = await archiveConnector.describeUrl?.(
      new URL("https://archive.org/details/Popeye_forPresident?tab=about"),
      "video",
      ctx,
    );
    const wrongKind = await archiveConnector.describeUrl?.(
      new URL("https://www.archive.org/details/Popeye_forPresident"),
      "audio",
      ctx,
    );

    expect(requested[0]).toBe(`${META}Popeye_forPresident`);
    expect(page?.title).toBe("Popeye for President");
    expect(page?.author).toBe("Paramount Pictures");
    expect(page?.license.id).toBe("public_domain");
    expect(page?.candidates.map((c) => c.mediaUrl)).toEqual([
      "https://archive.org/download/Popeye_forPresident/Popeye%20for%20President.mp4",
    ]);
    expect(wrongKind?.candidates).toEqual([]);
    expect(wrongKind?.notes.join(" ")).toContain("video");
  });

  it("leaves direct file URLs and other pages to the generic path", async () => {
    const { ctx, requested } = fakeContext(null);
    for (const url of [
      "https://archive.org/download/Popeye_forPresident/Popeye_forPresident.ogv",
      "https://archive.org/search?query=popeye",
      "https://archive.org/",
      "https://example.com/details/Popeye_forPresident",
    ]) {
      expect(await archiveConnector.describeUrl?.(new URL(url), undefined, ctx)).toBeNull();
    }
    expect(requested).toEqual([]);
  });

  it("reports an unknown item as unavailable", async () => {
    const { ctx } = fakeContext(null, { nope: {} });
    await expect(
      archiveConnector.describeUrl?.(new URL("https://archive.org/details/nope"), undefined, ctx),
    ).rejects.toMatchObject({ error: { code: "unavailable" } });
  });
});
