// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  deduplicateIds,
  insertAsSibling,
  serializeClipboardPayload,
  deserializeClipboardPayload,
  type ClipboardPayload,
} from "./clipboardPayload";

describe("deduplicateIds", () => {
  it("renames ids that collide with existing ids", () => {
    const html = '<div id="hero"><img id="photo" src="a.png" /></div>';
    const existingIds = ["hero", "other"];
    const result = deduplicateIds(html, existingIds);
    expect(result).not.toContain('id="hero"');
    expect(result).toContain('id="photo"');
    expect(result).toMatch(/id="hero-\d+"/);
  });

  it("returns html unchanged when no collisions", () => {
    const html = '<div id="unique"><p>hello</p></div>';
    const result = deduplicateIds(html, ["other"]);
    expect(result).toBe(html);
  });

  it("does not rewrite data-composition-id or other data-*-id attributes", () => {
    const html = '<div data-composition-id="hero" data-clip-id="hero" id="hero">content</div>';
    const result = deduplicateIds(html, ["hero"]);
    expect(result).toContain('data-composition-id="hero"');
    expect(result).toContain('data-clip-id="hero"');
    expect(result).toMatch(/\sid="hero-\d+"/);
  });
});

describe("serializeClipboardPayload / deserializeClipboardPayload", () => {
  it("round-trips a single-clip timeline payload", () => {
    const payload: ClipboardPayload = {
      kind: "timeline-clip",
      clips: [
        {
          html: '<img id="photo" src="a.png" data-start="1" data-duration="3" />',
          start: 1,
          duration: 3,
          track: 0,
        },
      ],
      sourceFile: "index.html",
    };
    const json = serializeClipboardPayload(payload);
    const parsed = deserializeClipboardPayload(json);
    expect(parsed).toEqual(payload);
  });

  it("round-trips a group timeline-clip payload", () => {
    const payload: ClipboardPayload = {
      kind: "timeline-clip",
      clips: [
        {
          html: '<img id="a" data-start="1" data-duration="0.5" />',
          start: 1,
          duration: 0.5,
          track: 0,
        },
        {
          html: '<img id="b" data-start="2" data-duration="0.5" />',
          start: 2,
          duration: 0.5,
          track: 1,
        },
      ],
      sourceFile: "index.html",
    };
    const json = serializeClipboardPayload(payload);
    const parsed = deserializeClipboardPayload(json);
    expect(parsed).toEqual(payload);
  });

  it("round-trips a dom-element payload", () => {
    const payload: ClipboardPayload = {
      kind: "dom-element",
      html: '<div class="card"><p>Hello</p></div>',
      sourceFile: "compositions/scene.html",
    };
    const json = serializeClipboardPayload(payload);
    const parsed = deserializeClipboardPayload(json);
    expect(parsed).toEqual(payload);
  });

  it("returns null for invalid JSON", () => {
    expect(deserializeClipboardPayload("not json")).toBeNull();
    expect(deserializeClipboardPayload('{"kind":"unknown"}')).toBeNull();
  });

  it("returns null for a timeline-clip payload with no clips", () => {
    const json = serializeClipboardPayload({
      kind: "timeline-clip",
      clips: [],
      sourceFile: "index.html",
    });
    expect(deserializeClipboardPayload(json)).toBeNull();
  });
});

describe("insertAsSibling root fallback", () => {
  it("pastes after the real root tag, past a commented-out root and a '>' inside an attribute", () => {
    const source = `<!-- <div data-composition-id="old"> --><div data-composition-id='main' data-note="a>b"><p>x</p></div>`;
    expect(insertAsSibling(source, "<i>new</i>", undefined, undefined)).toBe(
      `<!-- <div data-composition-id="old"> --><div data-composition-id='main' data-note="a>b"><i>new</i><p>x</p></div>`,
    );
  });

  it("pastes inside the root of a <template> sub-composition, never after </template>", () => {
    const source = `<template id="sub-template"><div data-composition-id="sub" data-duration="4"></div></template>`;
    expect(insertAsSibling(source, '<p id="x"></p>', undefined, undefined)).toBe(
      `<template id="sub-template"><div data-composition-id="sub" data-duration="4"><p id="x"></p></div></template>`,
    );
  });
});
