// @vitest-environment node
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, posix } from "node:path";
import type { RegistryItem } from "@hyperframes/core";
import type { ApplyEditsRequest, EditOperation, TimelineClip } from "@hyperframes/agent-protocol";
import { afterEach, describe, expect, it } from "vitest";
import { writeAssetRanges } from "./assetRanges.js";
import { captionsFileFor } from "./captions.js";
import { isEditFailure } from "./errors.js";
import { stampFileHfIds } from "../helpers/hfIdPersist.js";
import { applyEdits } from "./operations.js";
import { MediaFacts } from "./mediaFacts.js";
import {
  FAKE_MEDIA,
  createTestProject,
  fakeProber,
  MAIN_HTML,
  type TestProject,
} from "./testProject.js";
import { readTimeline } from "./service.js";

const SKINS = join(import.meta.dirname, "../../../../skills/hyperframes-creative/frame-presets");

let project: TestProject | undefined;
afterEach(() => {
  project?.cleanup();
  project = undefined;
});

// Linear work measures ~8x between scale 1 and scale 8, quadratic work ~64x. Only the ratio is
// asserted: an absolute millisecond bound is a claim about the hardware. CPU time keeps time spent
// descheduled on a shared runner out of the sample; Windows' CPU clock ticks at ~15 ms, so there
// wall time is used instead.
async function cpuTimed<T>(work: () => Promise<T>): Promise<{ value: T; ms: number }> {
  const wall = performance.now();
  const cpu = process.cpuUsage();
  const value = await work();
  const spent = process.cpuUsage(cpu);
  const ms =
    process.platform === "win32" ? performance.now() - wall : (spent.user + spent.system) / 1000;
  return { value, ms };
}

