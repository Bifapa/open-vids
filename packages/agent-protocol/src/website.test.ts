import { describe, expect, it } from "vitest";
import { isAssetSearchPolicy } from "./research.js";
import { WEBSITE_LIMITS, isReadWebsiteResult, parseWebsiteStyle } from "./website.js";

const base = {
  url: "https://example.com/",
  finalUrl: "https://www.example.com/en",
  host: "Example.com",
  capturedAt: 5,
};

describe("parseWebsiteStyle", () => {
  it("needs the page identity and fills everything else with empty values", () => {
    expect(parseWebsiteStyle(base)).toEqual({
      url: "https://example.com/",
      finalUrl: "https://www.example.com/en",
      host: "example.com",
      title: "",
      description: "",
      themeColor: null,
      language: null,
      colors: [],
      fonts: [],
      textStyles: [],
      radii: [],
      shadows: [],
      buttons: [],
      tokens: [],
      motion: { durationsMs: [], easings: [], keyframes: [], properties: [] },
      logos: [],
      favicon: null,
      ogImage: null,
      headings: [],
      navLabels: [],
      notes: [],
      capturedAt: 5,
    });
    for (const broken of [
      null,
      "text",
      { ...base, url: "javascript:alert(1)" },
      { ...base, finalUrl: "ftp://example.com" },
      { ...base, finalUrl: undefined },
      { ...base, host: "" },
      { ...base, capturedAt: "now" },
    ]) {
      expect(parseWebsiteStyle(broken)).toBeNull();
    }
  });

  it("keeps good entries, drops unusable ones and normalizes colors", () => {
    const style = parseWebsiteStyle({
      ...base,
      themeColor: " #0A0A0A ",
      colors: [
        { hex: "#FFFFFF", role: "text", count: 3 },
        { hex: "white", role: "text", count: 1 },
        { hex: "#000000", role: "sparkle", count: 1 },
        { hex: "#112233", role: "accent", count: -2 },
        "nope",
      ],
      fonts: [
        {
          family: "Inter",
          weights: [400, "bold", 700],
          source: "google",
          url: "https://fonts.googleapis.com/css2?family=Inter",
          usedFor: ["body", "ornament"],
        },
        { family: "", source: "system" },
        { family: "Mystery", source: "cdn" },
      ],
      textStyles: [
        { element: "h1", fontSizePx: 64, fontWeight: 700, letterSpacingPx: -1.5, color: "#fff" },
        { element: "h9", fontSizePx: 10, fontWeight: 400 },
      ],
      tokens: [
        { name: "--color-primary", value: "#5e6ad2" },
        { name: "color-primary", value: "x" },
      ],
      logos: [
        { source: "inline_svg", url: "https://example.com/", captured: true },
        { source: "image", url: "file:///etc/passwd" },
      ],
      favicon: "javascript:1",
      ogImage: "https://example.com/og.png",
    });
    expect(style?.themeColor).toBe("#0a0a0a");
    expect(style?.colors).toEqual([{ hex: "#ffffff", role: "text", count: 3 }]);
    expect(style?.fonts).toEqual([
      {
        family: "Inter",
        weights: [400, 700],
        source: "google",
        url: "https://fonts.googleapis.com/css2?family=Inter",
        usedFor: ["body"],
      },
    ]);
    expect(style?.textStyles).toEqual([
      {
        element: "h1",
        sample: "",
        fontFamily: "",
        fontSizePx: 64,
        fontWeight: 700,
        lineHeightPx: null,
        letterSpacingPx: -1.5,
        color: null,
      },
    ]);
    expect(style?.tokens).toEqual([{ name: "--color-primary", value: "#5e6ad2" }]);
    expect(style?.logos).toEqual([
      {
        source: "inline_svg",
        url: "https://example.com/",
        alt: "",
        width: null,
        height: null,
        captured: true,
      },
    ]);
    expect(style?.favicon).toBeNull();
    expect(style?.ogImage).toBe("https://example.com/og.png");
  });

  it("caps every list and every text", () => {
    const style = parseWebsiteStyle({
      ...base,
      title: "t".repeat(1_000),
      colors: Array.from({ length: 100 }, (_, i) => ({
        hex: `#${String(i).padStart(6, "0")}`,
        role: "other",
        count: 1,
      })),
      headings: Array.from({ length: 50 }, (_, i) => `Heading ${i}`),
      notes: ["n".repeat(5_000)],
      motion: { durationsMs: Array.from({ length: 40 }, (_, i) => i), easings: ["a".repeat(500)] },
    });
    expect(style?.title).toHaveLength(WEBSITE_LIMITS.textChars);
    expect(style?.colors).toHaveLength(WEBSITE_LIMITS.colors);
    expect(style?.headings).toHaveLength(WEBSITE_LIMITS.headings);
    expect(style?.notes[0]).toHaveLength(WEBSITE_LIMITS.textChars);
    expect(style?.motion.durationsMs).toHaveLength(WEBSITE_LIMITS.durations);
    expect(style?.motion.easings[0]).toHaveLength(100);
  });
});

describe("isReadWebsiteResult", () => {
  const shot = {
    name: "viewport.jpg",
    mimeType: "image/jpeg",
    data: "AAAA",
    width: 1440,
    height: 900,
  };

  it("accepts a result whose style and screenshots parse, with or without saved files", () => {
    expect(isReadWebsiteResult({ site: base, screenshots: [shot] })).toBe(true);
    expect(
      isReadWebsiteResult({
        site: base,
        screenshots: [],
        saved: { dir: "assets/web/example.com", files: [] },
      }),
    ).toBe(true);
  });

  it("rejects a result with an unusable style, screenshot or saved block", () => {
    expect(isReadWebsiteResult({ site: { ...base, host: "" }, screenshots: [] })).toBe(false);
    expect(isReadWebsiteResult({ site: base, screenshots: [{ ...shot, data: 5 }] })).toBe(false);
    expect(isReadWebsiteResult({ site: base, screenshots: [], saved: { files: [] } })).toBe(false);
    expect(isReadWebsiteResult({ screenshots: [] })).toBe(false);
  });
});

describe("the policy's Websites group", () => {
  const policy = { mode: "trusted", sources: [], removedBuiltIns: [], updatedAt: 0 };

  it("is part of a policy: one without it is not a policy", () => {
    expect(isAssetSearchPolicy({ ...policy, websites: { readLinkedPages: true } })).toBe(true);
    expect(isAssetSearchPolicy({ ...policy, websites: { readLinkedPages: false } })).toBe(true);
    expect(isAssetSearchPolicy(policy)).toBe(false);
    expect(isAssetSearchPolicy({ ...policy, websites: { readLinkedPages: "yes" } })).toBe(false);
  });
});
