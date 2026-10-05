import { describe, expect, it } from "vitest";
import { deferPreviewMedia } from "./deferredPreviewMedia.js";

const page = (body: string) =>
  `<!DOCTYPE html><html><head><title>x</title></head><body>${body}</body></html>`;

describe("deferPreviewMedia", () => {
  it("serves a managed video without src, its source in the detached attribute and preload none", () => {
    const html = page(
      `<video id="a" class="clip" src="assets/a.mp4" data-start="0" data-duration="3" muted playsinline></video>`,
    );
    expect(deferPreviewMedia(html)).toBe(
      page(
        `<video preload="none" id="a" class="clip" data-hf-detached-src="assets/a.mp4" data-start="0" data-duration="3" muted playsinline></video>`,
      ),
    );
  });

  it("replaces an authored preload instead of adding a second one", () => {
    const out = deferPreviewMedia(
      page(`<video src='a b.mp4' preload = "auto" data-duration=2></video>`),
    );
    expect(out).toContain(`data-hf-detached-src='a b.mp4'`);
    expect(out).toContain(`preload="none"`);
    expect(out.match(/preload=/g)).toHaveLength(1);
    expect(out).not.toMatch(/\ssrc=/);
  });

  it("touches only the `src` attribute, not a value that merely contains the text", () => {
    const out = deferPreviewMedia(
      page(`<video data-note="has src=x in it > really" src="a.mp4" data-duration="2"></video>`),
    );
    expect(out).toContain(`data-note="has src=x in it > really"`);
    expect(out).toContain(`data-hf-detached-src="a.mp4"`);
    expect(out).not.toContain(` src="a.mp4"`);
  });

  it.each([
    ["has no authored length", `<video src="a.mp4" data-start="0"></video>`],
    ["loops", `<video src="a.mp4" data-duration="2" loop></video>`],
    [
      "binds its source to a variable",
      `<video src="a.mp4" data-duration="2" data-var-src="clip"></video>`,
    ],
    ["uses <source> children", `<video data-duration="2"><source src="a.mp4"></video>`],
    ["has a non-numeric length", `<video src="a.mp4" data-duration="soon"></video>`],
  ])("leaves a video that %s alone", (_why, video) => {
    const html = page(video);
    expect(deferPreviewMedia(html)).toBe(html);
  });

  it("only rewrites the managed videos of a mixed film, in order", () => {
    const out = deferPreviewMedia(
      page(
        `<video id="a" src="a.mp4" data-duration="2"></video>` +
          `<video id="b" src="b.mp4"></video>` +
          `<audio src="m.mp3" data-start="0"></audio>` +
          `<video id="c" src="c.mp4" data-duration="5"></video>`,
      ),
    );
    expect(out).toContain(`id="a" data-hf-detached-src="a.mp4"`);
    expect(out).toContain(`<video id="b" src="b.mp4">`);
    expect(out).toContain(`<audio src="m.mp3" data-start="0">`);
    expect(out).toContain(`id="c" data-hf-detached-src="c.mp4"`);
  });

  it("serves audio with an authored length with preload none, keeping its src", () => {
    const out = deferPreviewMedia(
      page(
        `<audio id="s" class="clip" src="sfx.mp3" data-start="1" data-duration="0.4"></audio>` +
          `<audio id="t" src='t.mp3' preload="auto" data-duration="2"></audio>` +
          `<video id="v" src="v.mp4" data-duration="2"></video>`,
      ),
    );
    expect(out).toContain(
      `<audio preload="none" id="s" class="clip" src="sfx.mp3" data-start="1" data-duration="0.4">`,
    );
    expect(out).toContain(`<audio id="t" src='t.mp3' preload="none" data-duration="2">`);
    expect(out).toContain(`id="v" data-hf-detached-src="v.mp4"`);
  });

  it.each([
    ["has no authored length", `<audio src="a.mp3" data-start="0"></audio>`],
    ["loops", `<audio src="a.mp3" data-duration="2" loop></audio>`],
    [
      "binds its source to a variable",
      `<audio src="a.mp3" data-duration="2" data-var-src="x"></audio>`,
    ],
    ["uses <source> children", `<audio data-duration="2"><source src="a.mp3"></audio>`],
  ])("leaves audio that %s alone", (_why, audio) => {
    const html = page(audio);
    expect(deferPreviewMedia(html)).toBe(html);
  });

  it("does not rewrite what is not markup: comments, scripts, or a fragment without a document", () => {
    const inScript = page(
      `<script>const tpl = '<video src="a.mp4" data-duration="2"></video>';</script><!-- <video src="b.mp4" data-duration="2"> -->`,
    );
    expect(deferPreviewMedia(inScript)).toBe(inScript);
    const fragment = `<video src="a.mp4" data-duration="2"></video>`;
    expect(deferPreviewMedia(fragment)).toBe(fragment);
  });

  it("serves a video after a <template> in the same document, matching the right tags", () => {
    const out = deferPreviewMedia(
      page(
        `<template id="t"><video id="in" src="in.mp4" data-duration="2"></video></template>` +
          `<video id="live" src="live.mp4" data-duration="2"></video>`,
      ),
    );
    expect(out).toContain(`id="live" data-hf-detached-src="live.mp4"`);
    // The runtime strips a template's videos as it mounts the template.
    expect(out).toContain(`<video id="in" src="in.mp4" data-duration="2">`);
  });

  it("is idempotent", () => {
    const once = deferPreviewMedia(
      page(
        `<video src="a.mp4" data-duration="2"></video><audio src="s.mp3" data-duration="1"></audio>`,
      ),
    );
    expect(deferPreviewMedia(once)).toBe(once);
  });
});
