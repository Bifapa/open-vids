// @vitest-environment node
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  STORY_GRAPH_PATH,
  STORY_LIMITS,
  type StoryOperation,
  type TimelineClip,
} from "@hyperframes/agent-protocol";
import { afterEach, describe, expect, it } from "vitest";
import { cleanRanges } from "../analysis/cutPlan.js";
import { writeAssetRanges } from "../editing/assetRanges.js";
import { readTimeline } from "../editing/service.js";
import { isStoryFailure } from "./errors.js";
import {
  BLANK_HTML,
  createStoryFixture,
  created,
  TALK,
  talkAnalysis,
  type StoryFixture,
} from "./testSupport.js";

let fixture: StoryFixture | undefined;
afterEach(() => {
  fixture?.cleanup();
  fixture = undefined;
});

/** A composition that already holds the raw talk on track 0, a manual title on track 7 and a music bed of its own. */
const LIVED_IN = BLANK_HTML.replace(
  `data-duration="0"></div>`,
  `data-duration="20">
      <video id="raw" data-hf-id="hf-raw" class="clip" src="assets/a.mp4" data-start="0" data-duration="8" data-track-index="0" muted playsinline style="position: absolute; z-index: 1"></video>
      <div id="manual" data-hf-id="hf-manual" class="clip" data-start="1" data-duration="2" data-track-index="7" style="position: absolute; z-index: 9">My title</div>
    </div>`,
);

function story(html = LIVED_IN): StoryFixture {
  fixture = createStoryFixture({ html });
  return fixture;
}

const talk = talkAnalysis();
const cleaned = (ranges: Array<{ from: number; to: number; segment: string | null }>) => {
  if (!talk.transcript) throw new Error("the fixture talk has a transcript");
  return cleanRanges({
    ranges,
    transcript: talk.transcript,
    takes: talk.takes,
    silence: talk.silence,
    sourceDuration: 8,
  });
};

async function timelineOf(f: StoryFixture) {
  return readTimeline(f.project, "index.html", f.made.facts);
}

const clipsOn = (clips: TimelineClip[], track: number) =>
  clips.filter((clip) => clip.track === track).sort((a, b) => a.start - b.start);

/**
 * The reference story: Main (g2) → Intro (g1) → Fill (no speech, 6 s). The user's order puts Main first. Intro has a
 * B-roll video at the end, a motion graphic and captions; Fill has a picture; music scores Main through Intro; a
 * missing B-roll sits on Fill.
 */
async function referenceStory(f: StoryFixture) {
  const made = await f.edit([
    {
      op: "add_node",
      ref: "intro",
      node: {
        kind: "chapter",
        title: "Intro",
        captions: true,
        sourceRanges: [{ source: TALK, segments: ["g1"] }],
      },
    },
    {
      op: "add_node",
      ref: "main",
      node: {
        kind: "chapter",
        title: "Main",
        sourceRanges: [{ source: TALK, segments: ["g2", "g3"] }],
      },
    },
    { op: "add_node", ref: "fill", node: { kind: "chapter", title: "Fill", estimatedDuration: 6 } },
    { op: "set_order", chapters: ["@main", "@intro", "@fill"] },
    {
      op: "add_node",
      ref: "cut",
      node: { kind: "video", title: "Cutaway", asset: "assets/b.mp4", sourceIn: 1 },
    },
    {
      op: "add_node",
      ref: "pic",
      node: { kind: "picture", title: "Photo", asset: "assets/photo.png" },
    },
    { op: "add_node", ref: "fx", node: { kind: "motion", title: "Sparkle", preset: "sparkle" } },
    {
      op: "add_node",
      ref: "bed",
      node: { kind: "music", title: "Bed", asset: "assets/music.mp3", volume: 0.4 },
    },
    {
      op: "add_node",
      ref: "gap",
      node: {
        kind: "missing",
        title: "Shot",
        mediaKind: "video",
        need: "Close-up of the keyboard",
      },
    },
    { op: "attach", node: "@cut", chapter: "@intro", placement: "end", duration: 2 },
    { op: "attach", node: "@fx", chapter: "@intro", placement: "start" },
    { op: "attach", node: "@pic", chapter: "@fill" },
    { op: "attach", node: "@bed", chapter: "@main" },
    { op: "attach", node: "@bed", chapter: "@intro" },
    { op: "attach", node: "@gap", chapter: "@fill" },
  ]);
  return {
    intro: created(made, 0),
    main: created(made, 1),
    fill: created(made, 2),
    cut: created(made, 4),
    pic: created(made, 5),
    fx: created(made, 6),
    bed: created(made, 7),
    gap: created(made, 8),
  };
}

