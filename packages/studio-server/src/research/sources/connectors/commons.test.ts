// @vitest-environment node
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { isResearchFailure } from "../../errors.js";
import type { ConnectorContext, ResearchHttp } from "../types.js";
import { commonsConnector } from "./commons.js";

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
      throw new Error("the Commons connector must not read pages");
    },
  };
  return {
    ctx: {
      http,
      webSearch: { search: async () => [] },
      domains: ["commons.wikimedia.org", "upload.wikimedia.org"],
    },
    requested,
  };
}

describe("commonsConnector.search — videos", () => {
  it("asks the API for video derivatives with the query kept in gsrsearch only", async () => {
    const { ctx, requested } = fakeContext(fixture("commons-video.json"));
    await commonsConnector.search("volcano & lava", "video", 4, ctx);
    expect(requested).toHaveLength(1);
    const url = requested[0];
    expect(url?.origin + url?.pathname).toBe("https://commons.wikimedia.org/w/api.php");
    const params = url?.searchParams;
    expect(params?.get("generator")).toBe("search");
    expect(params?.get("gsrnamespace")).toBe("6");
    expect(params?.get("gsrsearch")).toBe("volcano & lava filetype:video");
    expect(params?.get("gsrlimit")).toBe("4");
    expect(params?.get("prop")).toBe("imageinfo|videoinfo");
    expect(params?.get("iiurlwidth")).toBe("640");
    expect(params?.get("viprop")).toContain("derivatives");
    expect(params?.get("formatversion")).toBe("2");
    expect(url?.href.split("?")[0]).not.toContain("volcano");
  });

  it("keeps the search ranking and picks the best editor-readable rendition of each file", async () => {
    const { ctx } = fakeContext(fixture("commons-video.json"));
    const found = await commonsConnector.search("volcano", "video", 10, ctx);
    expect(found.map((c) => c.title)).toEqual([
      "007 Volcano eruption of Litli-Hrútur in Iceland in 2023 Video by Giles Laurent",
      "Volcan CM1",
      "Lava flow Kilauea",
      "Ash cloud 720p",
    ]);
    const [giles, volcan, lava, ash] = found;
    // 4K WebM original: the 1080p WebM transcode.
    expect(giles?.mediaUrl).toMatch(/\/transcoded\/5\/53\/.*\.1080p\.vp9\.webm$/);
    expect(giles).toMatchObject({
      contentType: "video/webm",
      width: 1920,
      height: 1080,
      bytes: null,
      duration: 23.837,
    });
    // MPEG original: never offered; the 1080p WebM transcode is.
    expect(volcan?.mediaUrl).toMatch(/Volcan_CM1\.mpg\.1080p\.vp9\.webm$/);
    // MP4 wins over a WebM of the same height, and never above 1080p (a 1440p MP4 exists).
    expect(lava?.mediaUrl).toMatch(/Lava_flow_Kilauea\.webm\.1080p\.h264\.mp4$/);
    expect(lava).toMatchObject({ contentType: "video/mp4", width: 1920, height: 1080 });
    // A 720p WebM original is used as it is: its real size is known and the tracking parameters are gone.
    expect(ash?.mediaUrl).toBe(
      "https://upload.wikimedia.org/wikipedia/commons/d/de/Ash_cloud_720p.webm",
    );
    expect(ash).toMatchObject({
      contentType: "video/webm",
      bytes: 9_100_000,
      width: 1280,
      height: 720,
      duration: 8.5,
    });
  });

  it("drops a file whose only version is an original the editor cannot read", async () => {
    const { ctx } = fakeContext(fixture("commons-video.json"));
    const found = await commonsConnector.search("volcano", "video", 10, ctx);
    expect(found.some((c) => c.title.includes("Eruption 4K"))).toBe(false);
  });

  it("maps license, author, description and page from extmetadata", async () => {
    const { ctx } = fakeContext(fixture("commons-video.json"));
    const [giles, volcan, lava, ash] = await commonsConnector.search("volcano", "video", 10, ctx);
    expect(giles?.license).toMatchObject({
      id: "cc_by_sa",
      name: "CC BY-SA 4.0",
      url: "https://creativecommons.org/licenses/by-sa/4.0",
      confidence: "high",
      status: "attribution",
      basis: "Wikimedia Commons API (extmetadata)",
    });
    expect(giles?.author).toBe("Giles Laurent");
    expect(giles?.authorUrl).toBe("https://commons.wikimedia.org/wiki/User:Giles_Laurent");
    expect(giles?.description).toBe(
      "Volcano eruption next to Litli-Hrútur in Iceland in 2023 & drone footage. Video recorded by Giles Laurent",
    );
    expect(giles?.pageUrl).toBe(
      "https://commons.wikimedia.org/wiki/File:007_Volcano_eruption_of_Litli-Hr%C3%BAtur_in_Iceland_in_2023_Video_by_Giles_Laurent.webm",
    );
    expect(giles?.previewUrl).toContain("https://thumb.wikimedia.org/");
    // A red link to a user page that does not exist is not an author page.
    expect(volcan?.author).toBe("EEPU.Mademoiselle");
    expect(volcan?.authorUrl).toBeNull();
    // A public-domain tag without a license URL: recognized, but only medium confidence; still clear.
    expect(lava?.license).toMatchObject({
      id: "public_domain",
      url: null,
      confidence: "medium",
      status: "clear",
    });
    expect(lava?.author).toBe("U.S. Geological Survey");
    // No license fields at all: nothing is assumed.
    expect(ash?.license).toMatchObject({ id: "unknown", confidence: "none", status: "unknown" });
    expect(ash?.author).toBeNull();
  });

  it("returns at most the requested number of results, in ranking order", async () => {
    const { ctx, requested } = fakeContext(fixture("commons-video.json"));
    const found = await commonsConnector.search("volcano", "video", 2, ctx);
    expect(requested[0]?.searchParams.get("gsrlimit")).toBe("2");
    expect(found.map((c) => c.title)).toEqual([
      "007 Volcano eruption of Litli-Hrútur in Iceland in 2023 Video by Giles Laurent",
      "Volcan CM1",
    ]);
  });

  it("drops results of another media kind than the one asked for", async () => {
    const { ctx } = fakeContext(fixture("commons-video.json"));
    expect(await commonsConnector.search("volcano", "picture", 10, ctx)).toEqual([]);
  });
});

