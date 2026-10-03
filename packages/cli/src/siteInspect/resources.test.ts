import { describe, expect, it } from "vitest";
import { parseRawResources } from "./rawPage.js";
import {
  classifyResource,
  looksLikeLottie,
  mergeResources,
  resourceKey,
  type CollectedResource,
} from "./resources.js";

const dom = (
  url: string,
  kind: CollectedResource["kind"],
  extra: Partial<CollectedResource> = {},
) => ({
  url,
  kind,
  width: null,
  height: null,
  duration: null,
  usage: "",
  ...extra,
});

const net = (
  url: string,
  kind: CollectedResource["kind"],
  extra: Partial<CollectedResource> = {},
): CollectedResource => ({
  url,
  kind,
  mimeType: null,
  bytes: null,
  width: null,
  height: null,
  duration: null,
  usage: "",
  ...extra,
});

describe("classifyResource", () => {
  it("reads the kind from the response's mime type first", () => {
    expect(classifyResource({ url: "https://x.test/a", mimeType: "image/png" })).toBe("image");
    expect(classifyResource({ url: "https://x.test/a", mimeType: "image/svg+xml" })).toBe("svg");
    expect(classifyResource({ url: "https://x.test/a", mimeType: "video/mp4" })).toBe("video");
    expect(classifyResource({ url: "https://x.test/a", mimeType: "audio/mpeg" })).toBe("audio");
    expect(classifyResource({ url: "https://x.test/a", mimeType: "font/woff2" })).toBe("font");
    expect(classifyResource({ url: "https://x.test/a", mimeType: "text/css" })).toBe("stylesheet");
    expect(classifyResource({ url: "https://x.test/a", mimeType: "text/javascript" })).toBe(
      "script",
    );
    expect(classifyResource({ url: "https://x.test/a", mimeType: "text/html" })).toBe("document");
    expect(classifyResource({ url: "https://x.test/a", mimeType: "application/json" })).toBe(
      "data",
    );
  });

  it("lets the element that used the file win over an unknown or generic type", () => {
    // A Lottie player's JSON is data by mime type; the element knows it is an animation.
    expect(
      classifyResource({
        url: "https://x.test/anim.json",
        mimeType: "application/json",
        hint: "animation",
      }),
    ).toBe("animation");
    expect(
      classifyResource({
        url: "https://x.test/anim.riv",
        mimeType: "application/octet-stream",
        hint: "animation",
      }),
    ).toBe("animation");
    expect(classifyResource({ url: "https://x.test/clip", mimeType: null, hint: "video" })).toBe(
      "video",
    );
  });

  it("falls back to the CDP resource type and then the file's extension", () => {
    expect(
      classifyResource({ url: "https://x.test/media", mimeType: null, networkType: "media" }),
    ).toBe("video");
    expect(
      classifyResource({ url: "https://x.test/style", mimeType: null, networkType: "stylesheet" }),
    ).toBe("stylesheet");
    expect(classifyResource({ url: "https://x.test/font.woff2", mimeType: null })).toBe("font");
    expect(classifyResource({ url: "https://x.test/app.js?v=2", mimeType: null })).toBe("script");
    expect(classifyResource({ url: "https://x.test/sprite.svg#icon", mimeType: null })).toBe("svg");
    expect(classifyResource({ url: "https://x.test/thing", mimeType: null })).toBe("other");
  });
});

describe("looksLikeLottie", () => {
  it("recognizes a Lottie animation by its version, frame rate and layers", () => {
    expect(looksLikeLottie('{"v":"5.7.4","fr":30,"layers":[{"ty":4}]}')).toBe(true);
    expect(looksLikeLottie('{"v":5,"fr":29.97,"layers":[]}')).toBe(true);
  });

  it("refuses other JSON, arrays and broken text", () => {
    expect(looksLikeLottie('{"v":"5.7.4","layers":[]}')).toBe(false);
    expect(looksLikeLottie('{"fr":30,"layers":[]}')).toBe(false);
    expect(looksLikeLottie('{"v":"5.7.4","fr":30}')).toBe(false);
    expect(looksLikeLottie('[{"v":"5.7.4","fr":30,"layers":[]}]')).toBe(false);
    expect(looksLikeLottie("not json")).toBe(false);
  });
});

