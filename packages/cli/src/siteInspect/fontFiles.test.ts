import { describe, expect, it } from "vitest";
import { faceName, fontFileName } from "./fontFiles.js";

describe("fontFileName", () => {
  it("takes the name from a URL that ends in a font extension", () => {
    expect(
      fontFileName("https://x.com/fonts/Brand%20Sans.woff2", "font/woff2", "f", new Set()),
    ).toBe("Brand-Sans.woff2");
  });

  it("keeps the read alive when the path has a lone percent sign", () => {
    expect(fontFileName("https://x.com/fonts/100%.woff2", "font/woff2", "f", new Set())).toBe(
      "100-.woff2",
    );
    expect(fontFileName("https://x.com/fonts/a%zz.woff2", "font/woff2", "f", new Set())).toBe(
      "a-zz.woff2",
    );
  });

  it("falls back to the face when the URL has no font extension", () => {
    expect(fontFileName("https://x.com/dl?id=3", "font/woff2", "brand-700", new Set())).toBe(
      "brand-700.woff2",
    );
  });

  it("never hands one name out twice, even where the folder ignores case", () => {
    const taken = new Set<string>();
    const names = [
      fontFileName("https://x.com/a/Brand.woff2", "font/woff2", "f", taken),
      fontFileName("https://x.com/b/Brand.woff2", "font/woff2", "f", taken),
      fontFileName("https://x.com/c/brand.woff2", "font/woff2", "f", taken),
      fontFileName("https://x.com/x", "font/woff2", "brand-400", taken),
      fontFileName("https://x.com/y", "font/woff2", "brand-400", taken),
    ];
    expect(names).toEqual([
      "Brand.woff2",
      "Brand-2.woff2",
      "brand-3.woff2",
      "brand-400.woff2",
      "brand-400-2.woff2",
    ]);
  });
});

describe("faceName", () => {
  it("tells italic from normal so extension-less URLs of one family do not collide", () => {
    expect(faceName("Brand Sans", 400, "normal")).toBe("brand-sans-400");
    expect(faceName("Brand Sans", 400, "italic")).toBe("brand-sans-400-italic");
  });
});
