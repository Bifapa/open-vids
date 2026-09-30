// @vitest-environment node
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { inspectHtml, inspectPage } from "./pageInspector.js";
import type { FetchedPage, ResearchHttp } from "./types.js";

function html(name: string): string {
  return readFileSync(fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url)), "utf8");
}

const PAGE = "https://example.org/clip/1";

describe("inspectHtml: media", () => {
  const result = inspectHtml(html("page-video.html"), PAGE);

  it("lists video, then audio, then pictures, resolved against <base href>, de-duplicated", () => {
    expect(result.candidates.map((c) => [c.mediaKind, c.mediaUrl])).toEqual([
      ["video", "https://cdn.example.org/v/sunrise.mp4"],
      ["video", "https://cdn.example.org/media/sunrise.webm"],
      ["video", "https://cdn.example.org/media/files/sunrise.mov"],
      ["audio", "https://cdn.example.org/a/birds.mp3"],
      ["picture", "https://cdn.example.org/img/poster.jpg"],
    ]);
  });

  it("reads dimensions, duration, content type and preview of the declared media", () => {
    const [og, webm] = result.candidates;
    expect(og).toMatchObject({
      width: 1920,
      height: 1080,
      duration: 42,
      contentType: "video/mp4",
      previewUrl: "https://cdn.example.org/img/poster.jpg",
      pageUrl: PAGE,
      bytes: null,
    });
    expect(webm).toMatchObject({
      width: 640,
      height: 360,
      contentType: "video/webm",
      previewUrl: "https://cdn.example.org/media/poster2.jpg",
    });
    expect(result.candidates[4]).toMatchObject({ width: 1280, height: 720, previewUrl: null });
  });

  it("skips HLS manifests and says so; does not use plain <img> when other media exists", () => {
    expect(result.candidates.some((c) => c.mediaUrl.includes("m3u8"))).toBe(false);
    expect(result.candidates.some((c) => c.mediaUrl.includes("not-used"))).toBe(false);
    expect(result.notes).toEqual(["Streamed media (HLS/DASH) is not downloaded."]);
  });

  it("takes title, cleaned description and the page-level author/license from the page", () => {
    expect(result.title).toBe("Sunrise over the bay");
    expect(result.author).toBe("Ada Lovelace");
    // rel=license beats JSON-LD (CC BY-SA) and the "public domain" string inside a script.
    expect(result.license).toMatchObject({
      id: "cc_by",
      url: "https://creativecommons.org/licenses/by/4.0/",
      confidence: "medium",
      basis: "rel=license link on the page",
    });
    for (const candidate of result.candidates) {
      expect(candidate).toMatchObject({
        title: "Sunrise over the bay",
        description: "Timelapse of a sunrise",
        author: "Ada Lovelace",
        license: result.license,
      });
    }
  });

  it("filters by kind and reports when nothing of that kind is there", () => {
    expect(
      inspectHtml(html("page-video.html"), PAGE, "audio").candidates.map((c) => c.mediaUrl),
    ).toEqual(["https://cdn.example.org/a/birds.mp3"]);
    const pictures = inspectHtml(html("page-video.html"), PAGE, "picture");
    // With kind=picture the plain <img> is considered too (900 px wide, no icon-like URL).
    expect(pictures.candidates.map((c) => c.mediaUrl)).toEqual([
      "https://cdn.example.org/img/poster.jpg",
      "https://cdn.example.org/photos/not-used-when-other-media-exists.jpg",
    ]);
    const none = inspectHtml("<html><body><p>hello</p></body></html>", PAGE, "video");
    expect(none.candidates).toEqual([]);
    expect(none.notes).toEqual(["No video file found on the page."]);
  });

  it("does not take an og:video embed page for a file, but does when a media type is declared", () => {
    const embed = `<meta property="og:video" content="https://www.youtube.com/embed/abc">`;
    expect(inspectHtml(`<head>${embed}</head>`, PAGE).candidates).toEqual([]);
    const typed = inspectHtml(
      `<head>${embed}<meta property="og:video:type" content="video/mp4"></head>`,
      PAGE,
    );
    expect(typed.candidates.map((c) => c.mediaUrl)).toEqual(["https://www.youtube.com/embed/abc"]);
    const flash = inspectHtml(
      `<head>${embed}<meta property="og:video:type" content="application/x-shockwave-flash"></head>`,
      PAGE,
    );
    expect(flash.candidates).toEqual([]);
  });
});