describe("mergeResources", () => {
  it("keeps one entry per URL, fragment aside: the DOM's usage and the response's type and size", () => {
    const merged = mergeResources(
      [
        dom("https://x.test/hero.png#top", "image", {
          width: 1200,
          height: 600,
          usage: "img in #hero",
        }),
      ],
      [net("https://x.test/hero.png", "image", { mimeType: "image/png", bytes: 40_000 })],
      10,
    );
    expect(merged).toEqual([
      {
        url: "https://x.test/hero.png#top",
        kind: "image",
        mimeType: "image/png",
        bytes: 40_000,
        width: 1200,
        height: 600,
        duration: null,
        usage: "img in #hero",
      },
    ]);
  });

  it("orders visible media first, then fonts, styles and scripts, stable inside a kind", () => {
    const merged = mergeResources(
      [
        dom("https://x.test/a.css", "stylesheet", { usage: "stylesheet" }),
        dom("https://x.test/b.png", "image", { usage: "img" }),
        dom("https://x.test/c.mp4", "video", { usage: "video" }),
        dom("https://x.test/d.png", "image", { usage: "img" }),
      ],
      [net("https://x.test/e.js", "script"), net("https://x.test/f.woff2", "font")],
      10,
    );
    expect(merged.map((entry) => entry.url)).toEqual([
      "https://x.test/c.mp4",
      "https://x.test/b.png",
      "https://x.test/d.png",
      "https://x.test/f.woff2",
      "https://x.test/a.css",
      "https://x.test/e.js",
    ]);
  });

  it("upgrades a generic kind with what the response turned out to be, and caps the list", () => {
    const merged = mergeResources(
      [dom("https://x.test/anim", "data", { usage: "animation player" })],
      [net("https://x.test/anim", "animation", { mimeType: "application/json" })],
      10,
    );
    expect(merged).toEqual([
      expect.objectContaining({ kind: "animation", usage: "animation player" }),
    ]);
    // An `<img>` whose response is image/svg+xml is an SVG, whatever the element looked like.
    expect(
      mergeResources(
        [dom("https://x.test/logo.svg", "image", { usage: "img in .nav-logo" })],
        [net("https://x.test/logo.svg", "image", { mimeType: "image/svg+xml" })],
        10,
      ),
    ).toEqual([
      expect.objectContaining({
        kind: "svg",
        usage: "img in .nav-logo",
        mimeType: "image/svg+xml",
      }),
    ]);
    expect(
      mergeResources(
        [dom("https://x.test/a.png", "image"), dom("https://x.test/b.png", "image")],
        [],
        1,
      ).map((entry) => entry.url),
    ).toEqual(["https://x.test/a.png"]);
  });

  it("keys a URL without its fragment", () => {
    expect(resourceKey("https://x.test/a.svg#icon")).toBe("https://x.test/a.svg");
    expect(resourceKey("https://x.test/a.svg")).toBe("https://x.test/a.svg");
  });
});

describe("parseRawResources", () => {
  it("keeps usable references and drops what the page could not have produced", () => {
    const parsed = parseRawResources([
      { url: "https://x.test/a.png", kind: "image", width: 10, height: 20, usage: "img" },
      { url: "data:image/png;base64,AAAA", kind: "image", usage: "inline" },
      { url: "https://x.test/b.json", kind: "nonsense", usage: "?" },
      { url: 42, kind: "image" },
      { url: "https://x.test/c.mp4", kind: "video", duration: 12.5 },
    ]);
    expect(parsed).toEqual([
      {
        url: "https://x.test/a.png",
        kind: "image",
        width: 10,
        height: 20,
        duration: null,
        usage: "img",
      },
      {
        url: "https://x.test/c.mp4",
        kind: "video",
        width: null,
        height: null,
        duration: 12.5,
        usage: "",
      },
    ]);
    expect(parseRawResources("not a list")).toEqual([]);
  });
});
