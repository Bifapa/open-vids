// @vitest-environment node
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { RegistryItem } from "@hyperframes/core";
import type { ApplyEditsRequest, EditOperation, TimelineClip } from "@hyperframes/agent-protocol";
import { afterEach, describe, expect, it } from "vitest";
import { isEditFailure } from "./errors.js";
import { applyEdits } from "./operations.js";
import { createTestProject, MAIN_HTML, type TestProject } from "./testProject.js";

const SKINS = join(import.meta.dirname, "../../../../skills/hyperframes-creative/frame-presets");

let project: TestProject | undefined;
afterEach(() => {
  project?.cleanup();
  project = undefined;
});

const BLOCK: RegistryItem = {
  type: "hyperframes:block",
  name: "sparkle",
  title: "Sparkle",
  description: "Sparkles",
  dimensions: { width: 1920, height: 1080 },
  duration: 4,
  files: [
    { path: "sparkle.html", target: "compositions/sparkle.html", type: "hyperframes:composition" },
  ],
};
const SNIPPET: RegistryItem = {
  type: "hyperframes:component",
  name: "badge",
  title: "Badge",
  description: "A badge",
  files: [
    {
      path: "badge.html",
      target: "compositions/components/badge.html",
      type: "hyperframes:snippet",
    },
  ],
};

function withProject(options: Parameters<typeof createTestProject>[0] = {}): TestProject {
  const installs: string[] = [];
  const made = createTestProject({
    ...options,
    adapter: {
      captionSkinsDir: () => SKINS,
      listRegistryCatalog: async () => [BLOCK, SNIPPET],
      installRegistryBlock: async ({ blockName }) => {
        installs.push(blockName);
        const item = blockName === "sparkle" ? BLOCK : SNIPPET;
        const target = item.files[0]?.target ?? "";
        const html =
          item.name === "sparkle"
            ? `<div id="sparkle-root" data-composition-id="sparkle" data-width="1920" data-height="1080" data-duration="4"><div class="clip" data-start="0" data-duration="4" data-track-index="0">✨</div></div>`
            : `<div class="badge">badge</div>`;
        const abs = join(made.project.dir, target);
        mkdirSync(dirname(abs), { recursive: true });
        writeFileSync(abs, html);
        return { written: [target], block: item, primary: target };
      },
      ...options.adapter,
    },
  });
  project = made;
  return made;
}

async function apply(
  operations: EditOperation[],
  request: Omit<ApplyEditsRequest, "operations"> = {},
) {
  if (!project) throw new Error("no project");
  return applyEdits(
    {
      project: project.project,
      compositionPath: request.composition ?? "index.html",
      adapter: project.adapter,
      facts: project.facts,
    },
    { ...request, operations },
  );
}

async function refusal(operations: EditOperation[], request = {}) {
  try {
    await apply(operations, request);
  } catch (error) {
    if (isEditFailure(error)) return error.error;
    throw error;
  }
  throw new Error("expected the batch to be refused");
}

const clipOf = (clips: TimelineClip[], id: string) => {
  const clip = clips.find((candidate) => candidate.id === id || candidate.domId === id);
  if (!clip) throw new Error(`no clip ${id}`);
  return clip;
};

