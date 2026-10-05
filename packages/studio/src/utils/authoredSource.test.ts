// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { authoredMarkup, liveMarkupWithoutPreviewMarks } from "./authoredSource";

describe("liveMarkupWithoutPreviewMarks", () => {
  it("writes a released preview video's authored src back into the copy", () => {
    document.body.innerHTML = `<div id="host"><video id="v" class="clip" data-hf-detached-src="assets/a.mp4" preload="none" data-start="2" data-duration="2"></video></div>`;
    const markup = liveMarkupWithoutPreviewMarks(document.getElementById("host")!);
    const copy = new DOMParser().parseFromString(markup, "text/html").getElementById("v")!;
    expect(copy.getAttribute("src")).toBe("assets/a.mp4");
    expect(copy.hasAttribute("data-hf-detached-src")).toBe(false);
    expect(copy.hasAttribute("preload")).toBe(false);
    expect(copy.getAttribute("data-duration")).toBe("2");
  });

  it("leaves a video that still has its source alone", () => {
    document.body.innerHTML = `<video id="v" src="assets/a.mp4" preload="auto"></video>`;
    const markup = liveMarkupWithoutPreviewMarks(document.getElementById("v")!);
    expect(markup).toContain('src="assets/a.mp4"');
    expect(markup).toContain('preload="auto"');
  });
});

describe("authoredMarkup", () => {
  it("rebases poster, srcset candidates and parenthesised url() like the preview does", () => {
    document.body.innerHTML = `<div id="a"><video id="v" src="../assets/c.mp4" poster="../assets/p.jpg"></video><img id="i" src="../assets/a.png" srcset="../assets/a.png 1x, ../assets/a@2x.png 2x"><div id="d" style="background:url('../assets/bg (2).png')"></div></div>`;
    const el = document.getElementById("a")!;
    const copy = new DOMParser().parseFromString(
      authoredMarkup(el, el, "compositions/intro.html"),
      "text/html",
    );
    expect(copy.getElementById("v")?.getAttribute("poster")).toBe("assets/p.jpg");
    expect(copy.getElementById("i")?.getAttribute("srcset")).toBe(
      "assets/a.png 1x, assets/a@2x.png 2x",
    );
    expect(copy.getElementById("d")?.getAttribute("style")).toContain("url('assets/bg (2).png')");
  });
});