describe("commonsConnector.search — pictures", () => {
  it("asks for 1920 px renderings of bitmaps only", async () => {
    const { ctx, requested } = fakeContext(fixture("commons-picture.json"));
    await commonsConnector.search("volcano", "picture", 5, ctx);
    const params = requested[0]?.searchParams;
    expect(params?.get("gsrsearch")).toBe("volcano filetype:bitmap");
    expect(params?.get("prop")).toBe("imageinfo");
    expect(params?.get("iiurlwidth")).toBe("1920");
    expect(params?.has("viprop")).toBe(false);
  });

  it("uses the original for web formats and the 1920 px rendering for everything else", async () => {
    const { ctx } = fakeContext(fixture("commons-picture.json"));
    const found = await commonsConnector.search("volcano", "picture", 10, ctx);
    expect(found.map((c) => c.title)).toEqual([
      "Tavurvur volcano edit",
      "Volcán de Ollagüe, Bolivia, 2016-02-03, DD 80-88 PAN",
      "Krakatoa 1883 lithograph",
      "Etna map",
    ]);
    const [jpg, panorama, tiff, svg] = found;
    expect(jpg).toMatchObject({
      mediaUrl: "https://upload.wikimedia.org/wikipedia/commons/e/e6/Tavurvur_volcano_edit.jpg",
      contentType: "image/jpeg",
      bytes: 3_262_652,
      width: 3844,
      height: 2544,
      duration: null,
    });
    // 174 megapixels: too big to decode comfortably, so the rendering is offered instead.
    expect(panorama?.mediaUrl).toContain("1920px-");
    expect(panorama).toMatchObject({
      contentType: "image/jpeg",
      bytes: null,
      width: 1920,
      height: 213,
    });
    expect(tiff?.mediaUrl).toContain("lossy-page1-1920px-Krakatoa_1883_lithograph.tif.jpg");
    expect(tiff).toMatchObject({ contentType: "image/jpeg", width: 1920, height: 1255 });
    expect(svg?.mediaUrl).toContain("1920px-Etna_map.svg.png");
    expect(svg).toMatchObject({ contentType: "image/png", mediaKind: "picture" });
  });

  it("drops a non-web picture that has no rendering", async () => {
    const { ctx } = fakeContext(fixture("commons-picture.json"));
    const found = await commonsConnector.search("volcano", "picture", 10, ctx);
    expect(found.some((c) => c.pageUrl?.includes("Vesuvius_scan"))).toBe(false);
  });

  it("turns author markup into text, decodes entities and derives titles and licenses", async () => {
    const { ctx } = fakeContext(fixture("commons-picture.json"));
    const [jpg, panorama, tiff, svg] = await commonsConnector.search("volcano", "picture", 10, ctx);
    expect(jpg?.author).toBe("Taro Taylor edit by Richard Bartz");
    expect(jpg?.authorUrl).toBe("https://www.flickr.com/photos/30674396@N00");
    expect(jpg?.license).toMatchObject({ id: "cc_by", name: "CC BY 2.0", confidence: "high" });
    expect(panorama?.author).toBe("Diego Delso");
    expect(tiff?.author).toBe("Parker & Coward");
    expect(tiff?.description).toBe("Lithograph of the 1883 eruption");
    expect(tiff?.license).toMatchObject({ id: "public_domain", status: "clear" });
    expect(svg?.license).toMatchObject({
      id: "cc0",
      name: "CC0 1.0",
      status: "clear",
      confidence: "high",
    });
  });
});