describe("add_clip", () => {
  it("places a video with its probed length, muted state and centered natural geometry", async () => {
    withProject();
    const { results, timeline, changedFiles } = await apply([
      { op: "add_clip", asset: "assets/b.mp4", start: 10, track: 1 },
    ]);
    const id = results[0]?.clipId ?? "";
    const clip = clipOf(timeline.clips, id);
    expect(clip).toMatchObject({
      kind: "video",
      src: "assets/b.mp4",
      start: 10,
      duration: 5,
      track: 1,
      sourceDuration: 5,
      muted: true,
    });
    // b.mp4 has no audio stream, so it stays muted; a.mp4 has one and comes in audible.
    expect(clip.zIndex).toBe(4);
    expect(changedFiles).toContain("index.html");
    const html = project?.read("index.html") ?? "";
    expect(html).toContain("left: 320px; top: 180px; width: 1280px; height: 720px");
    expect(timeline.composition.duration).toBe(15);
  });

  it("keeps an audible source audible, and muted:true forces it silent", async () => {
    withProject();
    const audible = await apply([
      { op: "add_clip", asset: "assets/a.mp4", start: 0, track: 5, volume: 0.4 },
    ]);
    const silent = await apply([
      { op: "add_clip", asset: "assets/a.mp4", start: 0, track: 6, muted: true },
    ]);
    const html = project?.read("index.html") ?? "";
    const first = clipOf(audible.timeline.clips, audible.results[0]?.clipId ?? "");
    expect(first).toMatchObject({ muted: false, volume: 0.4 });
    expect(html).toContain('data-has-audio="true"');
    expect(clipOf(silent.timeline.clips, silent.results[0]?.clipId ?? "")).toMatchObject({
      muted: true,
    });
  });

  it("defaults to the remaining media after mediaStart and writes the in-point", async () => {
    withProject();
    const { results, timeline } = await apply([
      { op: "add_clip", asset: "assets/a.mp4", start: 0, track: 5, mediaStart: 2 },
    ]);
    expect(clipOf(timeline.clips, results[0]?.clipId ?? "")).toMatchObject({
      duration: 6,
      mediaStart: 2,
    });
  });

  it("gives an image 3 seconds (Studio's drop default) and honours fit by filling the frame", async () => {
    withProject();
    const { results, timeline } = await apply([
      { op: "add_clip", asset: "assets/photo.png", start: 0, track: 5, fit: "cover" },
    ]);
    expect(clipOf(timeline.clips, results[0]?.clipId ?? "")).toMatchObject({
      kind: "image",
      duration: 3,
    });
    const html = project?.read("index.html") ?? "";
    expect(html).toContain("object-fit: cover");
    expect(html).toContain("width: 1920px; height: 1080px");
  });

  it("places a visual clip at an explicit frame and moves it later; audio has no frame", async () => {
    withProject();
    const frame = { x: 1500, y: 40, width: 380, height: 380 };
    const { results } = await apply([
      { op: "add_clip", asset: "assets/photo.png", start: 0, track: 2, frame },
    ]);
    expect(project?.read("index.html")).toContain(
      "left: 1500px; top: 40px; width: 380px; height: 380px",
    );
    const clip = results[0]?.clipId ?? "";
    await apply([{ op: "set_clip", clip, frame: { x: 0, y: 0, width: 960, height: 540 } }]);
    const html = project?.read("index.html") ?? "";
    expect(html).toContain("left: 0px");
    expect(html).toContain("width: 960px");
    expect(html).not.toContain("left: 1500px");
    expect(
      await refusal([{ op: "add_clip", asset: "assets/music.mp3", start: 0, track: 3, frame }]),
    ).toMatchObject({ code: "unsupported", opIndex: 0 });
  });

  it("refuses assets that are missing, not media, or outside the project", async () => {
    withProject();
    for (const asset of [
      "assets/missing.mp4",
      "index.html",
      "../secret.mp4",
      "https://x.test/a.mp4",
    ]) {
      expect(await refusal([{ op: "add_clip", asset, start: 0, track: 0 }])).toMatchObject({
        code: "unknown_asset",
        opIndex: 0,
      });
    }
  });

  it("refuses an in-point at or past the end of the media, and a duration past it", async () => {
    withProject();
    expect(
      await refusal([{ op: "add_clip", asset: "assets/b.mp4", start: 0, track: 0, mediaStart: 5 }]),
    ).toMatchObject({ code: "out_of_bounds" });
    expect(
      await refusal([{ op: "add_clip", asset: "assets/b.mp4", start: 0, track: 0, duration: 5.2 }]),
    ).toMatchObject({ code: "out_of_bounds" });
    // Within the 0.05 s frame-rounding tolerance.
    await expect(
      apply([{ op: "add_clip", asset: "assets/b.mp4", start: 0, track: 0, duration: 5.04 }]),
    ).resolves.toBeDefined();
  });
});

