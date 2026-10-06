// @vitest-environment node
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { colorsIn } from "./colorValue.js";
import { extractProjectDesign } from "./extract.js";

const roots: string[] = [];

function project(files: Record<string, string | Uint8Array>): string {
  const dir = mkdtempSync(join(tmpdir(), "openvids-extract-"));
  roots.push(dir);
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), content);
  }
  return dir;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const INDEX = `<!doctype html><html><head>
<link rel="stylesheet" href="styles/main.css">
<link href="https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@500;700&family=Inter:ital,wght@0,400;1,700&display=swap" rel="stylesheet">
<style>
  :root { --brand: #FF3366; --fg: rgb(255 255 255); --display: "Space Grotesk", sans-serif; }
  body { background: #0b0b0f; color: var(--fg); font-family: var(--display); font-weight: 700; }
  .card { background-color: var(--brand); border: 1px solid hsl(0 0% 100% / 50%); border-radius: 24px; box-shadow: 0 8px 24px rgba(0,0,0,.4); }
  .t { transition: opacity 0.3s cubic-bezier(0.4, 0, 0.2, 1), transform 400ms ease-out; font-size: 48px; }
  .x { animation: spin 2s linear infinite; background: transparent; color: currentColor; }
</style>
</head><body>
<div id="root" data-duration="9" data-start="0" style="color: #0F0; font-family: 'Mono Face', monospace;">
  <svg><rect fill="#abc" stroke="red"></rect></svg>
  <h1 data-font-family="Inter" data-font-weight="400">Hello</h1>
</div>
<script>
  const tl = gsap.timeline({ defaults: { duration: 0.6, ease: "power2.out" } });
  tl.to("#a", { opacity: 1, duration: 1.2, ease: "expo.inOut", backgroundColor: "#112233" })
    .to("#b", { duration: 0.6, ease: "power2.out", borderRadius: 12 });
  const clip = { duration: 99 };
</script>
</body></html>`;

const MAIN_CSS = `
@font-face { font-family: "Mono Face"; src: url("../fonts/mono.woff2") format("woff2"); font-weight: 400; }
.title { font: italic 600 64px/1.1 "Space Grotesk", sans-serif; text-shadow: 0 2px 0 #000; }
.cta { color: #fff; border-radius: 24px; }
`;

const FIXTURE = {
  "index.html": INDEX,
  "styles/main.css": MAIN_CSS,
  "fonts/mono.woff2": new Uint8Array([1, 2, 3]),
  "compositions/outro.html": `<div style="background:#0b0b0f;color:#ffffff"></div>`,
  "design/system.html": `<style>.x{background:#123456}</style>`,
  "design/tokens.css": `:root { --accent: #00ccff; }`,
  ".hyperframes/x.html": `<div style="color:#999999"></div>`,
  "renders/r.html": `<div style="color:#888888"></div>`,
  "node_modules/m/i.html": `<div style="color:#777777"></div>`,
};

describe("colour literals", () => {
  it("normalises every notation and ignores non-colours", () => {
    expect(colorsIn("#FFF #f0f8 #aabbcc #11223344 #ff0000ff", false)).toEqual([
      "#ffffff",
      "#ff00ff88",
      "#aabbcc",
      "#11223344",
      "#ff0000",
    ]);
    expect(colorsIn("rgb(255, 0, 0) rgba(0 0 0 / 50%) hsl(120 100% 25%)", false)).toEqual([
      "#ff0000",
      "#00000080",
      "#008000",
    ]);
    expect(
      colorsIn("red transparent currentColor inherit url(#aabbcc) rgba(0,0,0,0)", true),
    ).toEqual(["#ff0000"]);
    expect(colorsIn("linear-gradient(red, #00f)", false)).toEqual(["#0000ff"]);
  });
});

