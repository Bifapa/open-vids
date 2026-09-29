// @vitest-environment node
import { afterEach, describe, expect, it } from "vitest";
import { readTimeline } from "./service.js";
import { parseComposition, resolveProjectRelative } from "./timeline.js";
import { createTestProject, type TestProject } from "./testProject.js";

let project: TestProject | undefined;
afterEach(() => {
  project?.cleanup();
  project = undefined;
});

describe("readTimeline", () => {
  it("describes a realistic composition: kinds, timing, media facts, tracks, version", async () => {
    project = createTestProject();
    const timeline = await readTimeline(project.project, "index.html", project.facts);

    expect(timeline.composition).toEqual({
      path: "index.html",
      width: 1920,
      height: 1080,
      duration: 10,
    });
    expect(timeline.version).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(timeline.clips.map((clip) => [clip.id, clip.kind, clip.track])).toEqual([
      ["hf-intro", "video", 0],
      ["hf-title", "text", 2],
      ["hf-music", "audio", 3],
      ["hf-host", "composition", 4],
    ]);
    expect(timeline.tracks).toEqual([
      { index: 0, clipIds: ["hf-intro"] },
      { index: 2, clipIds: ["hf-title"] },
      { index: 3, clipIds: ["hf-music"] },
      { index: 4, clipIds: ["hf-host"] },
    ]);

    const intro = timeline.clips.find((clip) => clip.id === "hf-intro");
    expect(intro).toMatchObject({
      domId: "intro",
      label: "a.mp4",
      start: 0,
      duration: 4,
      end: 4,
      zIndex: 1,
      src: "assets/a.mp4",
      mediaStart: 0,
      sourceDuration: 8,
      muted: true,
      locked: false,
    });
    expect(timeline.clips.find((clip) => clip.id === "hf-music")).toMatchObject({
      volume: 0.5,
      muted: false,
      sourceDuration: 30,
    });
    expect(timeline.clips.find((clip) => clip.id === "hf-title")).toMatchObject({
      label: "Hello",
      src: null,
      volume: null,
    });
    expect(timeline.clips.find((clip) => clip.id === "hf-host")).toMatchObject({
      compositionSrc: "compositions/lower-third.html",
    });
  });

  it("changes the version when the file changes", async () => {
    project = createTestProject();
    const before = await readTimeline(project.project, "index.html", project.facts);
    project.write("index.html", project.read("index.html").replace("Hello", "Bye"));
    const after = await readTimeline(project.project, "index.html", project.facts);
    expect(after.version).not.toBe(before.version);
  });

  it("refuses a file that is not a composition, and a missing one", async () => {
    project = createTestProject();
    project.write("notes.html", "<p>no composition here</p>");
    await expect(readTimeline(project.project, "notes.html", project.facts)).rejects.toMatchObject({
      error: { code: "unknown_composition" },
    });
    await expect(readTimeline(project.project, "nope.html", project.facts)).rejects.toMatchObject({
      error: { code: "unknown_composition" },
    });
    await expect(readTimeline(project.project, "../x.html", project.facts)).rejects.toMatchObject({
      error: { code: "unknown_composition" },
    });
  });

  it("gives a media clip without data-duration the rest of its source, and text the rest of the composition", async () => {
    project = createTestProject({
      html: `<div data-composition-id="main" data-width="1280" data-height="720" data-duration="20">
        <video id="v" class="clip" src="assets/a.mp4" data-start="2" data-media-start="3" data-track-index="0"></video>
        <div id="t" class="clip" data-start="12">tail</div>
      </div>`,
    });
    const timeline = await readTimeline(project.project, "index.html", project.facts);
    expect(timeline.clips.find((clip) => clip.domId === "v")).toMatchObject({
      start: 2,
      duration: 5,
      end: 7,
      mediaStart: 3,
    });
    expect(timeline.clips.find((clip) => clip.domId === "t")).toMatchObject({
      start: 12,
      duration: 8,
    });
  });
});

describe("parseComposition", () => {
  it("counts only direct timed children of the root; a clip owns what it contains", () => {
    const model = parseComposition(
      `<div data-composition-id="main" data-duration="10">
        <div id="wrap" class="clip" data-start="0" data-duration="5" data-track-index="1">
          <img id="inner" data-start="1" data-duration="1" src="x.png" />
        </div>
        <section><p id="loose" class="clip" data-start="2" data-duration="1" data-track-index="2">x</p></section>
      </div>`,
      "index.html",
    );
    expect(model?.clips.map((clip) => clip.domId)).toEqual(["wrap", "loose"]);
  });

  it("falls back to the clip's position for an unauthored track, honours an authored track 0", () => {
    const model = parseComposition(
      `<div data-composition-id="main" data-duration="10">
        <div id="a" class="clip" data-start="0" data-duration="1">a</div>
        <div id="b" class="clip" data-start="0" data-duration="1">b</div>
        <div id="c" class="clip" data-start="0" data-duration="1" data-track-index="0">c</div>
      </div>`,
      "index.html",
    );
    expect(model?.clips.map((clip) => [clip.domId, clip.track])).toEqual([
      ["a", 0],
      ["b", 1],
      ["c", 0],
    ]);
  });

  it("reads a sub-composition file whose root sits inside a template", () => {
    const model = parseComposition(
      `<template id="t" data-composition-id="sub" data-width="640" data-height="360"><div data-composition-id="sub" data-duration="6"><div id="x" class="clip" data-start="1" data-duration="2">x</div></div></template>`,
      "compositions/sub.html",
    );
    expect(model).toMatchObject({ width: 640, height: 360, duration: 6 });
    expect(model?.clips.map((clip) => clip.domId)).toEqual(["x"]);
  });

  it("resolves a start that references another clip's end", () => {
    const model = parseComposition(
      `<div data-composition-id="main" data-duration="10">
        <div id="first" class="clip" data-start="1" data-duration="2" data-track-index="0">a</div>
        <div id="second" class="clip" data-start="first + 0.5" data-duration="1" data-track-index="0">b</div>
      </div>`,
      "index.html",
    );
    expect(model?.clips.find((clip) => clip.domId === "second")?.start).toBe(3.5);
  });

  it("returns null without a composition root", () => {
    expect(parseComposition("<p>hi</p>", "index.html")).toBeNull();
  });
});

describe("resolveProjectRelative", () => {
  it("resolves against the composition's directory and refuses URLs and escapes", () => {
    expect(resolveProjectRelative("compositions/a.html", "../assets/x.png")).toBe("assets/x.png");
    expect(resolveProjectRelative("index.html", "./assets/x.png?v=1")).toBe("assets/x.png");
    expect(resolveProjectRelative("index.html", "/assets/x.png")).toBe("assets/x.png");
    expect(resolveProjectRelative("index.html", "https://cdn.example/x.png")).toBeNull();
    expect(resolveProjectRelative("index.html", "../x.png")).toBeNull();
    expect(resolveProjectRelative("index.html", "data:image/png;base64,AA")).toBeNull();
  });
});