describe("fades", () => {
  it("writes data-fade-in / data-fade-out on an added video and audio clip, and drops zero", async () => {
    withProject();
    await apply([
      { op: "add_clip", asset: "assets/a.mp4", start: 20, track: 5, fadeIn: 0.5, fadeOut: 1 },
      {
        op: "add_clip",
        asset: "assets/music.mp3",
        start: 20,
        track: 6,
        duration: 10,
        fadeOut: 2.5,
        fadeIn: 0,
      },
    ]);
    const html = project?.read("index.html") ?? "";
    expect(html).toMatch(/<video id="a"[^>]*data-fade-in="0.5" data-fade-out="1"/);
    expect(html).toMatch(/<audio id="music_2"[^>]*data-fade-out="2.5"/);
    expect(html).not.toContain('data-fade-in="0"');
  });

  it("sets, changes and removes fades with set_clip", async () => {
    withProject();
    await apply([{ op: "set_clip", clip: "music", fadeIn: 1, fadeOut: 2 }]);
    expect(project?.read("index.html")).toMatch(
      /<audio[^>]*data-fade-in="1" data-fade-out="2"|<audio[^>]*data-fade-out="2"[^>]*data-fade-in="1"/,
    );
    await apply([{ op: "set_clip", clip: "music", fadeIn: 0 }]);
    const html = project?.read("index.html") ?? "";
    expect(html).not.toContain("data-fade-in");
    expect(html).toContain('data-fade-out="2"');
  });

  it("refuses fades on images, text and compositions", async () => {
    withProject();
    expect(
      await refusal([{ op: "add_clip", asset: "assets/photo.png", start: 0, track: 0, fadeIn: 1 }]),
    ).toMatchObject({ code: "unsupported", opIndex: 0 });
    expect(await refusal([{ op: "set_clip", clip: "title", fadeOut: 1 }])).toMatchObject({
      code: "unsupported",
    });
    expect(await refusal([{ op: "set_clip", clip: "host", fadeIn: 1 }])).toMatchObject({
      code: "unsupported",
    });
  });

  it("refuses a fade longer than the clip, and fades that together exceed it", async () => {
    withProject();
    expect(
      await refusal([
        { op: "add_clip", asset: "assets/b.mp4", start: 0, track: 0, duration: 2, fadeIn: 3 },
      ]),
    ).toMatchObject({ code: "out_of_bounds" });
    expect(await refusal([{ op: "set_clip", clip: "intro", fadeOut: 4.5 }])).toMatchObject({
      code: "out_of_bounds",
    });
    expect(
      await refusal([{ op: "set_clip", clip: "intro", fadeIn: 2.5, fadeOut: 2 }]),
    ).toMatchObject({ code: "out_of_bounds" });
    // An existing fade counts against a new one on the other edge.
    await apply([{ op: "set_clip", clip: "intro", fadeIn: 3 }]);
    expect(await refusal([{ op: "set_clip", clip: "intro", fadeOut: 1.5 }])).toMatchObject({
      code: "out_of_bounds",
    });
    await expect(apply([{ op: "set_clip", clip: "intro", fadeOut: 1 }])).resolves.toBeDefined();
  });
});

