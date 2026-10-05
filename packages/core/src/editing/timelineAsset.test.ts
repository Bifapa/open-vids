import { parseHTML } from "linkedom";
import { describe, expect, it } from "vitest";
import {
  buildTimelineAssetInsertHtml,
  fitTimelineAssetGeometry,
  getTimelineAssetKind,
  insertTimelineAssetIntoSource,
  resolveTimelineAssetSrc,
} from "./timelineAsset.js";

describe("getTimelineAssetKind", () => {
  it("detects image, video, and audio assets", () => {
    expect(getTimelineAssetKind("assets/photo.png")).toBe("image");
    expect(getTimelineAssetKind("assets/clip.mp4")).toBe("video");
    expect(getTimelineAssetKind("assets/clip.mov")).toBe("video");
    expect(getTimelineAssetKind("assets/music.mp3")).toBe("audio");
    expect(getTimelineAssetKind("assets/music.wav")).toBe("audio");
  });

  it("classifies svg as image", () => {
    expect(getTimelineAssetKind("assets/logo.svg")).toBe("image");
    expect(getTimelineAssetKind("assets/ICON.SVG")).toBe("image");
  });

  it("classifies avif and webp as image", () => {
    expect(getTimelineAssetKind("assets/photo.avif")).toBe("image");
    expect(getTimelineAssetKind("assets/photo.webp")).toBe("image");
  });

  it("returns null for unknown extensions", () => {
    expect(getTimelineAssetKind("assets/data.json")).toBeNull();
    expect(getTimelineAssetKind("assets/font.woff2")).toBeNull();
  });
});

describe("buildTimelineAssetInsertHtml", () => {
  it("builds an image clip with explicit timing and track", () => {
    const html = buildTimelineAssetInsertHtml({
      id: "photo_asset",
      hfId: "hf-abc123",
      assetPath: "assets/photo.png",
      kind: "image",
      start: 1.25,
      duration: 3,
      track: 2,
      zIndex: 4,
      geometry: { left: 0, top: 0, width: 1280, height: 720 },
    });

    expect(html).toContain('img id="photo_asset"');
    expect(html).toContain("left: 0px");
    expect(html).toContain("width: 1280px");
    expect(html).not.toContain("inset:");
  });

  it("builds an audio clip without visual layout styles", () => {
    const html = buildTimelineAssetInsertHtml({
      id: "music_asset",
      hfId: "hf-xyz789",
      assetPath: "assets/music.wav",
      kind: "audio",
      start: 0.5,
      duration: 5,
      track: 0,
      zIndex: 1,
    });
    expect(html).toContain("<audio");
    expect(html).not.toContain("object-fit");
  });
});

describe("resolveTimelineAssetSrc", () => {
  it("keeps project-root asset paths for index.html", () => {
    expect(resolveTimelineAssetSrc("index.html", "assets/photo.png")).toBe("assets/photo.png");
  });

  it("rewrites asset paths relative to sub-compositions", () => {
    expect(resolveTimelineAssetSrc("compositions/scene-a.html", "assets/photo.png")).toBe(
      "../assets/photo.png",
    );
  });
});

describe("insertTimelineAssetIntoSource", () => {
  it("appends the new asset inside the root composition", () => {
    const source = `<!doctype html><html><body><div id="root" data-composition-id="main"></div></body></html>`;
    const html = insertTimelineAssetIntoSource(
      source,
      '<img id="photo_asset" data-start="0" data-duration="3" />',
    );

    expect(html).toContain('data-composition-id="main">');
    expect(html).toContain('<img id="photo_asset" data-start="0" data-duration="3" />');
  });

  const CLIP = '<img id="photo_asset" data-start="0" data-duration="3" />';

  it("does not splice into a root attribute value that contains '>'", () => {
    const source = `<body><div data-composition-id="main" data-note="x>y" data-duration="5"></div></body>`;
    const html = insertTimelineAssetIntoSource(source, CLIP);
    expect(html).toContain(`data-note="x>y" data-duration="5">\n  ${CLIP}</div>`);
  });

  it("ignores a commented-out composition root", () => {
    const source = `<body><!-- <div data-composition-id="old"> --><div data-composition-id="main"></div></body>`;
    const html = insertTimelineAssetIntoSource(source, CLIP);
    expect(html.indexOf(CLIP)).toBeGreaterThan(html.indexOf("-->"));
    expect(html).toContain(`<div data-composition-id="main">\n  ${CLIP}`);
  });

  it("ignores a root-like tag inside a script", () => {
    const source = `<script>const t = '<div data-composition-id="fake">';</script><div data-composition-id="main"></div>`;
    const html = insertTimelineAssetIntoSource(source, CLIP);
    expect(html).toContain(`<div data-composition-id="main">\n  ${CLIP}`);
  });

  it("accepts single-quoted and unquoted data-composition-id", () => {
    expect(insertTimelineAssetIntoSource(`<div data-composition-id='main'></div>`, CLIP)).toContain(
      CLIP,
    );
    expect(insertTimelineAssetIntoSource(`<div data-composition-id=main></div>`, CLIP)).toContain(
      CLIP,
    );
  });

  it("throws when no root exists", () => {
    expect(() => insertTimelineAssetIntoSource(`<div id="x"></div>`, CLIP)).toThrow(
      "No composition root found",
    );
  });

  it("finds the root inside the standard <template> sub-composition layout", () => {
    const source = `<template id="sub-template">\n  <div data-composition-id="sub" data-duration="2"></div>\n</template>`;
    const html = insertTimelineAssetIntoSource(source, CLIP);
    expect(html).toContain(
      `<div data-composition-id="sub" data-duration="2">\n    ${CLIP}</div>\n</template>`,
    );
    expect(html.indexOf(CLIP)).toBeLessThan(html.indexOf("</template>"));
  });

  it("prefers a root outside templates over one inside a template", () => {
    const source = `<template id="t"><div data-composition-id="inner"></div></template><div data-composition-id="main"></div>`;
    const html = insertTimelineAssetIntoSource(source, CLIP);
    expect(html).toContain(`<div data-composition-id="main">\n  ${CLIP}`);
    expect(html).toContain(`<div data-composition-id="inner"></div>`);
  });
});

