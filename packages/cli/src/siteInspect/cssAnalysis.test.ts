import { describe, expect, it } from "vitest";
import { analyzeCss, topKeys } from "./cssAnalysis.js";

const BASE = "https://cdn.example.com/assets/app.css";

describe("analyzeCss", () => {
  it("reads @font-face rules with resolved URLs, weight ranges, style and unicode range", () => {
    const facts = analyzeCss([
      {
        baseUrl: BASE,
        text: `
          @font-face { font-family: "Inter Variable"; font-weight: 100 900; font-style: normal;
            src: url(../fonts/inter.woff2) format("woff2"), url("../fonts/inter.woff") format('woff');
            unicode-range: U+0000-00FF, U+0131; }
          @font-face { font-family: Serif Display; font-weight: bold; font-style: italic;
            src: url(https://fonts.gstatic.com/s/serif.ttf); }
          @font-face { font-family: Broken; src: local(Arial); }
        `,
      },
    ]);
    expect(facts.fontFaces).toEqual([
      {
        family: "Inter Variable",
        weightMin: 100,
        weightMax: 900,
        italic: false,
        unicodeRange: "U+0000-00FF, U+0131",
        srcs: [
          { url: "https://cdn.example.com/fonts/inter.woff2", format: "woff2" },
          { url: "https://cdn.example.com/fonts/inter.woff", format: "woff" },
        ],
      },
      {
        family: "Serif Display",
        weightMin: 700,
        weightMax: 700,
        italic: true,
        unicodeRange: null,
        srcs: [{ url: "https://fonts.gstatic.com/s/serif.ttf", format: null }],
      },
    ]);
  });

  it("collects design-token custom properties from :root, semantic names first, skipping utility variables", () => {
    const facts = analyzeCss([
      {
        baseUrl: BASE,
        text: `
          :root { --color-red-500: #f00; --color-brand: #5e6ad2; --tw-ring-color: red; --font-sans: Inter;
                  --unrelated: 1; --radius-md: 8px; }
          .card { --color-card-only: #000; }
          html, body { --text-primary: #fff; }
        `,
      },
    ]);
    expect(facts.tokenNames).toEqual([
      "--color-brand",
      "--font-sans",
      "--radius-md",
      "--text-primary",
      "--color-red-500",
    ]);
  });

  it("counts durations, easings and properties from longhands and shorthands, and lists @keyframes", () => {
    const facts = analyzeCss([
      {
        baseUrl: BASE,
        text: `
          .a { transition: opacity .2s cubic-bezier(0.2, 0, 0, 1), transform 300ms ease-out; }
          .b { transition: opacity 0.2s cubic-bezier(0.2, 0, 0, 1); animation: spin 2s linear infinite; }
          .c { transition-duration: 150ms, 1s; transition-property: color, all; transition-timing-function: ease; }
          @keyframes spin { to { transform: rotate(360deg); } }
          @media (min-width: 1px) { @keyframes fade-in { from { opacity: 0 } } }
        `,
      },
    ]);
    expect(topKeys(facts.durations, 3)).toEqual([200, 300, 2000]);
    expect(facts.durations.get(150)).toBe(1);
    expect(topKeys(facts.easings, 1)).toEqual(["cubic-bezier(0.2, 0, 0, 1)"]);
    expect(topKeys(facts.properties, 2)).toEqual(["opacity", "transform"]);
    expect(facts.properties.has("all")).toBe(false);
    expect(facts.keyframes).toEqual(["spin", "fade-in"]);
  });

  it("skips a sheet it cannot parse and keeps the others", () => {
    const facts = analyzeCss([
      { baseUrl: BASE, text: "@font-face { font-family: Broken; src: url(x.woff2" },
      { baseUrl: BASE, text: "@keyframes ok { to { opacity: 1 } }" },
    ]);
    expect(facts.keyframes).toEqual(["ok"]);
  });
});