describe("add_text", () => {
  it("adds an escaped, positioned text clip", async () => {
    withProject();
    const { results, timeline } = await apply([
      {
        op: "add_text",
        text: "<b>Q&A</b> time",
        start: 2,
        duration: 3,
        track: 6,
        placement: "top",
        size: "large",
        color: "#ffcc00",
      },
    ]);
    const clip = clipOf(timeline.clips, results[0]?.clipId ?? "");
    expect(clip).toMatchObject({
      kind: "text",
      label: "<b>Q&A</b> time",
      start: 2,
      duration: 3,
      track: 6,
    });
    const html = project?.read("index.html") ?? "";
    expect(html).toContain("&lt;b&gt;Q&amp;A&lt;/b&gt; time");
    expect(html).toContain("top: 86px");
    expect(html).toContain("font-size: 119px");
    expect(html).toContain("color: #ffcc00");
  });

  it("is deterministic: the same batch on the same project writes the same markup", async () => {
    withProject();
    const op: EditOperation = { op: "add_text", text: "Hi", start: 0, duration: 1, track: 7 };
    await apply([op]);
    const first = project?.read("index.html") ?? "";
    project?.write("index.html", MAIN_HTML);
    await apply([op]);
    const strip = (html: string) => html.replace(/hf-[0-9a-f-]{36}/g, "hf-x");
    expect(strip(project?.read("index.html") ?? "")).toBe(strip(first));
  });
});

describe("add_component", () => {
  it("installs a block once, mounts it as a composition clip and follows its length", async () => {
    withProject();
    const { results, timeline, changedFiles } = await apply([
      { op: "add_component", name: "sparkle", start: 8, track: 5 },
    ]);
    const clip = clipOf(timeline.clips, results[0]?.clipId ?? "");
    expect(clip).toMatchObject({
      kind: "composition",
      compositionSrc: "compositions/sparkle.html",
      start: 8,
      duration: 4,
    });
    expect(changedFiles).toEqual(["index.html", "compositions/sparkle.html"]);
    expect(timeline.composition.duration).toBe(12);
  });

  it("lets duration override the host length", async () => {
    withProject();
    const { results, timeline } = await apply([
      { op: "add_component", name: "sparkle", start: 0, track: 5, duration: 2 },
    ]);
    expect(clipOf(timeline.clips, results[0]?.clipId ?? "").duration).toBe(2);
  });

  it("refuses an unknown preset and a snippet that is not a standalone composition", async () => {
    withProject();
    expect(
      await refusal([{ op: "add_component", name: "nope", start: 0, track: 0 }]),
    ).toMatchObject({
      code: "unknown_preset",
    });
    const snippet = await refusal([{ op: "add_component", name: "badge", start: 0, track: 0 }]);
    expect(snippet.code).toBe("unsupported");
    expect(snippet.message).toContain("snippet");
  });

  it("is unsupported when the server has no registry", async () => {
    withProject({ adapter: { listRegistryCatalog: undefined, installRegistryBlock: undefined } });
    expect(
      await refusal([{ op: "add_component", name: "sparkle", start: 0, track: 0 }]),
    ).toMatchObject({
      code: "unsupported",
    });
  });
});