describe("buildTimelineAssetInsertHtml — video audio", () => {
  const base = {
    id: "clip_asset",
    hfId: "hf-vid-1",
    assetPath: "assets/clip.mp4",
    kind: "video" as const,
    start: 0,
    duration: 8,
    track: 1,
    zIndex: 2,
  };

  it("inserts a video muted when nothing says it carries audio", () => {
    const html = buildTimelineAssetInsertHtml(base);
    expect(html).toContain(" muted ");
    expect(html).not.toContain("data-has-audio");
  });

  it("inserts a video with an audio stream audible: data-has-audio and no muted", () => {
    const html = buildTimelineAssetInsertHtml({ ...base, hasAudio: true });
    expect(html).toContain('data-has-audio="true"');
    expect(html).not.toContain("muted");
    expect(html).toContain("playsinline");
  });

  it("keeps a video without an audio stream muted", () => {
    const html = buildTimelineAssetInsertHtml({ ...base, hasAudio: false });
    expect(html).toContain(" muted ");
    expect(html).not.toContain("data-has-audio");
  });
});

describe("buildTimelineAssetInsertHtml markup quality", () => {
  const base = {
    id: "clip_1",
    hfId: "hf-test-1",
    assetPath: "assets/a.mp4",
    start: 1,
    duration: 4,
    track: 2,
    zIndex: 3,
  };

  it("stamps data-hf-id on all kinds", () => {
    for (const kind of ["image", "video", "audio"] as const) {
      expect(buildTimelineAssetInsertHtml({ ...base, kind })).toContain('data-hf-id="hf-test-1"');
    }
  });

  it("audio gets an explicit data-volume", () => {
    expect(buildTimelineAssetInsertHtml({ ...base, kind: "audio" })).toContain('data-volume="1"');
  });
});

describe("fitTimelineAssetGeometry", () => {
  const comp = { width: 1920, height: 1080 };

  it("centers a smaller-than-comp asset at natural size", () => {
    expect(fitTimelineAssetGeometry({ width: 640, height: 360 }, comp)).toEqual({
      left: 640,
      top: 360,
      width: 640,
      height: 360,
    });
  });

  it("scales an oversized asset down to fit, preserving aspect, centered", () => {
    // 4000x1000 → capped to 1920 wide → 1920x480, centered vertically
    expect(fitTimelineAssetGeometry({ width: 4000, height: 1000 }, comp)).toEqual({
      left: 0,
      top: 300,
      width: 1920,
      height: 480,
    });
  });

  it("falls back to full-frame when natural size is unknown", () => {
    expect(fitTimelineAssetGeometry(null, comp)).toEqual({
      left: 0,
      top: 0,
      width: 1920,
      height: 1080,
    });
  });
});

describe("buildTimelineAssetInsertHtml — media options", () => {
  const base = {
    id: "clip_1",
    hfId: "hf-opt-1",
    assetPath: "assets/a.mp4",
    start: 0,
    duration: 4,
    track: 0,
    zIndex: 1,
  };

  it("writes fit, media in-point and volume on video", () => {
    const html = buildTimelineAssetInsertHtml({
      ...base,
      kind: "video",
      hasAudio: true,
      fit: "cover",
      mediaStart: 2.5,
      volume: 0.5,
    });
    expect(html).toContain("object-fit: cover");
    expect(html).toContain('data-media-start="2.5"');
    expect(html).toContain('data-volume="0.5"');
    expect(html).toContain('data-has-audio="true"');
  });

  it("muted wins over hasAudio (no data-has-audio next to muted)", () => {
    const html = buildTimelineAssetInsertHtml({
      ...base,
      kind: "video",
      hasAudio: true,
      muted: true,
    });
    expect(html).toContain(" muted");
    expect(html).not.toContain("data-has-audio");
  });

  it("audio honours volume, mediaStart and muted", () => {
    const html = buildTimelineAssetInsertHtml({
      ...base,
      kind: "audio",
      volume: 0.3,
      mediaStart: 1,
      muted: true,
    });
    expect(html).toContain('data-volume="0.3"');
    expect(html).toContain('data-media-start="1"');
    expect(html).toContain(" muted");
  });
});