describe("inspectHtml: pictures", () => {
  const photos = html("page-photos.html");
  const pageUrl = "https://example.org/gallery/index.html";

  it("keeps real photos and drops icons, logos, tiny, banner-thin, svg, data: and tracking images", () => {
    const result = inspectHtml(photos, pageUrl, "picture");
    expect(result.candidates.map((c) => c.mediaUrl)).toEqual([
      "https://example.org/photos/cat.jpg",
      "https://example.org/gallery/dog.jpg",
    ]);
    expect(result.candidates[0]).toMatchObject({ width: 800, height: 600, title: "Cats & dogs" });
    expect(result.author).toBe("Jane Roe");
  });

  it("uses <img> with no kind when the page has no other media, never for other kinds", () => {
    expect(inspectHtml(photos, pageUrl).candidates).toHaveLength(2);
    const video = inspectHtml(photos, pageUrl, "video");
    expect(video.candidates).toEqual([]);
  });
});

describe("inspectHtml: license and author", () => {
  const licenseOf = (body: string, head = "") =>
    inspectHtml(`<html><head>${head}</head><body>${body}</body></html>`, PAGE).license;

  it("reads a machine-readable JSON-LD license (string or object) with medium confidence", () => {
    const ld = (license: string) =>
      `<script type="application/ld+json">{"@type":"ImageObject","license":${license}}</script>`;
    expect(licenseOf("", ld('"https://creativecommons.org/publicdomain/zero/1.0/"'))).toMatchObject(
      {
        id: "cc0",
        confidence: "medium",
        status: "clear",
        basis: "JSON-LD license",
      },
    );
    expect(
      licenseOf(
        "",
        ld('{"@type":"CreativeWork","url":"https://creativecommons.org/licenses/by-nc/4.0/"}'),
      ),
    ).toMatchObject({
      id: "cc_by_nc",
      confidence: "medium",
    });
  });

  it("treats a rel=license link to a custom terms page as a restricted license, medium confidence", () => {
    expect(licenseOf(`<a rel="license noopener" href="/terms">Terms</a>`)).toMatchObject({
      id: "other",
      url: "https://example.org/terms",
      confidence: "medium",
      status: "restricted",
    });
  });

  it("a plain creativecommons.org license link is only low confidence; the site root is not a license", () => {
    expect(
      licenseOf(
        `<footer><a href="https://creativecommons.org/licenses/by-sa/3.0/">CC</a></footer>`,
      ),
    ).toMatchObject({
      id: "cc_by_sa",
      confidence: "low",
      basis: "creativecommons.org link on the page",
    });
    expect(licenseOf(`<a href="https://creativecommons.org/">Creative Commons</a>`)).toMatchObject({
      id: "unknown",
      confidence: "none",
    });
  });

  it("a text mention is low confidence; nothing is unknown", () => {
    expect(licenseOf("<p>This photo is in the Public Domain.</p>")).toMatchObject({
      id: "public_domain",
      confidence: "low",
      basis: "text mention",
    });
    expect(licenseOf("<p>CC0 dedication</p>")).toMatchObject({ id: "cc0", confidence: "low" });
    expect(licenseOf("<p>Nothing here.</p>")).toMatchObject({
      id: "unknown",
      confidence: "none",
      basis: "No license information found on the page",
    });
  });

  it("finds the author in JSON-LD, <meta name=author>, rel=author and byline order", () => {
    const author = (body: string, head = "") =>
      inspectHtml(`<html><head>${head}</head><body>${body}</body></html>`, PAGE).author;
    expect(
      author(
        "",
        `<script type="application/ld+json">{"creator":[{"name":"A One"},"B Two"]}</script><meta name="author" content="Meta Person">`,
      ),
    ).toBe("A One, B Two");
    expect(
      author(
        `<span class="byline">By Byline Person</span>`,
        `<meta name="author" content="Meta Person">`,
      ),
    ).toBe("Meta Person");
    expect(
      author(`<a rel="author" href="/u/1"> Link  Person </a><span class="byline">Other</span>`),
    ).toBe("Link Person");
    expect(author(`<span itemprop="author">Micro Person</span>`)).toBe("Micro Person");
    expect(author("<p>none</p>")).toBeNull();
  });

  it("ignores broken JSON-LD", () => {
    expect(licenseOf("", `<script type="application/ld+json">{oops</script>`)).toMatchObject({
      id: "unknown",
    });
  });
});