describe("apply_captions", () => {
  it("writes the captions composition from a real skin and mounts one host over the whole composition", async () => {
    withProject();
    const { results, timeline, changedFiles } = await apply([
      {
        op: "apply_captions",
        preset: "coral",
        cues: [
          { text: "Hello there world", start: 0.5, end: 2 },
          { text: "Second cue", start: 2, end: 4 },
        ],
      },
    ]);
    const host = clipOf(timeline.clips, results[0]?.clipId ?? "");
    expect(host).toMatchObject({
      kind: "composition",
      compositionSrc: "compositions/captions.html",
      start: 0,
      duration: 10,
      track: 5,
    });
    expect(changedFiles).toEqual(["index.html", "compositions/captions.html"]);
    // The lint contract that lets the timeline group the clip on the caption track.
    expect(project?.read("index.html")).toContain('data-track-kind="captions"');

    const captions = project?.read("compositions/captions.html") ?? "";
    expect(captions).toMatch(/^<template id="captions-template" data-composition-id="captions"/);
    expect(captions).toContain('data-width="1920" data-height="1080"');
    expect(captions).toContain("var DURATION = 10;");
    expect(captions).toContain('data-duration="10"');
    expect(captions).not.toContain("var GROUPS = [];");
    expect(captions).not.toContain("<!--");
    const groups = /var GROUPS = (\[.*?\]);/s.exec(captions)?.[1];
    const parsed: Array<{
      id: string;
      start: number;
      end: number;
      text: string;
      words: Array<{ text: string; start: number; end: number }>;
    }> = JSON.parse(groups ?? "[]");
    expect(parsed).toHaveLength(2);
    expect(parsed[0]).toMatchObject({
      id: "caption-group-0",
      start: 0.5,
      end: 2,
      text: "Hello there world",
    });
    expect(parsed[0]?.words.map((word) => [word.text, word.start, word.end])).toEqual([
      ["Hello", 0.5, 1],
      ["there", 1, 1.5],
      ["world", 1.5, 2],
    ]);
  });

  it("replaces the captions in place: one caption clip, one file", async () => {
    withProject();
    await apply([
      { op: "apply_captions", preset: "coral", cues: [{ text: "One", start: 0, end: 1 }] },
    ]);
    const second = await apply([
      { op: "apply_captions", preset: "capsule", cues: [{ text: "Two", start: 0, end: 1 }] },
    ]);
    expect(
      second.timeline.clips.filter((clip) => clip.compositionSrc === "compositions/captions.html"),
    ).toHaveLength(1);
    expect(project?.read("compositions/captions.html")).toContain("Two");
    expect(project?.read("compositions/captions.html")).not.toContain('"One"');
  });

  it("refuses unknown presets and cues past the composition end, writing nothing", async () => {
    withProject();
    expect(
      await refusal([
        { op: "apply_captions", preset: "nope", cues: [{ text: "x", start: 0, end: 1 }] },
      ]),
    ).toMatchObject({ code: "unknown_preset" });
    expect(
      await refusal([
        { op: "apply_captions", preset: "../coral", cues: [{ text: "x", start: 0, end: 1 }] },
      ]),
    ).toMatchObject({ code: "unknown_preset" });
    expect(
      await refusal([
        { op: "apply_captions", preset: "coral", cues: [{ text: "late", start: 9, end: 30 }] },
      ]),
    ).toMatchObject({ code: "out_of_bounds" });
    expect(existsSync(join(project?.project.dir ?? "", "compositions/captions.html"))).toBe(false);
  });

  it("captions the content, not a stale declared length", async () => {
    withProject();
    const { results, timeline } = await apply([
      { op: "remove_clip", clip: "music" },
      { op: "remove_clip", clip: "host" },
      { op: "apply_captions", preset: "coral", cues: [{ text: "hi", start: 0, end: 3 }] },
    ]);
    expect(clipOf(timeline.clips, results[2]?.clipId ?? "").duration).toBe(4);
    expect(timeline.composition.duration).toBe(4);
  });
});

describe("remove_clip", () => {
  it("removes the clip and its GSAP tweens", async () => {
    withProject();
    const { timeline } = await apply([{ op: "remove_clip", clip: "title" }]);
    expect(timeline.clips.map((clip) => clip.id)).not.toContain("hf-title");
    expect(project?.read("index.html")).not.toContain('"#title"');
  });

  it("ripples later clips on the same track left by the removed length", async () => {
    withProject();
    await apply([
      { op: "add_clip", asset: "assets/b.mp4", start: 0, track: 8 },
      { op: "add_clip", asset: "assets/photo.png", start: 5, track: 8 },
      { op: "add_clip", asset: "assets/photo.png", start: 20, track: 9 },
    ]);
    const before = (await apply([{ op: "set_composition", duration: 30 }])).timeline;
    const [first, second] = before.clips
      .filter((clip) => clip.track === 8)
      .sort((a, b) => a.start - b.start);
    const other = before.clips.find((clip) => clip.track === 9);
    const { timeline } = await apply([{ op: "remove_clip", clip: first?.id ?? "", ripple: true }]);
    expect(clipOf(timeline.clips, second?.id ?? "").start).toBe(0);
    expect(clipOf(timeline.clips, other?.id ?? "").start).toBe(20);
  });
});