describe("buildTimelineAssetInsertHtml — fades", () => {
  const base = {
    id: "clip_1",
    hfId: "hf-fade-1",
    assetPath: "assets/a.mp4",
    start: 0,
    duration: 4,
    track: 0,
    zIndex: 1,
  };

  it("writes data-fade-in / data-fade-out on video and audio, omitting zero", () => {
    for (const kind of ["video", "audio"] as const) {
      const html = buildTimelineAssetInsertHtml({ ...base, kind, fadeIn: 0.5, fadeOut: 0 });
      expect(html).toContain('data-fade-in="0.5"');
      expect(html).not.toContain("data-fade-out");
    }
  });

  it("leaves images alone", () => {
    expect(buildTimelineAssetInsertHtml({ ...base, kind: "image", fadeIn: 1 })).not.toContain(
      "data-fade",
    );
  });
});

describe("buildTimelineAssetInsertHtml — extra attributes", () => {
  const base = {
    id: "clip_1",
    hfId: "hf-attr-1",
    assetPath: "assets/a.mp4",
    start: 0,
    duration: 4,
    track: 0,
    zIndex: 1,
  };

  it("writes them on the element of every kind, escaping quotes", () => {
    for (const kind of ["image", "video", "audio"] as const) {
      const html = buildTimelineAssetInsertHtml({
        ...base,
        kind,
        attributes: { "data-ov-story-node": "chapter-1", "data-ov-turn": 'a"b' },
      });
      expect(html).toContain('data-ov-story-node="chapter-1"');
      expect(html).toContain('data-ov-turn="a&quot;b"');
    }
  });

  it("writes nothing extra without them", () => {
    expect(buildTimelineAssetInsertHtml({ ...base, kind: "video" })).not.toContain("data-ov-");
  });
});

describe("buildTimelineAssetInsertHtml — file names that are not URL-safe", () => {
  const base = {
    id: "clip_1",
    hfId: "hf-name-1",
    start: 0,
    duration: 4,
    track: 0,
    zIndex: 1,
  };

  function clipOf(assetPath: string, kind: "image" | "video" | "audio") {
    const { document } = parseHTML(
      `<div id="root">${buildTimelineAssetInsertHtml({ ...base, assetPath, kind })}</div>`,
    );
    const root = document.getElementById("root");
    const clip = root?.firstElementChild;
    if (!root || !clip) throw new Error("clip was not written");
    return { root, clip };
  }

  it("keeps a name that closes the attribute from adding attributes to the element", () => {
    const name = 'assets/clip" onerror="alert(document.domain)" x=".mp4';
    for (const kind of ["image", "video", "audio"] as const) {
      const { root, clip } = clipOf(name, kind);
      expect(root.children.length).toBe(1);
      expect(clip.hasAttribute("onerror")).toBe(false);
      expect(clip.hasAttribute("x")).toBe(false);
      expect(decodeURIComponent(clip.getAttribute("src") ?? "")).toBe(name);
    }
  });

  it("keeps a name that closes the tag from injecting markup", () => {
    const { root, clip } = clipOf('assets/"><script>alert(1)</script>.mp4', "video");
    expect(root.querySelector("script")).toBeNull();
    expect(decodeURIComponent(clip.getAttribute("src") ?? "")).toBe(
      'assets/"><script>alert(1)</script>.mp4',
    );
  });

  it("round-trips #, ?, %, spaces and quotes through the src attribute", () => {
    const names = [
      "assets/a b#1.mp4",
      "assets/what?.mp4",
      "assets/100%.mp4",
      'assets/it\'s "x" (1).mp4',
      "assets/测试 &amp;.mp4",
    ];
    for (const name of names) {
      const src = clipOf(name, "video").clip.getAttribute("src") ?? "";
      expect(src).not.toMatch(/[ "#?'()&<>]/);
      expect(src.split("/")).toHaveLength(2);
      expect(decodeURIComponent(src)).toBe(name);
    }
  });

  it("leaves a plain path as written", () => {
    expect(clipOf("../assets/photo-1.png", "image").clip.getAttribute("src")).toBe(
      "../assets/photo-1.png",
    );
  });
});
