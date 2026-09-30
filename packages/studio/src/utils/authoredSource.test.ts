// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { liveMarkupWithoutPreviewMarks } from "./authoredSource";

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