describe("move_clip", () => {
  it("writes start and track and shifts the clip's tweens by the same delta", async () => {
    withProject();
    const { timeline, results } = await apply([
      { op: "move_clip", clip: "hf-title", start: 3, track: 1 },
    ]);
    expect(results[0]).toEqual({ op: "move_clip", clipId: "hf-title", newClipId: null });
    expect(clipOf(timeline.clips, "hf-title")).toMatchObject({ start: 3, track: 1 });
    expect(project?.read("index.html")).toMatch(/tl\.to\("#title", \{[^}]*\}, 3\)/);
  });

  it("accepts the DOM id and extends the composition when a clip moves past its end", async () => {
    withProject();
    const { timeline } = await apply([{ op: "move_clip", clip: "title", start: 12 }]);
    expect(clipOf(timeline.clips, "title").start).toBe(12);
    expect(timeline.composition.duration).toBe(14);
  });
});

describe("trim_clip", () => {
  it("head-trimming a video advances its in-point and keeps the tail", async () => {
    withProject();
    const { timeline } = await apply([{ op: "trim_clip", clip: "intro", start: 1.5 }]);
    expect(clipOf(timeline.clips, "intro")).toMatchObject({
      start: 1.5,
      end: 4,
      duration: 2.5,
      mediaStart: 1.5,
    });
  });

  it("refuses to pull a head earlier than the media has, and a tail past the source", async () => {
    withProject();
    expect(
      await refusal([
        { op: "trim_clip", clip: "intro", start: 0 },
        { op: "trim_clip", clip: "intro", end: 9 },
      ]),
    ).toMatchObject({
      code: "out_of_bounds",
      opIndex: 1,
    });
    project?.write(
      "index.html",
      MAIN_HTML.replace(
        'data-start="0" data-duration="4" data-track-index="0" muted',
        'data-start="2" data-duration="4" data-track-index="0" muted',
      ),
    );
    expect(await refusal([{ op: "trim_clip", clip: "intro", start: 1 }])).toMatchObject({
      code: "out_of_bounds",
    });
  });

  it("extends a tail up to the source end and lets text and images grow freely", async () => {
    withProject();
    const { timeline } = await apply([
      { op: "trim_clip", clip: "intro", end: 8 },
      { op: "trim_clip", clip: "title", end: 60 },
    ]);
    expect(clipOf(timeline.clips, "intro").duration).toBe(8);
    expect(clipOf(timeline.clips, "title").end).toBe(60);
  });

  it("rescales the clip's tweens with the new span", async () => {
    withProject();
    await apply([{ op: "trim_clip", clip: "title", start: 1, end: 5 }]);
    expect(project?.read("index.html")).toMatch(/duration: 2/);
  });

  it("refuses an empty result", async () => {
    withProject();
    expect(await refusal([{ op: "trim_clip", clip: "title", start: 2.5, end: 2.5 }])).toMatchObject(
      {
        code: "out_of_bounds",
      },
    );
  });
});

describe("split_clip", () => {
  it("splits a video into two halves that continue the source", async () => {
    withProject();
    const { timeline, results } = await apply([{ op: "split_clip", clip: "intro", at: 1.5 }]);
    const second = clipOf(timeline.clips, results[0]?.newClipId ?? "");
    expect(second).toMatchObject({
      start: 1.5,
      duration: 2.5,
      mediaStart: 1.5,
      src: "assets/a.mp4",
      track: 0,
    });
    expect(clipOf(timeline.clips, "hf-intro")).toMatchObject({
      start: 0,
      duration: 1.5,
      mediaStart: 0,
    });
    expect(second.id).not.toBe("hf-intro");
  });

  it("splits the clip's animations onto the new half", async () => {
    withProject();
    const { results } = await apply([{ op: "split_clip", clip: "title", at: 2 }]);
    expect(results[0]?.newClipId).toBeTruthy();
    expect(project?.read("index.html")).toContain('"#title-split"');
  });

  it("refuses a cut outside, or on the edge of, the clip", async () => {
    withProject();
    for (const at of [0.0005, 4, 9]) {
      expect(await refusal([{ op: "split_clip", clip: "intro", at }])).toMatchObject({
        code: "out_of_bounds",
      });
    }
  });
});