const build = (
  f: StoryFixture,
  extra: { turnId?: string; dryRun?: boolean; baseVersion?: string } = {},
) => f.service.build(f.project, extra);

describe("Build Story", () => {
  it("lays the chapters in story order with cleaned A-roll, placed material, music, captions and provenance", async () => {
    const f = story();
    const ids = await referenceStory(f);
    const result = await build(f, { turnId: "turn-1" });

    // Chapter order follows the edges, not creation order.
    expect(result.chapters.map((chapter) => chapter.node)).toEqual([ids.main, ids.intro, ids.fill]);
    const [main, intro, fill] = result.chapters;
    expect(main?.start).toBe(0);
    expect(intro?.start).toBe(main?.end);
    expect(fill?.start).toBe(intro?.end);
    expect(result.duration).toBe(fill?.end);
    expect(fill && fill.end - fill.start).toBe(6);

    const { clips, composition } = await timelineOf(f);
    expect(composition.duration).toBe(result.duration);

    // A-roll: the rough-cut planner's cleaning of each chapter's ranges (uh removed, silence shortened).
    const aRoll = clipsOn(clips, 0);
    const expectedMain = cleaned([
      { from: 2.6, to: 4.3, segment: "g2" },
      { from: 6.0, to: 7.4, segment: "g3" },
    ]);
    const expectedIntro = cleaned([{ from: 0.5, to: 2.4, segment: "g1" }]);
    const shape = (list: TimelineClip[]) =>
      list.map((clip) => [clip.mediaStart ?? 0, clip.duration]);
    const asClip = (ranges: typeof expectedMain) =>
      ranges.map((r) => [r.from, Number((r.to - r.from).toFixed(3))]);
    expect(shape(aRoll.filter((clip) => clip.provenance?.storyNode === ids.main))).toEqual(
      asClip(expectedMain),
    );
    expect(shape(aRoll.filter((clip) => clip.provenance?.storyNode === ids.intro))).toEqual(
      asClip(expectedIntro),
    );
    expect(expectedMain.length).toBeGreaterThan(2); // the "uh" cut made a gap in g3
    // Back to back from 0 with no gaps.
    let cursor = 0;
    for (const clip of aRoll) {
      expect(clip.start).toBeCloseTo(cursor, 2);
      cursor += clip.duration;
    }
    expect(main && intro && cursor).toBeCloseTo(intro?.end ?? -1, 2);

    // B-roll: muted, from the node's in-point, at the end of Intro.
    const [cutaway] = clipsOn(clips, 1);
    expect(cutaway).toMatchObject({ src: "assets/b.mp4", mediaStart: 1, duration: 2, muted: true });
    expect(cutaway?.end).toBeCloseTo(intro?.end ?? -1, 2);
    expect(cutaway?.provenance).toMatchObject({ storyNode: ids.cut, turn: "turn-1" });

    // Picture: four seconds by default, in the middle of its 6 s chapter.
    const [picture] = clipsOn(clips, 2);
    expect(picture).toMatchObject({ src: "assets/photo.png", duration: 4 });
    expect(picture?.start).toBeCloseTo((fill?.start ?? 0) + 1, 2);

    // Motion graphic on track 3 at the start of Intro.
    const [motion] = clipsOn(clips, 3);
    expect(motion?.compositionSrc).toBe("compositions/sparkle.html");
    expect(motion?.start).toBeCloseTo(intro?.start ?? -1, 2);

    // Music: one clip across Main and Intro, with the node's volume and fades.
    const [bed] = clipsOn(clips, 4);
    expect(bed).toMatchObject({ kind: "audio", src: "assets/music.mp3", volume: 0.4, start: 0 });
    expect(bed?.end).toBeCloseTo(intro?.end ?? -1, 2);
    const html = f.made.read("index.html");
    expect(html).toContain('data-fade-in="1.5"');
    expect(html).toContain('data-fade-out="1.5"');

    // Missing material is a warning, not a clip.
    expect(result.warnings).toContain("Fill: missing Close-up of the keyboard");
    expect(clips.some((clip) => clip.provenance?.storyNode === ids.gap)).toBe(false);

    // Every clip the build made says which node and turn it came from.
    const built = clips.filter((clip) => clip.provenance !== null);
    expect(built.length).toBe(aRoll.length + 4);
    for (const clip of built) expect(clip.provenance?.turn).toBe("turn-1");
    expect((html.match(/data-ov-turn="turn-1"/g) ?? []).length).toBe(built.length);
    expect(result.materials.map((material) => [material.node, material.track])).toEqual([
      [ids.cut, 1],
      [ids.fx, 3],
      [ids.pic, 2],
      [ids.bed, 4],
    ]);
    for (const material of result.materials) expect(material.clipId).not.toBeNull();
  });

  it("captions only the chapters that ask, from the transcript through their cleaned ranges", async () => {
    const f = story();
    await referenceStory(f);
    const result = await build(f);
    expect(result.captions).toMatchObject({ cues: 1 }); // Intro is one sentence; Main did not ask for captions
    const captions = f.made.read("compositions/captions.html");
    expect(captions).toContain("welcome.");
    expect(captions).toContain("Hello");
    expect(captions).not.toContain("goodbye");
    const { clips } = await timelineOf(f);
    expect(clips.some((clip) => clip.compositionSrc === "compositions/captions.html")).toBe(true);
  });

  it("replaces the raw A-roll and earlier story clips but keeps the user's own clips, counting them", async () => {
    const f = story();
    await referenceStory(f);
    const first = await build(f);
    expect(first.removedClips).toBe(1); // the raw talk on track 0
    expect(first.keptClips).toBe(1); // the manual title on track 7
    const afterFirst = await timelineOf(f);
    expect(afterFirst.clips.some((clip) => clip.id === "hf-raw")).toBe(false);
    expect(afterFirst.clips.some((clip) => clip.id === "hf-manual")).toBe(true);
    const storyClips = afterFirst.clips.filter((clip) => clip.provenance?.storyNode);

    const second = await build(f, { turnId: "turn-2" });
    expect(second.removedClips).toBe(storyClips.length);
    const afterSecond = await timelineOf(f);
    expect(afterSecond.clips.filter((clip) => clip.provenance?.storyNode)).toHaveLength(
      storyClips.length,
    );
    expect(afterSecond.clips.some((clip) => clip.provenance?.turn === "turn-1")).toBe(false);
    expect(afterSecond.clips.some((clip) => clip.id === "hf-manual")).toBe(true);
    expect(afterSecond.composition.duration).toBe(second.duration);
  });

  describe("template placeholder", () => {
    const placeholder = (text: string, attributes = "") =>
      `<h1 id="title" data-hf-id="hf-ph" class="clip" data-start="0" data-duration="10" data-track-index="0" ${attributes}>${text}</h1>`;
    const withClip = (clip: string) =>
      BLANK_HTML.replace(`data-duration="0"></div>`, `data-duration="0">${clip}</div>`);
    const MARKER = 'data-ov-placeholder="template"';
    const REMOVED = /^Removed the untouched template placeholder "Title"/;

    it("removes the untouched placeholder in the build's atomic write and reports it", async () => {
      const f = story(withClip(placeholder("Title", MARKER)));
      await referenceStory(f);
      const result = await build(f);
      expect(result.removedClips).toBe(1);
      expect(result.keptClips).toBe(0);
      expect(result.warnings.filter((warning) => REMOVED.test(warning))).toHaveLength(1);
      expect((await timelineOf(f)).clips.some((clip) => clip.id === "hf-ph")).toBe(false);
    });

    it("keeps a placeholder whose text or attributes were changed", async () => {
      for (const clip of [
        placeholder("My own title", MARKER),
        placeholder("Title", `${MARKER} style="color: red"`),
        placeholder("Title", `${MARKER} data-volume="1"`),
        placeholder("Title", `${MARKER} data-timeline-locked`),
      ]) {
        fixture?.cleanup();
        const f = story(withClip(clip));
        await referenceStory(f);
        const result = await build(f);
        expect(result.keptClips).toBe(1);
        expect(result.warnings.some((warning) => REMOVED.test(warning))).toBe(false);
        expect((await timelineOf(f)).clips.some((entry) => entry.id === "hf-ph")).toBe(true);
      }
    });

    it("keeps a retimed placeholder and one without the marker", async () => {
      const retimed = placeholder("Title", MARKER).replace(
        'data-duration="10"',
        'data-duration="4"',
      );
      for (const clip of [retimed, placeholder("Title")]) {
        fixture?.cleanup();
        const f = story(withClip(clip));
        await referenceStory(f);
        const result = await build(f);
        expect(result.keptClips).toBe(1);
        expect((await timelineOf(f)).clips.some((entry) => entry.id === "hf-ph")).toBe(true);
      }
    });
  });

  it("uses a chapter's length without speech as its estimated duration and fills it with attached material", async () => {
    const f = story(BLANK_HTML);
    const made = await f.edit([
      {
        op: "add_node",
        ref: "c",
        node: { kind: "chapter", title: "Title card", estimatedDuration: 5 },
      },
      {
        op: "add_node",
        ref: "p",
        node: { kind: "picture", title: "Photo", asset: "assets/photo.png" },
      },
      { op: "attach", node: "@p", chapter: "@c", placement: "throughout" },
    ]);
    const result = await build(f);
    expect(result.duration).toBe(5);
    const { clips, composition } = await timelineOf(f);
    expect(composition.duration).toBe(5);
    expect(clips).toHaveLength(1);
    expect(clips[0]).toMatchObject({
      start: 0,
      duration: 5,
      provenance: { storyNode: created(made, 1) },
    });
  });

  it("keeps the ranges as they are, with a warning, for a source that was not analysed", async () => {
    const f = story(BLANK_HTML);
    f.analysis.data.clear();
    await f.edit([
      {
        op: "add_node",
        node: { kind: "chapter", title: "Raw", sourceRanges: [{ source: TALK, from: 1, to: 3 }] },
      },
    ]);
    const result = await build(f);
    expect(result.duration).toBe(2);
    expect(result.warnings.join(" ")).toContain("not analysed");
    const { clips } = await timelineOf(f);
    expect(clips.map((clip) => [clip.mediaStart, clip.duration])).toEqual([[1, 2]]);
  });

  it("uses only the picked fragments of the A-roll, B-roll, sound effects and the music bed", async () => {
    const f = story();
    const ids = await referenceStory(f);
    writeAssetRanges(
      f.project.dir,
      new Map([
        ["assets/a.mp4", { start: 0, end: 5 }],
        ["assets/b.mp4", { start: 1.5, end: 3.5 }],
        ["assets/music.mp3", { start: 10, end: 20 }],
      ]),
    );
    const result = await build(f, { turnId: "turn-pick" });
    const [main, intro] = result.chapters;
    const { clips } = await timelineOf(f);

    // The A-roll of a chapter is cleaned inside the pick: Main's g3 (6–7.4 s) is outside 0–5 s and gone.
    const expectedMain = cleaned([{ from: 2.6, to: 4.3, segment: "g2" }]);
    const mainClips = clipsOn(clips, 0).filter((clip) => clip.provenance?.storyNode === ids.main);
    expect(mainClips.map((clip) => [clip.mediaStart ?? 0, clip.duration])).toEqual(
      expectedMain.map((range) => [range.from, Number((range.to - range.from).toFixed(3))]),
    );
    for (const clip of clipsOn(clips, 0)) {
      expect((clip.mediaStart ?? 0) + clip.duration).toBeLessThanOrEqual(5.001);
    }
    expect(result.warnings.join(" ")).toContain("The user picked 0–5s of assets/a.mp4 for use");

    // The B-roll starts at the pick's start (later than the node's own in-point) and stops at its end.
    const [cutaway] = clipsOn(clips, 1);
    expect(cutaway).toMatchObject({ src: "assets/b.mp4", mediaStart: 1.5, duration: 2 });
    expect(result.warnings.join(" ")).toContain(
      "uses only the picked fragment 1.5–3.5s of assets/b.mp4",
    );

    // The bed starts at the pick's start and spans the chapters it scores.
    const [bed] = clipsOn(clips, 4);
    expect(bed).toMatchObject({ src: "assets/music.mp3", mediaStart: 10, start: 0 });
    expect(bed?.end).toBeCloseTo(intro?.end ?? -1, 2);
    expect(main?.start).toBe(0);
  });

  it("leaves out material the picked fragments no longer reach and says what it dropped", async () => {
    const f = story();
    await referenceStory(f);
    writeAssetRanges(
      f.project.dir,
      new Map([
        ["assets/a.mp4", { start: 7.5, end: 8 }],
        ["assets/b.mp4", { start: 0, end: 0.9 }],
      ]),
    );
    const result = await build(f);
    const warnings = result.warnings.join(" ");
    const { clips } = await timelineOf(f);

    // Every A-roll range is outside 7.5–8 s: no A-roll, and each chapter says why.
    expect(clipsOn(clips, 0)).toEqual([]);
    expect(warnings).toContain("The user picked 7.5–8s of assets/a.mp4 for use");
    expect(warnings).toContain("no A-roll could be placed");
    // The cutaway's node starts at 1 s, past the pick's end: it is left out, named.
    expect(clipsOn(clips, 1)).toEqual([]);
    expect(warnings).toContain("is outside the picked fragment 0–0.9s of assets/b.mp4");
  });

  it("estimates a new chapter from the picked fragment of its source", async () => {
    const f = story(BLANK_HTML);
    writeAssetRanges(f.project.dir, new Map([[TALK, { start: 6, end: 8 }]]));
    const made = await f.edit([
      {
        op: "add_node",
        node: {
          kind: "chapter",
          title: "Tail",
          sourceRanges: [{ source: TALK, from: 0, to: 8 }],
        },
      },
    ]);
    const id = created(made, 0);
    const graph = await f.graph();
    const chapter = graph.nodes.find((node) => node.id === id);
    if (chapter?.kind !== "chapter") throw new Error("no chapter");
    const full = cleaned([{ from: 0, to: 8, segment: null }]).reduce(
      (sum, range) => sum + range.to - range.from,
      0,
    );
    expect(chapter.estimatedDuration).toBeGreaterThan(0);
    expect(chapter.estimatedDuration).toBeLessThan(full);
    const view = await f.view();
    expect(view.facts[id]?.materialDuration).toBeCloseTo(chapter.estimatedDuration, 2);
  });

  it("writes nothing on a dry run and reports what it would do", async () => {
    const f = story();
    await referenceStory(f);
    const composition = f.made.read("index.html");
    const graphVersion = (await f.view()).version;
    const result = await build(f, { dryRun: true });
    expect(result.dryRun).toBe(true);
    expect(result.chapters).toHaveLength(3);
    expect(result.removedClips).toBe(1);
    expect(result.materials.every((material) => material.clipId === null)).toBe(true);
    expect(f.made.read("index.html")).toBe(composition);
    expect((await f.view()).version).toBe(graphVersion);
    expect(f.made.read("index.html")).not.toContain("data-ov-story-node");
  });

  it("records the build on the graph, and the timeline facts follow the clips, not the record", async () => {
    const f = story();
    const ids = await referenceStory(f);
    const before = await f.view();
    expect(before.facts[ids.main]?.timeline).toBeNull();
    expect(before.facts[ids.main]?.materialDuration).toBeGreaterThan(0);

    const result = await build(f, { turnId: "turn-9" });
    const view = await f.view();
    expect(view.graph?.build).toMatchObject({
      turnId: "turn-9",
      composition: "index.html",
      duration: result.duration,
      chapters: result.chapters.map(({ node, start, end, clips }) => ({ node, start, end, clips })),
    });
    const main = result.chapters[0];
    expect(view.facts[ids.main]?.timeline).toMatchObject({ start: 0, end: main?.end });
    expect(view.facts[ids.cut]?.timeline).toMatchObject({ clips: 1 });
    // A chapter filled by material alone is shown from its build span.
    expect(view.facts[ids.fill]?.timeline?.clips).toBe(1);
    expect(view.facts[ids.gap]?.timeline).toBeNull();

    // Revert: the composition is restored, the record is stale, nothing is shown as built.
    f.made.write("index.html", LIVED_IN);
    const reverted = await f.view();
    expect(reverted.graph?.build).not.toBeNull();
    for (const node of reverted.graph?.nodes ?? []) {
      expect(reverted.facts[node.id]?.timeline).toBeNull();
    }
  });

  it("refuses without a story and on a stale graph version, and leaves the timeline alone", async () => {
    const f = story();
    await expect(build(f)).rejects.toSatisfy(
      (error: unknown) => isStoryFailure(error) && error.error.code === "no_story",
    );
    await referenceStory(f);
    const stale = (await f.view()).version ?? "";
    await f.edit([{ op: "set_story", title: "Changed" }]);
    const composition = f.made.read("index.html");
    await expect(build(f, { baseVersion: stale })).rejects.toSatisfy(
      (error: unknown) => isStoryFailure(error) && error.error.code === "conflict",
    );
    expect(f.made.read("index.html")).toBe(composition);
  });

  it("refuses a build when the graph file changed while it was being planned, leaving both files alone", async () => {
    const f = story();
    await referenceStory(f);
    const composition = f.made.read("index.html");
    const path = join(f.project.dir, STORY_GRAPH_PATH);
    const outside = { ...f.graphFile(), title: "Restored elsewhere" };
    const sourceData = f.analysis.sourceData.bind(f.analysis);
    // The user undoes their last story edit while the build looks the source up.
    f.analysis.sourceData = async (project, source) => {
      writeFileSync(path, `${JSON.stringify(outside, null, 2)}\n`);
      return sourceData(project, source);
    };
    await expect(build(f)).rejects.toSatisfy(
      (error: unknown) => isStoryFailure(error) && error.error.code === "conflict",
    );
    expect(f.graphFile().title).toBe("Restored elsewhere");
    expect(f.made.read("index.html")).toBe(composition);
  });

  it("records the build on the newest graph when the graph file moved while the edits were being applied", async () => {
    const f = story();
    await referenceStory(f);
    const path = join(f.project.dir, STORY_GRAPH_PATH);
    const outside = { ...f.graphFile(), title: "Restored elsewhere" };
    const install = f.made.adapter.installRegistryBlock;
    // The user undoes their last story edit once the build has started writing the timeline.
    f.made.adapter.installRegistryBlock = async (request) => {
      writeFileSync(path, `${JSON.stringify(outside, null, 2)}\n`);
      if (!install) throw new Error("no registry");
      return install(request);
    };
    const result = await build(f);
    expect(f.graphFile().title).toBe("Restored elsewhere");
    expect(f.graphFile().build).toMatchObject({
      composition: "index.html",
      version: result.timelineVersion,
    });
    expect(f.graphFile().build?.warnings.join(" ")).toContain("changed while it was building");
    expect(f.made.read("index.html")).toContain("data-ov-story-node");
  });

  it("refuses a story with no chapters", async () => {
    const f = story();
    await f.edit([{ op: "set_story", title: "Empty" }]);
    await expect(build(f)).rejects.toSatisfy(
      (error: unknown) => isStoryFailure(error) && error.error.code === "invalid_request",
    );
  });
});