async function expectLinearCost<T>(
  sample: (scale: number) => Promise<{ value: T; ms: number }>,
): Promise<{ small: { value: T; ms: number }; large: { value: T; ms: number } }> {
  const best = async (scale: number) => {
    let fastest = await sample(scale);
    const again = await sample(scale);
    if (again.ms < fastest.ms) fastest = again;
    return fastest;
  };
  const small = await best(1);
  const large = await best(8);
  // Fixed per-batch work (project read, parse, write) dominates the small sample, so this only
  // fails when cost grows faster than the clip count.
  expect(large.ms / Math.max(small.ms, 1)).toBeLessThan(24);
  return { small, large };
}

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
  it("places a video with its probed length, muted state, filling the frame like a Studio drop", async () => {
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
    // The 1280×720 source fills the 1920×1080 frame (scaled), not a centred postage stamp.
    expect(html).toContain("left: 0px; top: 0px; width: 1920px; height: 1080px");
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

describe("add_sequence", () => {
  const sortedByStart = (clips: TimelineClip[], track: number) =>
    clips.filter((clip) => clip.track === track).sort((a, b) => a.start - b.start);

  it("lays the ranges end to end with the source in-points and reports every clip id in order", async () => {
    withProject();
    const { results, timeline, changedFiles } = await apply([
      {
        op: "add_sequence",
        asset: "assets/a.mp4",
        track: 5,
        start: 2,
        ranges: [
          { from: 0, to: 1.5 },
          { from: 4.25, to: 5 },
          { from: 6, to: 7.999 },
        ],
        volume: 0.6,
      },
    ]);
    const ids = results[0]?.clipIds ?? [];
    expect(ids).toHaveLength(3);
    expect(results[0]?.clipId).toBe(ids[0]);

    const clips = ids.map((id) => clipOf(timeline.clips, id));
    expect(clips.map((clip) => [clip.start, clip.duration, clip.mediaStart])).toEqual([
      [2, 1.5, 0],
      [3.5, 0.75, 4.25],
      [4.25, 1.999, 6],
    ]);
    expect(clips.every((clip) => clip.track === 5 && clip.src === "assets/a.mp4")).toBe(true);
    expect(clips.every((clip) => clip.volume === 0.6 && !clip.muted)).toBe(true);
    expect(new Set(clips.map((clip) => clip.domId)).size).toBe(3);
    // Non-overlapping clips share one stacking level, above everything that was already there.
    expect(new Set(clips.map((clip) => clip.zIndex))).toEqual(new Set([4]));
    expect(sortedByStart(timeline.clips, 5).map((clip) => clip.id)).toEqual(ids);
    expect(timeline.composition.duration).toBeCloseTo(10, 5);
    expect(changedFiles).toEqual(["index.html"]);
  });

  it("starts at 0 by default and gives a following operation the finished timeline", async () => {
    withProject();
    const { results, timeline } = await apply([
      {
        op: "add_sequence",
        asset: "assets/b.mp4",
        track: 7,
        ranges: [
          { from: 1, to: 2 },
          { from: 3, to: 5 },
        ],
      },
      { op: "set_composition", duration: 12 },
    ]);
    expect(sortedByStart(timeline.clips, 7).map((clip) => [clip.start, clip.end])).toEqual([
      [0, 1],
      [1, 3],
    ]);
    expect(results.map((result) => result.op)).toEqual(["add_sequence", "set_composition"]);
    expect(timeline.composition.duration).toBe(12);
  });

  it("writes edge fades on every clip, shortened for a range that cannot hold them", async () => {
    withProject();
    const { results, timeline } = await apply([
      {
        op: "add_sequence",
        asset: "assets/a.mp4",
        track: 5,
        ranges: [
          { from: 0, to: 2 },
          { from: 3, to: 3.02 },
        ],
        edgeFade: 0.05,
      },
    ]);
    const html = project?.read("index.html") ?? "";
    expect(html.match(/data-fade-in="0.05" data-fade-out="0.05"/g)).toHaveLength(1);
    expect(html).toMatch(/data-duration="0.02"[^>]*data-fade-in="0.01" data-fade-out="0.01"/);
    expect(results[0]?.clipIds).toHaveLength(2);
    expect(timeline.clips.filter((clip) => clip.track === 5)).toHaveLength(2);
  });

  it("omits fades without edgeFade", async () => {
    withProject();
    await apply([
      { op: "add_sequence", asset: "assets/a.mp4", track: 5, ranges: [{ from: 0, to: 2 }] },
    ]);
    expect(project?.read("index.html")).not.toContain("data-fade");
  });

  it("cuts an audio-only asset into audio clips with ramps, and refuses a frame for it", async () => {
    withProject();
    const { results, timeline } = await apply([
      {
        op: "add_sequence",
        asset: "assets/music.mp3",
        track: 8,
        ranges: [
          { from: 5, to: 8 },
          { from: 20, to: 25 },
        ],
        edgeFade: 0.02,
      },
    ]);
    const clips = (results[0]?.clipIds ?? []).map((id) => clipOf(timeline.clips, id));
    expect(clips.map((clip) => [clip.kind, clip.start, clip.duration, clip.mediaStart])).toEqual([
      ["audio", 0, 3, 5],
      ["audio", 3, 5, 20],
    ]);
    expect(project?.read("index.html")).toMatch(
      /<audio id="music_2"[^>]*data-media-start="5" data-fade-in="0.02" data-fade-out="0.02"/,
    );
    expect(
      await refusal([
        {
          op: "add_sequence",
          asset: "assets/music.mp3",
          track: 8,
          ranges: [{ from: 0, to: 1 }],
          frame: { x: 0, y: 0, width: 100, height: 100 },
        },
      ]),
    ).toMatchObject({ code: "unsupported", opIndex: 0 });
  });

  it("passes muted, fit and frame through to the video clips", async () => {
    withProject();
    await apply([
      {
        op: "add_sequence",
        asset: "assets/a.mp4",
        track: 5,
        ranges: [{ from: 0, to: 1 }],
        muted: true,
        frame: { x: 1500, y: 40, width: 380, height: 214 },
      },
      {
        op: "add_sequence",
        asset: "assets/a.mp4",
        track: 6,
        ranges: [{ from: 0, to: 1 }],
        fit: "cover",
      },
    ]);
    const html = project?.read("index.html") ?? "";
    expect(html).toContain("left: 1500px; top: 40px; width: 380px; height: 214px");
    expect(html).toMatch(/<video id="a"[^>]* muted[^>]*object-fit: contain/);
    expect(html).toMatch(/<video id="a_2"[^>]*data-has-audio="true"[^>]*object-fit: cover/);
  });

  it("refuses images and non-media, and unknown assets", async () => {
    withProject();
    const ranges = [{ from: 0, to: 1 }];
    expect(
      await refusal([{ op: "add_sequence", asset: "assets/photo.png", track: 0, ranges }]),
    ).toMatchObject({ code: "unsupported", opIndex: 0 });
    for (const asset of ["assets/fonts/brand.woff2", "assets/missing.mp4", "../outside.mp4"]) {
      expect(await refusal([{ op: "add_sequence", asset, track: 0, ranges }])).toMatchObject({
        code: "unknown_asset",
      });
    }
  });

  it("refuses a range past the end of the source, naming it, and leaves the file untouched", async () => {
    withProject();
    const before = project?.read("index.html");
    const error = await refusal([
      { op: "add_text", text: "kept out", start: 0, duration: 1, track: 9 },
      {
        op: "add_sequence",
        asset: "assets/b.mp4",
        track: 1,
        ranges: [
          { from: 0, to: 2 },
          { from: 3, to: 4 },
          { from: 4.5, to: 5.5 },
        ],
      },
    ]);
    expect(error).toMatchObject({ code: "out_of_bounds", opIndex: 1 });
    expect(error.message).toContain("ranges[2]");
    expect(project?.read("index.html")).toBe(before);

    expect(
      await refusal([
        { op: "add_sequence", asset: "assets/b.mp4", track: 1, ranges: [{ from: 5, to: 5.5 }] },
      ]),
    ).toMatchObject({ code: "out_of_bounds" });
    // Within the frame-rounding tolerance of the end of the media.
    await expect(
      apply([
        { op: "add_sequence", asset: "assets/b.mp4", track: 1, ranges: [{ from: 4, to: 5.04 }] },
      ]),
    ).resolves.toBeDefined();
  });

  describe("on a long source", () => {
    const SOURCE_SECONDS = 25 * 60;
    afterEach(() => {
      delete FAKE_MEDIA["talk.mp4"];
    });

    it("applies a 400-range cut in one pass, in time linear in the range count, and the timeline reads back", async () => {
      const cutOnce = async (scale: number) => {
        project?.cleanup();
        withProject();
        FAKE_MEDIA["talk.mp4"] = {
          kind: "video",
          durationSeconds: SOURCE_SECONDS,
          width: 1920,
          height: 1080,
          hasAudio: true,
        };
        project?.write("assets/talk.mp4", "bytes of talk.mp4");
        const ranges = Array.from({ length: 50 * scale }, (_, index) => ({
          from: index * 3.5,
          to: index * 3.5 + 3,
        }));
        const made = project;
        if (!made) throw new Error("no project");
        const sampled = await cpuTimed(() =>
          apply([
            { op: "add_sequence", asset: "assets/talk.mp4", track: 0, ranges, edgeFade: 0.02 },
          ]),
        );
        // Read back here: the sample kept is the faster of two runs, and the next run replaces the project.
        const reread = await readTimeline(made.project, "index.html", made.facts);
        return { ...sampled, value: { ...sampled.value, reread } };
      };
      const { large } = await expectLinearCost(cutOnce);
      const { results, timeline } = large.value;

      expect(results[0]?.clipIds).toHaveLength(400);
      const clips = sortedByStart(timeline.clips, 0).filter(
        (clip) => clip.src === "assets/talk.mp4",
      );
      expect(clips).toHaveLength(400);
      expect(clips.map((clip) => clip.id)).toEqual(results[0]?.clipIds);
      for (const [index, clip] of clips.entries()) {
        expect(clip.start).toBeCloseTo(index * 3, 3);
        expect(clip.duration).toBe(3);
        expect(clip.mediaStart).toBeCloseTo(index * 3.5, 3);
        expect(clip.sourceDuration).toBe(SOURCE_SECONDS);
      }
      expect(new Set(clips.map((clip) => clip.domId)).size).toBe(400);
      expect(timeline.composition.duration).toBeCloseTo(1200, 3);
      // The written file parses back to the same timeline the response carried (read inside the run that made it).
      expect(large.value.reread).toEqual(timeline);
    });
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

  it("leaves a component file the install kept (the user edited it) as the user wrote it", async () => {
    const COMPONENT: RegistryItem = {
      type: "hyperframes:component",
      name: "panel",
      title: "Panel",
      description: "A panel",
      dimensions: { width: 1920, height: 1080 },
      duration: 4,
      files: [
        {
          path: "panel.html",
          target: "compositions/panel.html",
          type: "hyperframes:composition",
        },
      ],
    };
    const panel = `<div id="panel-root" data-composition-id="panel" data-width="1920" data-height="1080" data-duration="4" style="background: #000;"><div class="clip" data-start="0" data-duration="4" data-track-index="0" style="background: rgb(10, 20, 30);">x</div></div>`;
    let freshlyWritten = false;
    const made = withProject({
      adapter: {
        listRegistryCatalog: async () => [COMPONENT],
        installRegistryBlock: async () => ({
          written: freshlyWritten ? ["compositions/panel.html"] : [],
          block: COMPONENT,
          primary: "compositions/panel.html",
        }),
      },
    });
    made.write("compositions/panel.html", panel);

    await apply([{ op: "add_component", name: "panel", start: 0, track: 5 }]);
    expect(made.read("compositions/panel.html")).toBe(panel);

    freshlyWritten = true;
    await apply([{ op: "add_component", name: "panel", start: 0, track: 6 }]);
    expect(made.read("compositions/panel.html")).toContain("background: transparent;");
    expect(made.read("compositions/panel.html")).not.toContain("rgb(10, 20, 30)");
  });
});

describe("apply_captions", () => {
  it("writes the captions file with its stable ids, so the host's id stamping never rewrites it", async () => {
    withProject();
    await apply([
      { op: "apply_captions", preset: "coral", cues: [{ text: "Hi", start: 0, end: 1 }] },
    ]);
    const path = join(project?.project.dir ?? "", "compositions/captions.html");
    const written = readFileSync(path, "utf-8");
    expect(written).toContain("data-hf-id=");
    stampFileHfIds(path);
    expect(readFileSync(path, "utf-8")).toBe(written);
  });

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

  it("keeps the captions above clips placed after them, and lifts an old host buried under footage", async () => {
    withProject();
    const made = await apply([
      { op: "apply_captions", preset: "coral", cues: [{ text: "One", start: 0, end: 1 }] },
    ]);
    const hostId = made.results[0]?.clipId ?? "";
    const later = await apply([
      { op: "add_clip", asset: "assets/b.mp4", start: 0, track: 3 },
      { op: "add_text", text: "Title", start: 0, duration: 1, track: 4 },
    ]);
    const z = (id: string, clips: typeof later.timeline.clips) => clipOf(clips, id).zIndex ?? 0;
    const host = z(hostId, later.timeline.clips);
    for (const result of later.results)
      expect(z(result.clipId ?? "", later.timeline.clips)).toBeLessThan(host);

    // A host made before the band (z 2) under a B-roll shot comes back on top when captions are re-applied.
    const html = project?.read("index.html") ?? "";
    project?.write("index.html", html.replace(`z-index: ${host}`, "z-index: 2"));
    const buried = await apply([
      { op: "add_clip", asset: "assets/b.mp4", start: 0, track: 5 },
      { op: "apply_captions", preset: "coral", cues: [{ text: "Two", start: 0, end: 1 }] },
    ]);
    const topClip = z(buried.results[0]?.clipId ?? "", buried.timeline.clips);
    expect(z(hostId, buried.timeline.clips)).toBeGreaterThan(topClip);
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

  it("gives each composition its own captions file, so captioning a scene leaves the main captions and their lock alone", async () => {
    withProject();
    await apply([
      { op: "apply_captions", preset: "coral", cues: [{ text: "Main cue", start: 0, end: 1 }] },
    ]);
    const lockedHtml = (project?.read("index.html") ?? "").replace(
      'data-track-kind="captions"',
      'data-track-kind="captions" data-timeline-locked',
    );
    project?.write("index.html", lockedHtml);
    expect(
      await refusal([
        { op: "apply_captions", preset: "coral", cues: [{ text: "Locked out", start: 0, end: 1 }] },
      ]),
    ).toMatchObject({ code: "locked" });

    const scene = await apply(
      [{ op: "apply_captions", preset: "coral", cues: [{ text: "Scene cue", start: 0, end: 1 }] }],
      { composition: "compositions/lower-third.html" },
    );
    const sceneFile = captionsFileFor("compositions/lower-third.html");
    expect(scene.changedFiles).toEqual(["compositions/lower-third.html", sceneFile]);
    expect(project?.read(sceneFile)).toContain("Scene cue");
    expect(project?.read("compositions/captions.html")).toContain("Main cue");
    expect(project?.read("compositions/captions.html")).not.toContain("Scene cue");
    expect(project?.read("index.html")).toBe(lockedHtml);
  });

  it("re-captions a scene whose host still mounts the shared captions file, repointing it instead of adding a layer", async () => {
    withProject();
    const scene = { composition: "compositions/lower-third.html" };
    await apply(
      [{ op: "apply_captions", preset: "coral", cues: [{ text: "Old cue", start: 0, end: 1 }] }],
      scene,
    );
    const ownFile = captionsFileFor(scene.composition);
    // The state captions applied before every composition had its own file left behind.
    const legacy = (project?.read(scene.composition) ?? "").replace(
      `data-composition-src="${posix.basename(ownFile)}"`,
      'data-composition-src="captions.html"',
    );
    expect(legacy).toContain('data-composition-src="captions.html"');
    project?.write(scene.composition, legacy);
    project?.write("compositions/captions.html", "<template>main captions</template>");

    const second = await apply(
      [{ op: "apply_captions", preset: "coral", cues: [{ text: "New cue", start: 0, end: 1 }] }],
      scene,
    );
    const hosts = second.timeline.clips.filter((clip) => clip.compositionSrc !== null);
    expect(hosts.map((clip) => clip.compositionSrc)).toEqual([ownFile]);
    expect(project?.read(ownFile)).toContain("New cue");
    expect(project?.read("compositions/captions.html")).toBe("<template>main captions</template>");

    // A lock the user put on the old host is still honoured.
    project?.write(
      scene.composition,
      (project?.read(scene.composition) ?? "").replace(
        'data-track-kind="captions"',
        'data-track-kind="captions" data-timeline-locked',
      ),
    );
    expect(
      await refusal(
        [{ op: "apply_captions", preset: "coral", cues: [{ text: "x", start: 0, end: 1 }] }],
        scene,
      ),
    ).toMatchObject({ code: "locked" });
  });

  it("captions span the composition's length, which a removal does not shrink", async () => {
    withProject();
    const { results, timeline } = await apply([
      { op: "remove_clip", clip: "music" },
      { op: "remove_clip", clip: "host" },
      { op: "apply_captions", preset: "coral", cues: [{ text: "hi", start: 0, end: 3 }] },
    ]);
    expect(clipOf(timeline.clips, results[2]?.clipId ?? "").duration).toBe(10);
    expect(timeline.composition.duration).toBe(10);
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

describe("remove_clip with clips", () => {
  it("removes every named clip (by stable or DOM id) and their tweens in one operation", async () => {
    withProject();
    const { results, timeline } = await apply([
      { op: "remove_clip", clips: ["title", "hf-music", "host"] },
    ]);
    expect(results[0]).toMatchObject({
      clipId: "hf-title",
      clipIds: ["hf-title", "hf-music", "hf-host"],
    });
    expect(timeline.clips.map((clip) => clip.id)).toEqual(["hf-intro"]);
    expect(project?.read("index.html")).not.toContain('"#title"');
  });

  it("refuses the whole operation, leaving the file alone, when one id is unknown or locked", async () => {
    withProject({ html: MAIN_HTML.replace('id="title" ', 'id="title" data-timeline-locked="" ') });
    const before = project?.read("index.html");
    expect(await refusal([{ op: "remove_clip", clips: ["music", "ghost"] }])).toMatchObject({
      code: "unknown_clip",
      opIndex: 0,
    });
    expect(await refusal([{ op: "remove_clip", clips: ["music", "title"] }])).toMatchObject({
      code: "locked",
    });
    expect(await refusal([{ op: "remove_clip", clips: ["music", "hf-music"] }])).toMatchObject({
      code: "invalid_request",
    });
    expect(project?.read("index.html")).toBe(before);
  });

  it("ripples each removed clip's gap on its track", async () => {
    withProject();
    await apply([
      { op: "add_clip", asset: "assets/b.mp4", start: 0, track: 8 },
      { op: "add_clip", asset: "assets/b.mp4", start: 5, track: 8 },
      { op: "add_clip", asset: "assets/b.mp4", start: 10, track: 8 },
    ]);
    const onTrack = (await apply([{ op: "set_composition", duration: 20 }])).timeline.clips
      .filter((clip) => clip.track === 8)
      .sort((a, b) => a.start - b.start);
    const [first, second, third] = onTrack.map((clip) => clip.id);
    const { timeline } = await apply([
      { op: "remove_clip", clips: [first ?? "", second ?? ""], ripple: true },
    ]);
    expect(clipOf(timeline.clips, third ?? "").start).toBe(0);
  });

  it("replaces a cut with a new one in one atomic batch, in time linear in the clip count", async () => {
    const cut = (count: number, step: number) =>
      Array.from({ length: count }, (_, index) => ({
        from: index * step,
        to: index * step + step - 0.5,
      }));
    const replaceCut = async (scale: number) => {
      project?.cleanup();
      withProject();
      FAKE_MEDIA["talk.mp4"] = {
        kind: "video",
        durationSeconds: 1500,
        width: 1920,
        height: 1080,
        hasAudio: true,
      };
      project?.write("assets/talk.mp4", "bytes of talk.mp4");
      const first = await apply([
        { op: "add_sequence", asset: "assets/talk.mp4", track: 0, ranges: cut(40 * scale, 4) },
      ]);
      const previous = first.results[0]?.clipIds ?? [];
      expect(previous).toHaveLength(40 * scale);
      return cpuTimed(() =>
        apply([
          { op: "remove_clip", clips: previous },
          { op: "add_sequence", asset: "assets/talk.mp4", track: 0, ranges: cut(25 * scale, 5) },
          { op: "set_composition", duration: 900 },
        ]),
      );
    };
    try {
      const { large } = await expectLinearCost(replaceCut);
      const { results, timeline } = large.value;
      const rebuilt = timeline.clips.filter((clip) => clip.src === "assets/talk.mp4");
      expect(rebuilt.map((clip) => clip.id)).toEqual(results[1]?.clipIds);
      expect(rebuilt).toHaveLength(200);
      expect(timeline.composition.duration).toBe(900);
    } finally {
      delete FAKE_MEDIA["talk.mp4"];
    }
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

  it("leaves data-start alone when only the track changes, keeping reference and unresolved starts", async () => {
    withProject({
      html: `<div id="root" data-composition-id="main" data-width="1920" data-height="1080" data-duration="10">
        <div id="first" data-hf-id="hf-first" class="clip" data-start="1" data-duration="2" data-track-index="0">a</div>
        <div id="second" data-hf-id="hf-second" class="clip" data-start="first + 0.5" data-duration="1" data-track-index="0">b</div>
        <div id="third" data-hf-id="hf-third" class="clip" data-start="ghost" data-duration="1" data-track-index="0">c</div>
      </div>`,
    });
    await apply([
      { op: "move_clip", clip: "second", track: 2 },
      { op: "move_clip", clip: "third", track: 3 },
    ]);
    const html = project?.read("index.html") ?? "";
    expect(html).toMatch(/id="second"[^>]*data-start="first \+ 0\.5"[^>]*data-track-index="2"/);
    expect(html).toMatch(/id="third"[^>]*data-start="ghost"[^>]*data-track-index="3"/);
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
  it("grows with the furthest clip end but never shrinks by itself", async () => {
    withProject();
    const grown = await apply([{ op: "move_clip", clip: "music", start: 5 }]);
    expect(grown.timeline.composition.duration).toBe(15);
    const trimmed = await apply([
      { op: "remove_clip", clip: "music" },
      { op: "remove_clip", clip: "host" },
    ]);
    // The tail the batch left behind is the user's to cut: only set_composition shortens.
    expect(trimmed.timeline.composition.duration).toBe(15);
    const shortened = await apply([{ op: "set_composition", duration: 4 }]);
    expect(shortened.timeline.composition.duration).toBe(4);
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

describe("set_canvas", () => {
  const TEMPLATE_HTML = `<!doctype html>
<html>
  <head>
    <meta name="viewport" content="width=1920, height=1080">
    <style>
      html,
      body {
        margin: 0;
        width: 1920px;
        height: 1080px;
        overflow: hidden;
      }
      #root { width: 100%; height: 100%; }
    </style>
  </head>
  <body>
    <div id="root" data-composition-id="main" data-width="1920" data-height="1080" data-duration="5">
      <div id="title" data-hf-id="hf-title" class="clip" data-start="0" data-duration="2" data-track-index="0" style="position: absolute; width: 640px; height: 360px">Hi</div>
    </div>
  </body>
</html>`;

  it("rewrites the root, the stage CSS and the viewport meta, and leaves clip frames alone", async () => {
    const made = withProject({ html: TEMPLATE_HTML });
    const response = await apply([{ op: "set_canvas", width: 1080, height: 1920 }]);
    expect(response.changedFiles).toEqual(["index.html"]);
    expect(response.timeline.composition).toMatchObject({
      path: "index.html",
      width: 1080,
      height: 1920,
    });
    const html = made.read("index.html");
    expect(html).toContain('data-width="1080"');
    expect(html).toContain('data-height="1920"');
    expect(html).toContain("width: 1080px");
    expect(html).toContain("height: 1920px");
    expect(html).toContain("width=1080");
    expect(html).toContain("height=1920");
    expect(html).not.toContain("width: 1920px");
    expect(html).toContain("width: 640px");
    expect(html).toContain("width: 100%");
  });

  it("sets the canvas in the same batch an empty composition is built into", async () => {
    const made = withProject({
      html: `<div id="root" data-composition-id="main" data-width="1920" data-height="1080" data-duration="0"></div>`,
    });
    const response = await apply([
      { op: "set_canvas", width: 1080, height: 1920 },
      { op: "add_clip", asset: "assets/a.mp4", start: 0, track: 0 },
    ]);
    expect(response.timeline.composition.width).toBe(1080);
    expect(response.timeline.composition.height).toBe(1920);
    // The clip placed after the resize fills the new canvas.
    expect(made.read("index.html")).toContain("width: 1080px");
  });
});

describe("composition length without a root data-duration", () => {
  it("follows the content on the root and leaves a nested composition host at its own length", async () => {
    const made = withProject({
      html: `<div id="root" data-composition-id="main" data-width="1920" data-height="1080">
        <div id="host" data-hf-id="hf-host" class="clip" data-composition-id="intro" data-composition-src="compositions/intro.html" data-start="0" data-duration="3" data-track-index="0"></div>
      </div>`,
    });
    await apply([{ op: "add_clip", asset: "assets/a.mp4", start: 3, track: 1 }]);
    const html = made.read("index.html");
    const tagOf = (id: string) => html.match(new RegExp(`<div[^>]*id="${id}"[^>]*>`))?.[0] ?? "";
    expect(tagOf("root")).toContain('data-duration="11"');
    expect(tagOf("host")).toContain('data-duration="3"');
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
  it("removes the registry files an add_component installed when a later operation is refused", async () => {
    const made = withProject();
    const dir = made.project.dir;
    const before = readFileSync(join(dir, "index.html"), "utf-8");
    const error = await refusal([
      { op: "add_component", name: "sparkle", start: 0, track: 5 },
      { op: "split_clip", clip: "intro", at: 99 },
    ]);
    expect(error).toMatchObject({ code: "out_of_bounds", opIndex: 1 });
    expect(existsSync(join(dir, "compositions/sparkle.html"))).toBe(false);
    expect(readFileSync(join(dir, "index.html"), "utf-8")).toBe(before);
  });

  it("removes an installed snippet the mount refused, and restores the config and install record", async () => {
    const made = withProject({
      adapter: {
        installRegistryBlock: async () => {
          made.write("hyperframes.json", '{"registryItems":["badge"]}');
          made.write("hyperframes.lock.json", "{}");
          made.write("compositions/components/badge.html", `<div class="badge">badge</div>`);
          return {
            written: ["compositions/components/badge.html"],
            block: SNIPPET,
            primary: "compositions/components/badge.html",
          };
        },
      },
    });
    made.write("hyperframes.json", '{"registryItems":[]}');

    const error = await refusal([{ op: "add_component", name: "badge", start: 0, track: 0 }]);
    expect(error.code).toBe("unsupported");
    expect(existsSync(join(made.project.dir, "compositions/components/badge.html"))).toBe(false);
    // The folder the install made goes with its file: a refused batch leaves nothing behind.
    expect(existsSync(join(made.project.dir, "compositions/components"))).toBe(false);
    expect(made.read("hyperframes.json")).toBe('{"registryItems":[]}');
    expect(existsSync(join(made.project.dir, "hyperframes.lock.json"))).toBe(false);
  });

  it("keeps a file that was already in the project when the install rewrote it and the batch is refused", async () => {
    const made = withProject();
    made.write("compositions/sparkle.html", "<p>from an earlier install</p>");
    await refusal([
      { op: "add_component", name: "sparkle", start: 0, track: 5 },
      { op: "split_clip", clip: "intro", at: 99 },
    ]);
    expect(existsSync(join(made.project.dir, "compositions/sparkle.html"))).toBe(true);
  });

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

  it("refuses without writing the captions file when the composition changed under the batch", async () => {
    // A user save lands while the batch waits on the probe of the added clip.
    const made = withProject();
    const dir = made.project.dir;
    const edited = `${made.read("index.html")}<!-- saved by the user -->\n`;
    let saved = false;
    const error = await (async () => {
      try {
        await applyEdits(
          {
            project: made.project,
            compositionPath: "index.html",
            adapter: made.adapter,
            facts: new MediaFacts(async (path) => {
              if (!saved) {
                saved = true;
                made.write("index.html", edited);
              }
              return fakeProber(path);
            }),
          },
          {
            operations: [
              { op: "apply_captions", preset: "coral", cues: [{ text: "x", start: 0, end: 1 }] },
              { op: "add_clip", asset: "assets/b.mp4", start: 10, track: 1 },
            ],
          },
        );
      } catch (caught) {
        if (isEditFailure(caught)) return caught.error;
        throw caught;
      }
      throw new Error("expected the batch to be refused");
    })();
    expect(error.code).toBe("conflict");
    expect(readFileSync(join(dir, "index.html"), "utf-8")).toBe(edited);
    expect(existsSync(join(dir, "compositions/captions.html"))).toBe(false);
  });

  it("writes a backup of the composition before replacing it", async () => {
    withProject();
    await apply([{ op: "set_composition", duration: 20 }]);
    expect(existsSync(join(project?.project.dir ?? "", ".hyperframes/backup"))).toBe(true);
  });
});

describe("provenance", () => {
  it("is written on every clip an add operation creates and read back on the timeline", async () => {
    withProject();
    const stamp = { storyNode: "chapter-1", cut: "cut-2", turn: "turn-3" };
    const { timeline, results } = await apply([
      { op: "add_clip", asset: "assets/b.mp4", start: 10, track: 1, provenance: stamp },
      {
        op: "add_sequence",
        asset: "assets/a.mp4",
        track: 6,
        ranges: [
          { from: 0, to: 1 },
          { from: 2, to: 3 },
        ],
        provenance: { cut: "cut-2" },
      },
      {
        op: "add_text",
        text: "Hi",
        start: 0,
        duration: 1,
        track: 7,
        provenance: { turn: "turn-3" },
      },
      {
        op: "add_component",
        name: "sparkle",
        start: 0,
        track: 8,
        provenance: { storyNode: "chapter-9" },
      },
    ]);
    const byId = (id: string | null | undefined) => clipOf(timeline.clips, id ?? "");
    expect(byId(results[0]?.clipId).provenance).toEqual(stamp);
    expect(results[1]?.clipIds).toHaveLength(2);
    for (const id of results[1]?.clipIds ?? []) {
      expect(byId(id).provenance).toEqual({ storyNode: null, cut: "cut-2", turn: null });
    }
    expect(byId(results[2]?.clipId).provenance).toEqual({
      storyNode: null,
      cut: null,
      turn: "turn-3",
    });
    expect(byId(results[3]?.clipId).provenance).toEqual({
      storyNode: "chapter-9",
      cut: null,
      turn: null,
    });
    // Clips made without a stamp have none, and a manual edit keeps the stamp it finds.
    expect(clipOf(timeline.clips, "intro").provenance).toBeNull();
    const moved = await apply([{ op: "move_clip", clip: results[0]?.clipId ?? "", start: 12 }]);
    expect(clipOf(moved.timeline.clips, results[0]?.clipId ?? "").provenance).toEqual(stamp);
  });

  it("stamps an agent turn on the clips its batch changes and on the clips it adds, but not on Studio's own edits", async () => {
    withProject();
    const { timeline, results } = await apply(
      [
        { op: "move_clip", clip: "hf-title", start: 2 },
        { op: "split_clip", clip: "hf-intro", at: 2 },
        { op: "add_clip", asset: "assets/b.mp4", start: 5, track: 1 },
        {
          op: "add_clip",
          asset: "assets/b.mp4",
          start: 6,
          track: 5,
          provenance: { turn: "other" },
        },
      ],
      { turnId: "turn-7" },
    );
    const html = project?.read("index.html") ?? "";
    const stampOf = (id: string) =>
      new RegExp(`data-hf-id="${id}"[^>]*data-ov-ai-edit="([^"]+)"`).exec(html)?.[1] ??
      new RegExp(`data-ov-ai-edit="([^"]+)"[^>]*data-hf-id="${id}"`).exec(html)?.[1];
    const second = results[1]?.newClipId ?? "";
    for (const id of ["hf-title", "hf-intro", second]) expect(stampOf(id)).toMatch(/^turn-7@/);
    expect(stampOf("hf-music")).toBeUndefined();
    expect(clipOf(timeline.clips, results[2]?.clipId ?? "").provenance?.turn).toBe("turn-7");
    expect(clipOf(timeline.clips, results[3]?.clipId ?? "").provenance?.turn).toBe("other");

    // A batch without a turn (Studio, Story builds) adds no stamp.
    await apply([{ op: "move_clip", clip: "hf-music", start: 1 }]);
    expect(project?.read("index.html")).not.toMatch(/data-hf-id="hf-music"[^>]*data-ov-ai-edit/);
  });
});

describe("asset ranges", () => {
  const pickFragments = (entries: Array<[string, { start: number; end: number }]>) => {
    if (!project) throw new Error("no project");
    writeAssetRanges(project.project.dir, new Map(entries));
  };

  it("makes an add_clip of a picked asset default to the pick", async () => {
    withProject();
    pickFragments([["assets/music.mp3", { start: 10, end: 20 }]]);
    const { results, timeline } = await apply([
      { op: "add_clip", asset: "assets/music.mp3", start: 0, track: 3 },
    ]);
    expect(clipOf(timeline.clips, results[0]?.clipId ?? "")).toMatchObject({
      src: "assets/music.mp3",
      start: 0,
      duration: 10,
      mediaStart: 10,
      sourceDuration: 30,
    });
  });

  it("refuses an add_clip before or past the pick, naming it", async () => {
    withProject();
    pickFragments([["assets/music.mp3", { start: 10, end: 20 }]]);
    const before = await refusal([
      { op: "add_clip", asset: "assets/music.mp3", start: 0, track: 3, mediaStart: 4 },
    ]);
    expect(before).toMatchObject({ code: "out_of_bounds", opIndex: 0 });
    expect(before.message).toContain("The user picked 10–20s of assets/music.mp3 for use");

    const past = await refusal([
      {
        op: "add_clip",
        asset: "assets/music.mp3",
        start: 0,
        track: 3,
        mediaStart: 12,
        duration: 12,
      },
    ]);
    expect(past).toMatchObject({ code: "out_of_bounds", opIndex: 0 });
    expect(past.message).toContain("The user picked 10–20s of assets/music.mp3 for use");
    expect(past.message).toContain("runs past 20s");

    // The pick's own length, and the 0.05 s frame-rounding slack, are fine.
    await expect(
      apply([
        {
          op: "add_clip",
          asset: "assets/music.mp3",
          start: 0,
          track: 3,
          mediaStart: 10,
          duration: 10.04,
        },
      ]),
    ).resolves.toBeDefined();
  });

  it("refuses add_sequence ranges outside the pick, naming the index", async () => {
    withProject();
    pickFragments([["assets/a.mp4", { start: 2, end: 4 }]]);
    const error = await refusal([
      {
        op: "add_sequence",
        asset: "assets/a.mp4",
        track: 1,
        ranges: [
          { from: 2, to: 3 },
          { from: 4.5, to: 5 },
        ],
      },
    ]);
    expect(error).toMatchObject({ code: "out_of_bounds", opIndex: 0 });
    expect(error.message).toContain("ranges[1]");
    expect(error.message).toContain("The user picked 2–4s of assets/a.mp4 for use");

    const early = await refusal([
      { op: "add_sequence", asset: "assets/a.mp4", track: 1, ranges: [{ from: 1, to: 2 }] },
    ]);
    expect(early.message).toContain("ranges[0]");
    expect(early.message).toContain("starts before it");

    const inside = await apply([
      {
        op: "add_sequence",
        asset: "assets/a.mp4",
        track: 1,
        ranges: [
          { from: 2, to: 3 },
          { from: 3, to: 4 },
        ],
      },
    ]);
    expect(inside.results[0]?.clipIds).toHaveLength(2);
  });

  it("stops a trim from widening the pick on a clip placed inside it", async () => {
    withProject();
    pickFragments([["assets/music.mp3", { start: 10, end: 20 }]]);
    const added = await apply([{ op: "add_clip", asset: "assets/music.mp3", start: 0, track: 3 }]);
    const id = added.results[0]?.clipId ?? "";

    const past = await refusal([{ op: "trim_clip", clip: id, end: 24 }]);
    expect(past).toMatchObject({ code: "out_of_bounds" });
    expect(past.message).toContain("The user picked 10–20s of assets/music.mp3 for use");

    const shrunk = await apply([{ op: "trim_clip", clip: id, start: 5 }]);
    expect(clipOf(shrunk.timeline.clips, id)).toMatchObject({
      start: 5,
      end: 10,
      duration: 5,
      mediaStart: 15,
    });
  });

  it("keeps a clip the user placed outside the pick from widening it, but lets it shrink", async () => {
    withProject({
      html: MAIN_HTML.replace(
        /<audio id="music"[^>]*>/,
        '<audio id="music" data-hf-id="hf-music" class="clip" src="assets/music.mp3" data-start="2" data-duration="4" data-track-index="3" data-media-start="5" data-volume="0.5">',
      ),
    });
    pickFragments([["assets/music.mp3", { start: 10, end: 20 }]]);

    // The clip uses 5–9 s of the source; trimming its head earlier would reach further outside the pick.
    const widened = await refusal([{ op: "trim_clip", clip: "hf-music", start: 1 }]);
    expect(widened).toMatchObject({ code: "out_of_bounds" });
    expect(widened.message).toContain("The user picked 10–20s of assets/music.mp3 for use");

    const shrunk = await apply([{ op: "trim_clip", clip: "hf-music", start: 2.5, end: 5 }]);
    expect(clipOf(shrunk.timeline.clips, "hf-music")).toMatchObject({
      start: 2.5,
      end: 5,
      mediaStart: 5.5,
    });

    // It may grow up to the pick, not past it.
    const grown = await apply([{ op: "trim_clip", clip: "hf-music", end: 14 }]);
    expect(clipOf(grown.timeline.clips, "hf-music")).toMatchObject({ start: 2.5, end: 14 });
    const past = await refusal([{ op: "trim_clip", clip: "hf-music", end: 23 }]);
    expect(past).toMatchObject({ code: "out_of_bounds" });
    expect(past.message).toContain("The user picked 10–20s of assets/music.mp3 for use");
  });
});

describe("add_clip — file names that are not URL-safe", () => {
  // `?` and `"` cannot be in a Windows file name; the other characters still exercise encoding there.
  const NAMES = [
    "a b#1.mp4",
    "100%.mp4",
    "it's (1).mp4",
    ...(process.platform === "win32" ? [] : ["what?.mp4", 'say "hi" (1).mp4']),
  ];

  afterEach(() => {
    for (const name of NAMES) delete FAKE_MEDIA[name];
  });

  it("writes a src that resolves back to the file on disk, for the clip and everything read from it", async () => {
    for (const name of NAMES) {
      FAKE_MEDIA[name] = { kind: "video", durationSeconds: 5, hasAudio: false };
    }
    withProject();
    for (const name of NAMES) project?.write(`assets/${name}`, "bytes");

    let track = 10;
    for (const name of NAMES) {
      track += 1;
      const { results, timeline } = await apply([
        { op: "add_clip", asset: `assets/${name}`, start: 0, track },
      ]);
      expect(clipOf(timeline.clips, results[0]?.clipId ?? "").src).toBe(`assets/${name}`);
    }

    const html = project?.read("index.html") ?? "";
    const written = html.match(/src="(assets\/[^"]*)"/g)?.map((match) => match.slice(5, -1)) ?? [];
    for (const name of NAMES) {
      const encoded = written.find((src) => decodeURIComponent(src) === `assets/${name}`);
      expect(encoded, name).toBeDefined();
      expect(encoded).not.toMatch(/[ "#?'()]/);
    }
    // Read back from disk, the clips still find their files: the probed length comes from the file the src names.
    if (!project) throw new Error("no project");
    const reread = await readTimeline(project.project, "index.html", project.facts);
    for (const name of NAMES) {
      const clip = reread.clips.find((candidate) => candidate.src === `assets/${name}`);
      expect(clip?.sourceDuration, name).toBe(5);
    }
  });

  it.skipIf(process.platform === "win32")(
    "does not let a file name add attributes to the clip",
    async () => {
      const name = 'x" onerror="alert(1)" y=".mp4';
      FAKE_MEDIA[name] = { kind: "video", durationSeconds: 5, hasAudio: false };
      try {
        withProject();
        project?.write(`assets/${name}`, "bytes");
        const { results, timeline } = await apply([
          { op: "add_clip", asset: `assets/${name}`, start: 0, track: 11 },
        ]);
        const html = project?.read("index.html") ?? "";
        expect(html).not.toContain("onerror=");
        expect(clipOf(timeline.clips, results[0]?.clipId ?? "").src).toBe(`assets/${name}`);
      } finally {
        delete FAKE_MEDIA[name];
      }
    },
  );
});