function fakeHttp(page: FetchedPage): ResearchHttp {
  return {
    async getJson() {
      throw new Error("not used");
    },
    async getPage() {
      return page;
    },
  };
}

describe("inspectPage", () => {
  it("turns a direct media URL into one candidate with no license", async () => {
    const result = await inspectPage(
      "https://files.example.org/a/My_Clip-final.MP4",
      undefined,
      fakeHttp({
        kind: "media",
        finalUrl: "https://files.example.org/a/My_Clip-final.MP4",
        contentType: "video/mp4; charset=binary",
        bytes: 1234,
        mediaKind: "video",
      }),
    );
    expect(result.finalUrl).toBe("https://files.example.org/a/My_Clip-final.MP4");
    expect(result.candidates).toEqual([
      expect.objectContaining({
        mediaKind: "video",
        title: "My Clip-final",
        mediaUrl: "https://files.example.org/a/My_Clip-final.MP4",
        bytes: 1234,
        contentType: "video/mp4",
        author: null,
        license: expect.objectContaining({
          id: "unknown",
          confidence: "none",
          basis: "Direct media URL: no license information",
        }),
      }),
    ]);
  });

  it("offers nothing when a direct media URL is of another kind than asked, or a stream", async () => {
    const audio = await inspectPage(
      "https://files.example.org/a.mp3",
      "video",
      fakeHttp({
        kind: "media",
        finalUrl: "https://files.example.org/a.mp3",
        contentType: "audio/mpeg",
        bytes: null,
        mediaKind: "audio",
      }),
    );
    expect(audio.candidates).toEqual([]);
    expect(audio.notes.join(" ")).toContain("audio");
    const stream = await inspectPage(
      "https://files.example.org/live.m3u8",
      undefined,
      fakeHttp({
        kind: "media",
        finalUrl: "https://files.example.org/live.m3u8",
        contentType: "application/vnd.apple.mpegurl",
        bytes: null,
        mediaKind: "video",
      }),
    );
    expect(stream.candidates).toEqual([]);
    expect(stream.notes).toEqual(["Streamed media (HLS/DASH) is not downloaded."]);
  });

  it("inspects HTML against the final URL after redirects", async () => {
    const result = await inspectPage(
      "https://short.example/x",
      "video",
      fakeHttp({
        kind: "html",
        finalUrl: "https://www.example.org/watch/7",
        html: `<video src="clip.mp4"></video>`,
      }),
    );
    expect(result.finalUrl).toBe("https://www.example.org/watch/7");
    expect(result.candidates.map((c) => [c.mediaUrl, c.pageUrl])).toEqual([
      ["https://www.example.org/watch/clip.mp4", "https://www.example.org/watch/7"],
    ]);
  });

  it("refuses a URL that is neither a page nor media", async () => {
    await expect(
      inspectPage(
        "https://example.org/data.json",
        undefined,
        fakeHttp({
          kind: "other",
          finalUrl: "https://example.org/data.json",
          contentType: "application/json",
        }),
      ),
    ).rejects.toMatchObject({ error: { code: "not_media" } });
  });
});
