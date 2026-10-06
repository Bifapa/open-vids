import { describe, expect, it } from "vitest";
import { designChips, snapshotFacts, swatchColors } from "./designFacts";
import { TOKENS_CSS } from "./designTestHarness";

describe("snapshotFacts", () => {
  it("reads the palette and the display font from the snapshot's tokens.css", () => {
    expect(snapshotFacts(TOKENS_CSS)).toEqual({
      palette: ["#0b0b0f", "#f4f1ea", "#ff6a3d", "#ffb347", "#4dd0e1"],
      displayFont: "Fraunces",
    });
  });

  it("takes the last declaration of a token and strips quotes from the first family only", () => {
    const css = `:root { --bg: #111; --bg: #222222; --font-display: 'Space Grotesk', "Inter", sans-serif; }`;
    expect(snapshotFacts(css)).toEqual({ palette: ["#222222"], displayFont: "Space Grotesk" });
  });

  it("finds no palette or font in a stylesheet without the tokens, and never reads font-face rules as tokens", () => {
    const css = `@font-face { font-family: "Fraunces"; src: url("fonts/a.woff2"); }`;
    expect(snapshotFacts(css)).toEqual({ palette: [], displayFont: null });
    expect(snapshotFacts("")).toEqual({ palette: [], displayFont: null });
  });

  it("does not take a font from a token that points at another one", () => {
    expect(snapshotFacts(":root { --font-display: var(--font-body); }").displayFont).toBeNull();
  });
});

describe("swatchColors", () => {
  it("keeps colours in order without repeats, and drops anything that is not safe to paint", () => {
    expect(
      swatchColors([
        "#fff",
        " #fff ",
        "oklch(0.7 0.1 40)",
        "red; background: url(x)",
        "var(--bg)",
        "",
        "#000}",
      ]),
    ).toEqual(["#fff", "oklch(0.7 0.1 40)"]);
  });
});

describe("designChips", () => {
  it("says which font or logo has no known license and which fonts are not stored", () => {
    expect(
      designChips({
        unknownLicenses: ["font:Inter", "logo", "stock-photo"],
        nonPortableFonts: ["Helvetica Neue"],
      }).map((chip) => chip.label),
    ).toEqual([
      "Inter: license unknown",
      "Logo: license unknown",
      "stock-photo: license unknown",
      "Helvetica Neue: system font",
    ]);
    expect(designChips({ unknownLicenses: [], nonPortableFonts: [] })).toEqual([]);
  });

  it("lists a font used for two roles once", () => {
    expect(
      designChips({
        unknownLicenses: ["font:Menlo", "font:Menlo"],
        nonPortableFonts: ["Menlo", "Menlo"],
      }).map((chip) => chip.label),
    ).toEqual(["Menlo: license unknown", "Menlo: system font"]);
  });
});