describe("extractProjectDesign", () => {
  it("counts colours with their roles, ranked by count then value", async () => {
    const found = await extractProjectDesign(project(FIXTURE));
    expect(found.files).toEqual(["index.html", "compositions/outro.html"]);
    expect(found.colors.map((color) => color.value)).not.toContain("#123456");
    expect(found.colors.map((color) => color.value)).not.toContain("#999999");
    const byValue = new Map(found.colors.map((color) => [color.value, color]));
    expect(byValue.get("#0b0b0f")).toEqual({ value: "#0b0b0f", count: 2, roles: ["background"] });
    expect(byValue.get("#ff3366")?.roles).toEqual(["background"]);
    expect(byValue.get("#ffffff")).toMatchObject({ count: 3, roles: ["text"] });
    expect(byValue.get("#ffffff80")?.roles).toEqual(["border"]);
    expect(byValue.get("#00ff00")?.roles).toEqual(["text"]);
    expect(byValue.get("#aabbcc")?.roles).toEqual(["fill"]);
    expect(byValue.get("#ff0000")?.roles).toEqual(["fill"]);
    expect(byValue.get("#112233")?.roles).toEqual(["background"]);
    expect(byValue.get("#00000066")?.roles).toEqual(["other"]);
    expect(byValue.has("#00000000")).toBe(false);
    const counts = found.colors.map((color) => color.count);
    expect(counts).toEqual([...counts].sort((a, b) => b - a));
  });

  it("finds fonts through var(), shorthand, data attributes and how they load", async () => {
    const { fonts } = await extractProjectDesign(project(FIXTURE));
    const byFamily = new Map(fonts.map((font) => [font.family, font]));
    expect(byFamily.get("Space Grotesk")).toMatchObject({
      loading: "google",
      weights: [500, 600, 700],
    });
    expect(byFamily.get("Inter")).toMatchObject({ loading: "google", weights: [400, 700] });
    expect(byFamily.get("Mono Face")).toEqual({
      family: "Mono Face",
      count: 1,
      weights: [400],
      loading: "project_file",
      projectPath: "fonts/mono.woff2",
    });
    expect(fonts.map((font) => font.family)).not.toContain("sans-serif");
  });

  it("reads easings, durations, radii, sizes, shadows and tokens; data-* timing is not a duration", async () => {
    const found = await extractProjectDesign(project(FIXTURE));
    const easings = new Map(found.easings.map((entry) => [entry.value, entry.count]));
    expect(easings.get("power2.out")).toBe(2);
    expect(easings.get("expo.inout")).toBe(1);
    expect(easings.get("cubic-bezier(0.4, 0, 0.2, 1)")).toBe(1);
    expect(easings.get("ease-out")).toBe(1);
    expect(easings.get("linear")).toBe(1);
    const durations = new Map(found.durations.map((entry) => [entry.seconds, entry.count]));
    expect(durations.get(0.6)).toBe(2);
    expect(durations.get(0.3)).toBe(1);
    expect(durations.get(0.4)).toBe(1);
    expect(durations.get(2)).toBe(1);
    expect(durations.get(1.2)).toBe(1);
    expect(durations.has(9)).toBe(false);
    expect(durations.has(99)).toBe(false);
    expect(found.radii).toEqual([
      { value: "24px", count: 2 },
      { value: "12px", count: 1 },
    ]);
    expect(found.fontSizes.map((entry) => entry.value).sort()).toEqual(["48px", "64px"]);
    expect(found.shadows.map((entry) => entry.value)).toEqual([
      "0 2px 0 #000",
      "0 8px 24px rgba(0,0,0,.4)",
    ]);
    expect(found.declaredTokens).toEqual({
      "--accent": "#00ccff",
      "--brand": "#FF3366",
      "--display": '"Space Grotesk", sans-serif',
      "--fg": "rgb(255 255 255)",
    });
  });

  it("is deterministic and does not depend on file creation order", async () => {
    const first = await extractProjectDesign(project(FIXTURE));
    const reversed = Object.fromEntries(Object.entries(FIXTURE).reverse());
    const second = await extractProjectDesign(project(reversed));
    expect(second).toEqual(first);
    expect(JSON.stringify(await extractProjectDesign(project(FIXTURE)))).toBe(
      JSON.stringify(first),
    );
  });

  it("resolves colours through an attached design/tokens.css the composition links", async () => {
    const dir = project({
      "index.html": `<link rel="stylesheet" href="design/tokens.css"><div style="color: var(--accent); font-family: var(--font)"></div>`,
      "design/tokens.css": `@font-face { font-family: "Brand"; src: url("fonts/brand.woff2"); font-weight: 600 }
:root { --accent: #00ccff; --font: "Brand", sans-serif; }`,
      "design/fonts/brand.woff2": new Uint8Array([9]),
    });
    const found = await extractProjectDesign(dir);
    expect(found.colors).toEqual([{ value: "#00ccff", count: 1, roles: ["text"] }]);
    expect(found.fonts).toEqual([
      {
        family: "Brand",
        count: 1,
        weights: [600],
        loading: "project_file",
        projectPath: "design/fonts/brand.woff2",
      },
    ]);
    expect(found.declaredTokens["--accent"]).toBe("#00ccff");
  });

  it("returns an empty extraction for a project without compositions", async () => {
    const found = await extractProjectDesign(project({ "readme.txt": "x" }));
    expect(found).toEqual({
      files: [],
      colors: [],
      fonts: [],
      easings: [],
      durations: [],
      radii: [],
      fontSizes: [],
      shadows: [],
      declaredTokens: {},
    });
  });

  it("does not follow a stylesheet link out of the project", async () => {
    const outside = project({ "secret.css": ".a{color:#abcdef}" });
    const dir = project({
      "index.html": `<link rel="stylesheet" href="../${outside.split("/").pop()}/secret.css"><div style="color:#111111"></div>`,
    });
    const found = await extractProjectDesign(dir);
    expect(found.colors.map((color) => color.value)).toEqual(["#111111"]);
  });
});
