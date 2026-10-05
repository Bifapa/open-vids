import { describe, expect, it } from "vitest";
import { rewriteSrcset } from "./assetUrls.js";
import {
  rewriteAssetPath,
  rewriteAssetPaths,
  rewriteCssAssetUrls,
  rewriteInlineStyleAssetUrls,
} from "./rewriteSubCompPaths.js";

describe("rewriteAssetPath", () => {
  it("rewrites `../` against the sub-composition dir", () => {
    expect(rewriteAssetPath("compositions/scene.html", "../icon.svg")).toBe("icon.svg");
  });

  it("leaves plain relative paths untouched", () => {
    expect(rewriteAssetPath("compositions/scene.html", "assets/logo.png")).toBe("assets/logo.png");
  });

  it("leaves absolute URLs and data URIs untouched", () => {
    expect(rewriteAssetPath("compositions/scene.html", "https://x/y")).toBe("https://x/y");
    expect(rewriteAssetPath("compositions/scene.html", "data:image/png;base64,AA")).toBe(
      "data:image/png;base64,AA",
    );
    expect(rewriteAssetPath("compositions/scene.html", "#hash")).toBe("#hash");
  });

  // Regression guard for a Windows-only bug: the rewriter used to import
  // `path` (native) and emit `:\fonts\brand.woff2` — native `join` used
  // backslashes, and `resolve("/", x).slice(1)` chopped the `D` off a
  // `D:\…` absolute path. URLs must be POSIX regardless of host OS.
  it("never emits backslashes on any platform", () => {
    const out = rewriteAssetPath("compositions/nested/scene.html", "../../fonts/brand.woff2");
    expect(out).toBe("fonts/brand.woff2");
    expect(out).not.toMatch(/\\/);
    expect(out).not.toMatch(/^:/);
  });

  it("CSS url(...) rewrites also stay POSIX under nesting", () => {
    const css = `@font-face { src: url("../../fonts/brand.woff2") format("woff2"); }`;
    const out = rewriteCssAssetUrls(css, "compositions/nested/scene.html");
    expect(out).toContain(`url("fonts/brand.woff2")`);
    expect(out).not.toMatch(/\\/);
    expect(out).not.toMatch(/:\\/);
  });

  it("rewrites quoted url() values that contain parentheses or the other quote character", () => {
    const comp = "compositions/intro.html";
    expect(rewriteCssAssetUrls(`a{background:url("../assets/bg (2).png")}`, comp)).toBe(
      `a{background:url("assets/bg (2).png")}`,
    );
    expect(rewriteCssAssetUrls(`a{background:url('../assets/it"s.png')}`, comp)).toBe(
      `a{background:url('assets/it"s.png')}`,
    );
    expect(rewriteCssAssetUrls(`a{background:url("../assets/it's.png")}`, comp)).toBe(
      `a{background:url("assets/it's.png")}`,
    );
    expect(rewriteCssAssetUrls(`a{background:url( ../assets/bg.png )}`, comp)).toBe(
      `a{background:url(assets/bg.png)}`,
    );
  });

  it("rewrites poster, xlink:href and each srcset candidate", () => {
    const attrs: Record<string, string> = {
      src: "../assets/a.png",
      poster: "../assets/p.jpg",
      "xlink:href": "../assets/s.svg",
      srcset: "../assets/a.png 1x, ../assets/a@2x.png 2x",
    };
    rewriteAssetPaths(
      [attrs],
      "compositions/intro.html",
      (el, attr) => el[attr],
      (el, attr, value) => {
        el[attr] = value;
      },
    );
    expect(attrs).toEqual({
      src: "assets/a.png",
      poster: "assets/p.jpg",
      "xlink:href": "assets/s.svg",
      srcset: "assets/a.png 1x, assets/a@2x.png 2x",
    });
  });

  it("leaves a srcset with nothing to rewrite byte-identical", () => {
    expect(rewriteSrcset("a.png 1x,b.png 2x", (url) => url)).toBe("a.png 1x,b.png 2x");
  });

  it("rewrites CSS urls inside inline style attributes", () => {
    const elements = [{ style: `background-image: url("../cover.png")` }];

    rewriteInlineStyleAssetUrls(
      elements,
      "compositions/scene.html",
      (el) => el.style,
      (el, value) => {
        el.style = value;
      },
    );

    expect(elements[0]?.style).toBe(`background-image: url("cover.png")`);
  });

  // A sub-composition referencing a SIBLING file (`_shared.css`, no `../`) means
  // a file in its own directory, but the inlined/preview document resolves it
  // against the project root — so it 404s. `assetExists` lets a caller that can
  // see the filesystem opt into browser semantics, while paths with no such
  // sibling (the registry's project-root `assets/logo.png` convention) stay put.
  describe("with an assetExists probe", () => {
    const exists = (p: string) =>
      [
        "design/styleframes/_shared.css",
        "design/styleframes/frame.png",
        "assets/logo.png",
      ].includes(p);

    it("resolves a sibling file against the sub-composition dir", () => {
      expect(rewriteAssetPath("design/styleframes/frame-01.html", "_shared.css", exists)).toBe(
        "design/styleframes/_shared.css",
      );
    });

    it("keeps a query string and hash on the rewritten path", () => {
      expect(rewriteAssetPath("design/styleframes/frame-01.html", "frame.png?v=2", exists)).toBe(
        "design/styleframes/frame.png?v=2",
      );
    });

    it("leaves project-root-relative paths alone when no sibling exists", () => {
      expect(rewriteAssetPath("blocks/hero.html", "assets/logo.png", exists)).toBe(
        "assets/logo.png",
      );
    });

    it("still resolves `../` without consulting the probe", () => {
      expect(rewriteAssetPath("compositions/scene.html", "../icon.svg", exists)).toBe("icon.svg");
    });

    it("is a no-op without the probe (unchanged default)", () => {
      expect(rewriteAssetPath("design/styleframes/frame-01.html", "_shared.css")).toBe(
        "_shared.css",
      );
    });

    it("finds a sibling whose on-disk name is percent-encoded in the src", () => {
      const present = (p: string) =>
        ["compositions/media/клип 1.mp4", "compositions/my clip.mp4"].includes(p);
      expect(
        rewriteAssetPath(
          "compositions/scene.html",
          "media/%D0%BA%D0%BB%D0%B8%D0%BF%201.mp4?v=2",
          present,
        ),
      ).toBe("compositions/media/%D0%BA%D0%BB%D0%B8%D0%BF%201.mp4?v=2");
      expect(rewriteAssetPath("compositions/scene.html", "my%20clip.mp4", present)).toBe(
        "compositions/my%20clip.mp4",
      );
    });
  });
});