describe("commonsConnector.search — audio", () => {
  it("asks for audio without thumbnails", async () => {
    const { ctx, requested } = fakeContext(fixture("commons-audio.json"));
    await commonsConnector.search("thunder", "audio", 5, ctx);
    const params = requested[0]?.searchParams;
    expect(params?.get("gsrsearch")).toBe("thunder filetype:audio");
    expect(params?.has("iiurlwidth")).toBe(false);
    expect(params?.get("prop")).toBe("imageinfo|videoinfo");
  });

  it("offers the original, falls back to the MP3 transcode, and skips the file-type icon as a preview", async () => {
    const { ctx } = fakeContext(fixture("commons-audio.json"));
    const found = await commonsConnector.search("thunder", "audio", 10, ctx);
    expect(found.map((c) => c.title)).toEqual(["Thunder 01", "Thunder", "Storm theme"]);
    const [ogg, wav, midi] = found;
    expect(ogg).toMatchObject({
      mediaUrl: "https://upload.wikimedia.org/wikipedia/commons/f/fa/Thunder_01.ogg",
      contentType: "audio/ogg",
      bytes: 411_421,
      width: null,
      height: null,
      previewUrl: null,
    });
    expect(ogg?.duration).toBeCloseTo(9.044, 3);
    expect(wav).toMatchObject({ contentType: "audio/wav", bytes: 6_190_364 });
    expect(wav?.license).toMatchObject({ id: "cc0", status: "clear" });
    // MIDI cannot be edited with: the transcode is offered. A MIDI without a transcode is dropped.
    expect(midi?.mediaUrl).toMatch(/Storm_theme\.mid\.mp3$/);
    expect(midi?.contentType).toBe("audio/mpeg");
  });
});

describe("commonsConnector.search — failures", () => {
  it("returns nothing when the API finds nothing", async () => {
    const { ctx } = fakeContext(fixture("commons-empty.json"));
    expect(await commonsConnector.search("zzzz", "video", 5, ctx)).toEqual([]);
  });

  it("reports an API error as a provider error", async () => {
    const { ctx } = fakeContext({
      error: { code: "badvalue", info: "Unrecognized value for parameter." },
    });
    const failure = await commonsConnector
      .search("x", "video", 5, ctx)
      .catch((error: unknown) => error);
    expect(isResearchFailure(failure) && failure.error.code).toBe("provider_error");
  });
});