describe("the build record", () => {
  it("keeps the graph readable when a build has more warnings than the stored record allows", async () => {
    const f = story();
    const first = await f.edit([
      { op: "add_node", node: { kind: "chapter", title: "Wide", estimatedDuration: 5 } },
    ]);
    const chapter = created(first, 0);
    // One warning per attached Missing Asset node; the first one is longer than a stored warning may be.
    const perBatch = 41;
    const batches = Math.ceil((STORY_LIMITS.buildWarnings + 1) / perBatch);
    for (let batch = 0; batch < batches; batch += 1) {
      const operations: StoryOperation[] = [];
      for (let index = 0; index < perBatch; index += 1) {
        const number = batch * perBatch + index;
        operations.push({
          op: "add_node",
          ref: `m${index}`,
          node: {
            kind: "missing",
            title: `Shot ${number}`,
            mediaKind: "video",
            need: number === 0 ? "x".repeat(STORY_LIMITS.textChars - 1) : `Shot number ${number}`,
          },
        });
        operations.push({ op: "attach", node: `@m${index}`, chapter });
      }
      await f.edit(operations);
    }

    const result = await build(f);
    expect(result.warnings.length).toBeGreaterThan(STORY_LIMITS.buildWarnings);
    const stored = f.graphFile().build?.warnings ?? [];
    expect(stored).toHaveLength(STORY_LIMITS.buildWarnings);
    expect(stored.every((warning) => warning.length <= STORY_LIMITS.textChars)).toBe(true);
    expect(stored.at(-1)).toMatch(/^…and \d+ more warnings\.$/);
    // The graph still reads back: the next agent edit does not answer "damaged".
    await f.edit([{ op: "set_story", brief: "Still readable" }]);
    expect((await f.view()).graph?.build).not.toBeNull();
  });
});