describe("set_clip", () => {
  it("sets volume, fit and z-index", async () => {
    withProject();
    const { timeline } = await apply([
      { op: "set_clip", clip: "music", volume: 0.2 },
      { op: "set_clip", clip: "intro", fit: "cover", zIndex: 9 },
    ]);
    expect(clipOf(timeline.clips, "music").volume).toBe(0.2);
    expect(clipOf(timeline.clips, "intro").zIndex).toBe(9);
    expect(project?.read("index.html")).toContain("object-fit: cover");
  });

  it("keeps muted and data-has-audio consistent", async () => {
    withProject();
    await apply([{ op: "add_clip", asset: "assets/a.mp4", start: 0, track: 5 }]);
    const video = (await apply([{ op: "set_composition", duration: 10 }])).timeline.clips.find(
      (clip) => clip.track === 5,
    );
    await apply([{ op: "set_clip", clip: video?.id ?? "", muted: true }]);
    const muted = project?.read("index.html") ?? "";
    expect(muted).not.toMatch(/muted[^>]*data-has-audio|data-has-audio[^>]*muted/);
    const { timeline } = await apply([{ op: "set_clip", clip: video?.id ?? "", muted: false }]);
    expect(clipOf(timeline.clips, video?.id ?? "").muted).toBe(false);
    expect(project?.read("index.html")).toContain('data-has-audio="true"');
  });

  it("refuses properties the clip kind does not have", async () => {
    withProject();
    expect(await refusal([{ op: "set_clip", clip: "title", volume: 1 }])).toMatchObject({
      code: "unsupported",
    });
    expect(await refusal([{ op: "set_clip", clip: "music", fit: "cover" }])).toMatchObject({
      code: "unsupported",
    });
  });
});

describe("arrange_track", () => {
  it("lays clips end to end on a track in the given order, with a gap", async () => {
    withProject();
    const { timeline } = await apply([
      { op: "arrange_track", track: 1, clips: ["title", "intro"], start: 2, gap: 0.5 },
    ]);
    expect(clipOf(timeline.clips, "title")).toMatchObject({ track: 1, start: 2, end: 4 });
    expect(clipOf(timeline.clips, "intro")).toMatchObject({ track: 1, start: 4.5, end: 8.5 });
    expect(project?.read("index.html")).toMatch(/tl\.to\("#title", \{[^}]*\}, 2\)/);
  });
});

describe("set_composition and the length rule", () => {
  it("follows the furthest clip end, growing and shrinking", async () => {
    withProject();
    const grown = await apply([{ op: "move_clip", clip: "music", start: 5 }]);
    expect(grown.timeline.composition.duration).toBe(15);
    const shrunk = await apply([
      { op: "remove_clip", clip: "music" },
      { op: "remove_clip", clip: "host" },
    ]);
    expect(shrunk.timeline.composition.duration).toBe(4);
  });

  it("keeps an explicit length, and leaves the length alone with no clips", async () => {
    withProject();
    const explicit = await apply([
      { op: "set_composition", duration: 30 },
      { op: "move_clip", clip: "music", start: 5 },
    ]);
    expect(explicit.timeline.composition.duration).toBe(30);
    withProject({
      html: `<div data-composition-id="main" data-width="640" data-height="360" data-duration="12"></div>`,
    });
    const empty = await apply([{ op: "set_composition", duration: 12 }]);
    expect(empty.timeline.composition.duration).toBe(12);
  });
});

