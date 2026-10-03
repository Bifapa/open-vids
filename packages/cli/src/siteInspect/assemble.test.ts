import { describe, expect, it } from "vitest";
import { assembleStyle, displayFamily, fontMime, type CapturedFontFile } from "./assemble.js";
import { analyzeCss, type CssSheet } from "./cssAnalysis.js";
import type { RawFontUse, RawPage } from "./pageScript.js";

const bytes = (n: number) => new Uint8Array(n);

function raw(over: Partial<RawPage> = {}): RawPage {
  return {
    title: "Example",
    description: "",
    themeColor: null,
    language: "en",
    finalUrl: "https://www.example.com/en",
    pageBackground: "#ffffff",
    colors: [{ hex: "#ffffff", role: "background", count: 1 }],
    fonts: [],
    textStyles: [],
    radii: [],
    shadows: [],
    buttons: [],
    logos: [],
    icons: [],
    ogImage: null,
    headings: [],
    navLabels: [],
    motion: { durationsMs: [200], easings: ["ease"], properties: ["opacity"], animationNames: [] },
    googleFamilies: [],
    inlineCss: [],
    stylesheetUrls: [],
    visibleElements: 100,
    textLength: 2000,
    documentHeight: 3000,
    ...over,
  };
}

const use = (
  family: string,
  weight: number,
  count: number,
  extra: Partial<RawFontUse> = {},
): RawFontUse => ({
  family,
  weight,
  italic: false,
  count,
  heading: 0,
  code: 0,
  ...extra,
});

function assemble(over: Partial<RawPage>, css: CssSheet[] = [], files: CapturedFontFile[] = []) {
  return assembleStyle({
    requestedUrl: "https://example.com/",
    raw: raw(over),
    css: analyzeCss(css),
    tokenValues: [
      ["--color-brand", "#5e6ad2"],
      ["--empty", ""],
    ],
    fontFiles: new Map(files.map((file) => [file.url, file])),
    logos: [],
    resources: [],
    notes: [],
    now: 7,
  });
}

const FACE = (family: string, src: string, extra = "") =>
  `@font-face { font-family: "${family}"; src: url(${src}) format("woff2"); ${extra} }`;