describe("commonsConnector.describeUrl", () => {
  const describeUrl = commonsConnector.describeUrl;
  if (!describeUrl) throw new Error("commonsConnector must implement describeUrl");

  it.each([
    ["https://upload.wikimedia.org/wikipedia/commons/e/e6/Tavurvur_volcano_edit.jpg"],
    ["https://commons.wikimedia.org/wiki/Category:Volcanoes"],
    ["https://commons.wikimedia.org/wiki/Main_Page"],
    ["https://commons.wikimedia.org/w/index.php?title=Category:Volcanoes"],
    ["https://en.wikipedia.org/wiki/File:Tavurvur_volcano_edit.jpg"],
    ["https://example.com/wiki/File:Tavurvur_volcano_edit.jpg"],
  ])("leaves %s to the generic inspector without any request", async (link) => {
    const { ctx, requested } = fakeContext(fixture("commons-file-page.json"));
    expect(await describeUrl(new URL(link), undefined, ctx)).toBeNull();
    expect(requested).toHaveLength(0);
  });

  it.each([
    ["https://commons.wikimedia.org/wiki/File:Tavurvur_volcano_edit.jpg"],
    [
      "https://commons.wikimedia.org/w/index.php?title=File:Tavurvur_volcano_edit.jpg&action=history",
    ],
    ["https://commons.wikimedia.org/wiki/File:Tavurvur%20volcano%20edit.jpg#filelinks"],
  ])("describes %s through a single titles query", async (link) => {
    const { ctx, requested } = fakeContext(fixture("commons-file-page.json"));
    const page = await describeUrl(new URL(link), undefined, ctx);
    expect(requested).toHaveLength(1);
    const params = requested[0]?.searchParams;
    expect(params?.get("titles")).toBe("File:Tavurvur volcano edit.jpg");
    expect(params?.has("generator")).toBe(false);
    expect(page).toMatchObject({
      title: "Tavurvur volcano edit",
      author: "Taro Taylor edit by Richard Bartz",
      notes: [],
    });
    expect(page?.license).toMatchObject({ id: "cc_by", confidence: "high" });
    expect(page?.candidates).toHaveLength(1);
    expect(page?.candidates[0]).toMatchObject({
      mediaKind: "picture",
      mediaUrl: "https://upload.wikimedia.org/wikipedia/commons/e/e6/Tavurvur_volcano_edit.jpg",
      pageUrl: "https://commons.wikimedia.org/wiki/File:Tavurvur_volcano_edit.jpg",
    });
  });

  it("derives a video's kind and rendition from the file itself", async () => {
    const { ctx } = fakeContext(fixture("commons-file-video.json"));
    const page = await describeUrl(
      new URL("https://commons.wikimedia.org/wiki/File:Lava_flow_Kilauea.webm"),
      "video",
      ctx,
    );
    expect(page?.candidates).toHaveLength(1);
    expect(page?.candidates[0]).toMatchObject({
      mediaKind: "video",
      contentType: "video/mp4",
      height: 1080,
      duration: 41.2,
    });
  });

  it("explains a file of another kind than the one asked for instead of returning it", async () => {
    const { ctx } = fakeContext(fixture("commons-file-page.json"));
    const page = await describeUrl(
      new URL("https://commons.wikimedia.org/wiki/File:Tavurvur_volcano_edit.jpg"),
      "video",
      ctx,
    );
    expect(page?.candidates).toEqual([]);
    expect(page?.notes.join(" ")).toMatch(/picture file, not a video/);
    expect(page?.title).toBe("Tavurvur volcano edit");
    expect(page?.license.id).toBe("cc_by");
  });

  it("says so when the file does not exist", async () => {
    const { ctx } = fakeContext(fixture("commons-file-missing.json"));
    const page = await describeUrl(
      new URL("https://commons.wikimedia.org/wiki/File:Nope.jpg"),
      undefined,
      ctx,
    );
    expect(page?.candidates).toEqual([]);
    expect(page?.license).toMatchObject({ id: "unknown", confidence: "none" });
    expect(page?.notes.join(" ")).toContain("File:Nope.jpg was not found");
  });
});