describe("batch validation against the project", () => {
  it("refuses an unknown clip with its index, and names the known clips", async () => {
    withProject();
    const error = await refusal([
      { op: "move_clip", clip: "hf-title", start: 4 },
      { op: "remove_clip", clip: "ghost" },
    ]);
    expect(error).toMatchObject({ code: "unknown_clip", opIndex: 1 });
    expect(error.message).toContain("hf-intro");
  });

  it("refuses to touch a locked clip", async () => {
    withProject({
      html: MAIN_HTML.replace('id="title" ', 'id="title" data-timeline-locked="" '),
    });
    expect(await refusal([{ op: "move_clip", clip: "title", start: 4 }])).toMatchObject({
      code: "locked",
    });
    expect(
      await refusal([
        { op: "remove_clip", clip: "intro", ripple: true },
        { op: "set_clip", clip: "title", zIndex: 1 },
      ]),
    ).toMatchObject({ code: "locked", opIndex: 1 });
  });

  it("refuses a missing or non-composition target and a stale baseVersion", async () => {
    withProject();
    project?.write("plain.html", "<p>x</p>");
    expect(
      await refusal([{ op: "set_composition", duration: 5 }], { composition: "missing.html" }),
    ).toMatchObject({
      code: "unknown_composition",
    });
    expect(
      await refusal([{ op: "set_composition", duration: 5 }], { composition: "plain.html" }),
    ).toMatchObject({
      code: "unknown_composition",
    });
    expect(
      await refusal([{ op: "set_composition", duration: 5 }], { baseVersion: '"sha256:stale"' }),
    ).toMatchObject({
      code: "conflict",
    });
  });

  it("accepts the version of the file it read, and returns the next one", async () => {
    withProject();
    const first = await apply([{ op: "set_composition", duration: 20 }]);
    const second = await apply([{ op: "set_composition", duration: 21 }], {
      baseVersion: first.timeline.version,
    });
    expect(second.timeline.version).not.toBe(first.timeline.version);
    // Models copy the token without the ETag quotes; both spellings name the same version.
    expect(second.timeline.version).toMatch(/^sha256:[0-9a-f]{64}$/);
    const third = await apply([{ op: "set_composition", duration: 23 }], {
      baseVersion: `"${second.timeline.version}"`,
    });
    expect(third.timeline.composition.duration).toBe(23);
    expect(
      await refusal([{ op: "set_composition", duration: 22 }], {
        baseVersion: first.timeline.version,
      }),
    ).toMatchObject({
      code: "conflict",
    });
  });

  it("edits a sub-composition file", async () => {
    withProject();
    const { timeline } = await apply(
      [{ op: "add_text", text: "In lower third", start: 0, duration: 1, track: 3 }],
      {
        composition: "compositions/lower-third.html",
      },
    );
    expect(timeline.composition.path).toBe("compositions/lower-third.html");
    expect(timeline.clips.map((clip) => clip.label)).toContain("In lower third");
  });
});

describe("atomicity", () => {
  it("leaves every file byte-identical when a later operation fails", async () => {
    withProject();
    const dir = project?.project.dir ?? "";
    const before = readFileSync(join(dir, "index.html"), "utf-8");
    const error = await refusal([
      { op: "add_clip", asset: "assets/b.mp4", start: 10, track: 1 },
      { op: "add_text", text: "kept?", start: 0, duration: 1, track: 2 },
      { op: "apply_captions", preset: "coral", cues: [{ text: "x", start: 0, end: 1 }] },
      { op: "split_clip", clip: "intro", at: 99 },
    ]);
    expect(error).toMatchObject({ code: "out_of_bounds", opIndex: 3 });
    expect(readFileSync(join(dir, "index.html"), "utf-8")).toBe(before);
    expect(existsSync(join(dir, "compositions/captions.html"))).toBe(false);
  });

  it("writes a backup of the composition before replacing it", async () => {
    withProject();
    await apply([{ op: "set_composition", duration: 20 }]);
    expect(existsSync(join(project?.project.dir ?? "", ".hyperframes/backup"))).toBe(true);
  });
});