describe("assembleStyle fonts", () => {
  it("reports a family linked from Google Fonts by name, with the stylesheet", () => {
    const { site, fontPicks } = assemble({
      fonts: [use("Space Grotesk", 500, 30, { heading: 20 }), use("Space Grotesk", 400, 10)],
      googleFamilies: ["Space Grotesk"],
      stylesheetUrls: ["https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@400;500"],
    });
    expect(site.fonts).toEqual([
      {
        family: "Space Grotesk",
        weights: [400, 500],
        source: "google",
        url: "https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@400;500",
        usedFor: ["heading", "body"],
      },
    ]);
    expect(fontPicks).toEqual([]);
  });

  it("treats a family whose files all sit on fonts.gstatic.com as Google, wherever the CSS came from", () => {
    const { site } = assemble({ fonts: [use("Roboto Flex", 400, 5)] }, [
      {
        baseUrl: "https://example.com/a.css",
        text: FACE("Roboto Flex", "https://fonts.gstatic.com/s/r.woff2"),
      },
    ]);
    expect(site.fonts[0]).toMatchObject({
      family: "Roboto Flex",
      source: "google",
      url: "https://fonts.googleapis.com/css2?family=Roboto+Flex",
    });
  });

  it("picks the loaded file of each weight in use for a self-hosted family, latin subset first, one per file", () => {
    const latin = "https://cdn.example.com/inter-latin.woff2";
    const ext = "https://cdn.example.com/inter-ext.woff2";
    const bold = "https://cdn.example.com/inter-bold.woff2";
    const unused = "https://cdn.example.com/inter-light.woff2";
    const { site, fontPicks } = assemble(
      { fonts: [use("Inter", 400, 40), use("Inter", 700, 8, { heading: 8 })] },
      [
        {
          baseUrl: "https://cdn.example.com/a.css",
          text: [
            FACE("Inter", ext, "font-weight: 400; unicode-range: U+0100-02AF;"),
            FACE("Inter", latin, "font-weight: 400; unicode-range: U+0000-00FF;"),
            FACE("Inter", bold, "font-weight: 700;"),
            FACE("Inter", unused, "font-weight: 300;"),
          ].join("\n"),
        },
      ],
      [
        { url: latin, data: bytes(10), mimeType: "font/woff2" },
        { url: ext, data: bytes(99), mimeType: "font/woff2" },
        { url: bold, data: bytes(20), mimeType: "font/woff2" },
      ],
    );
    expect(site.fonts[0]).toMatchObject({
      family: "Inter",
      source: "self_hosted",
      weights: [400, 700],
    });
    expect(fontPicks.map((pick) => [pick.weight, pick.url])).toEqual([
      [400, latin],
      [700, bold],
    ]);
  });

  it("saves a variable font once, and nothing for a file the page never loaded", () => {
    const file = "https://cdn.example.com/var.woff2";
    const { fontPicks } = assemble(
      { fonts: [use("Var", 300, 5), use("Var", 500, 5), use("Ghost", 400, 5)] },
      [
        {
          baseUrl: "https://cdn.example.com/a.css",
          text:
            FACE("Var", file, "font-weight: 100 900;") +
            FACE("Ghost", "https://cdn.example.com/g.woff2"),
        },
      ],
      [{ url: file, data: bytes(5), mimeType: "font/woff2" }],
    );
    expect(fontPicks).toHaveLength(1);
    expect(fontPicks[0]).toMatchObject({ family: "Var", url: file });
  });

  it("names a font optimizer's renamed family and skips its fallback face", () => {
    expect(displayFamily("__Inter_a1b2c3d4")).toBe("Inter");
    expect(displayFamily("__DM_Sans_0f1e2d")).toBe("DM Sans");
    expect(displayFamily("sohne-var")).toBe("sohne-var");
    const { site } = assemble({
      fonts: [use("__Inter_a1b2c3d4", 400, 10), use("__Inter_Fallback_a1b2c3d4", 400, 50)],
    });
    expect(site.fonts.map((font) => font.family)).toEqual(["Inter"]);
  });

  it("calls a family nobody declared a system font", () => {
    const { site } = assemble({ fonts: [use("system-ui", 400, 3)] });
    expect(site.fonts[0]).toMatchObject({ source: "system", url: null });
  });

  it("derives the mime type from the response header, else the extension", () => {
    expect(fontMime("https://x/a.bin", "font/woff2")).toBe("font/woff2");
    expect(fontMime("https://x/a.bin", "application/font-woff")).toBe("font/woff");
    expect(fontMime("https://x/a.otf?v=1", null)).toBe("font/otf");
    expect(fontMime("https://x/a.woff2", "application/octet-stream")).toBe("font/woff2");
  });
});

describe("assembleStyle page facts", () => {
  it("names the host without www, merges motion from the page and the sheets, and resolves tokens", () => {
    const { site } = assemble(
      {
        motion: {
          durationsMs: [200],
          easings: ["ease"],
          properties: ["opacity"],
          animationNames: ["spin"],
        },
        icons: [
          { url: "https://www.example.com/f.png", size: 32, svg: false },
          { url: "https://www.example.com/f.svg", size: 0, svg: true },
        ],
      },
      [
        {
          baseUrl: "https://example.com/a.css",
          text: ".a{transition: transform 300ms ease-out} @keyframes fade{to{opacity:1}}",
        },
      ],
    );
    expect(site.host).toBe("example.com");
    expect(site.motion).toEqual({
      durationsMs: [200, 300],
      easings: ["ease", "ease-out"],
      keyframes: ["spin", "fade"],
      properties: ["opacity", "transform"],
    });
    expect(site.tokens).toEqual([{ name: "--color-brand", value: "#5e6ad2" }]);
    expect(site.favicon).toBe("https://www.example.com/f.svg");
    expect(site.capturedAt).toBe(7);
  });
});
