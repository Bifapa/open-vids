// @vitest-environment node
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  STORY_GRAPH_PATH,
  VOICE_SCRIPT_PATH,
  VOICE_SCRIPT_SCHEMA,
  isChapter,
  type StoryGraph,
  type StorySyncReport,
  type TimelineClip,
  type VoiceScript,
  type VoiceTake,
} from "@hyperframes/agent-protocol";
import { afterEach, describe, expect, it } from "vitest";
import { readTimeline } from "../editing/service.js";
import { STORY_TRACKS, narrationLine, narrationNode } from "./compile.js";
import { createStoryFixture, created, TALK, type StoryFixture } from "./testSupport.js";

let fixture: StoryFixture | undefined;
afterEach(() => {
  fixture?.cleanup();
  fixture = undefined;
});

function story(): StoryFixture {
  fixture = createStoryFixture();
  return fixture;
}

const WELCOME = "Welcome to the show.";
const SECOND = "A longer second chapter with 2022 in it.";

/** Chapter 1 has A-roll (g1, 1.9 s) and captions; chapter 2 has no A-roll and an estimate of 3 s. */
async function narratedStory(f: StoryFixture) {
  const made = await f.edit([
    {
      op: "add_node",
      ref: "one",
      node: {
        kind: "chapter",
        title: "One",
        captions: true,
        narration: WELCOME,
        sourceRanges: [{ source: TALK, segments: ["g1"] }],
      },
    },
    {
      op: "add_node",
      ref: "two",
      node: {
        kind: "chapter",
        title: "Two",
        captions: true,
        narration: SECOND,
        estimatedDuration: 3,
      },
    },
    { op: "set_order", chapters: ["@one", "@two"] },
  ]);
  return { one: created(made, 0), two: created(made, 1) };
}

function take(
  id: string,
  seconds: number,
  words: Array<[string, number, number]>,
  extra: Partial<VoiceTake> = {},
): VoiceTake {
  return {
    id,
    file: "assets/voice/narration.wav",
    start: 0,
    end: seconds,
    speakerText: "x",
    style: "",
    presetId: "preset-1",
    model: "model",
    voiceId: "voice",
    requestHash: `hash-${id}`,
    fingerprint: `fp-${id}`,
    scene: null,
    words: words.map(([text, start, end]) => ({ text, start, end })),
    usdCost: null,
    createdAt: 1,
    createdBy: { agent: "user", turnId: null },
    ...extra,
  };
}

interface Spoken {
  chapter: string;
  text: string;
  take: VoiceTake | null;
  /** Earlier takes of the line (a regenerated line keeps them). */
  older?: VoiceTake[];
}

function writeVoice(f: StoryFixture, lines: Spoken[]) {
  f.made.write("assets/voice/narration.wav", "audio");
  const script: VoiceScript = {
    schema: VOICE_SCRIPT_SCHEMA,
    language: "en",
    voice: null,
    updatedAt: 1,
    lines: lines.map((line) => ({
      id: narrationLine(line.chapter),
      text: line.text,
      speakerText: line.text,
      style: "",
      presetId: null,
      takes: [...(line.older ?? []), ...(line.take ? [line.take] : [])],
      selectedTakeId: line.take?.id ?? null,
    })),
  };
  const file = join(f.project.dir, VOICE_SCRIPT_PATH);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(script));
}

const ONE_WORDS: Array<[string, number, number]> = [
  ["welcome", 0.1, 0.6],
  ["to", 0.6, 0.8],
  ["the", 0.8, 1],
  ["show", 1, 1.6],
];
/** What a recognizer hears for "2022": three words that the source text writes as one. */
const TWO_WORDS: Array<[string, number, number]> = [
  ["a", 0.2, 0.3],
  ["longer", 0.3, 0.8],
  ["second", 0.8, 1.3],
  ["chapter", 1.3, 1.9],
  ["with", 1.9, 2.2],
  ["twenty", 2.2, 2.7],
  ["twenty-two", 2.7, 3.4],
  ["in", 3.4, 3.6],
  ["it", 3.6, 4],
];

function voices(f: StoryFixture, ids: { one: string; two: string }) {
  writeVoice(f, [
    { chapter: ids.one, text: WELCOME, take: take("t1", 2, ONE_WORDS) },
    { chapter: ids.two, text: SECOND, take: take("t2", 5, TWO_WORDS) },
  ]);
}

const build = (f: StoryFixture, turnId = "turn-1") => f.service.build(f.project, { turnId });
const rebuild = (f: StoryFixture, turnId = "turn-rebuild") =>
  f.service.rebuild(f.project, { turnId });

async function clipsOf(f: StoryFixture): Promise<TimelineClip[]> {
  return (await readTimeline(f.project, "index.html", f.made.facts)).clips;
}

const voiceClips = (clips: TimelineClip[]) =>
  clips.filter((clip) => clip.track === STORY_TRACKS.voice).sort((a, b) => a.start - b.start);

async function syncOf(f: StoryFixture): Promise<StorySyncReport> {
  const { sync } = await f.view();
  if (!sync) throw new Error("no sync report");
  return sync;
}

describe("a chapter's narration field", () => {
  it("reads a graph stored before the field existed, as no narration", async () => {
    const f = story();
    await narratedStory(f);
    const stored = f.graphFile();
    for (const node of stored.nodes) {
      if (node.kind === "chapter") Reflect.deleteProperty(node, "narration");
    }
    writeFileSync(join(f.project.dir, STORY_GRAPH_PATH), `${JSON.stringify(stored, null, 2)}\n`);

    const graph = await f.graph();
    const chapters = graph.nodes.filter(isChapter);
    expect(chapters).toHaveLength(2);
    expect(chapters.map((chapter) => chapter.narration)).toEqual(["", ""]);
  });

  it("is hand-set by the user (kept from agents) like every other field", async () => {
    const f = story();
    const ids = await narratedStory(f);
    const before = await f.view();
    const graph: StoryGraph = structuredClone(await f.graph());
    for (const node of graph.nodes) {
      if (node.id === ids.one && isChapter(node)) node.narration = "The user's own words.";
    }
    await f.service.save(f.project, { baseVersion: before.version, graph });

    const one = (await f.graph()).nodes.find((node) => node.id === ids.one);
    expect(one && isChapter(one) ? one.userEdited : []).toContain("narration");

    const refusal = await f.refusal([
      { op: "update_node", id: ids.one, set: { narration: "The agent's rewrite." } },
    ]);
    expect(refusal.code).toBe("user_decision");
    // The untouched chapter's narration is still the agent's to change.
    await f.edit([{ op: "update_node", id: ids.two, set: { narration: "Better words." } }]);
    const two = (await f.graph()).nodes.find((node) => node.id === ids.two);
    expect(two && isChapter(two) ? two.narration : null).toBe("Better words.");
  });

  it("tells the story view whether the narration has a generated voice", async () => {
    const f = story();
    const ids = await narratedStory(f);
    expect((await f.view()).facts[ids.one]?.narration).toEqual({
      generated: false,
      seconds: null,
      textCurrent: false,
    });
    voices(f, ids);
    expect((await f.view()).facts[ids.one]?.narration).toEqual({
      generated: true,
      seconds: 2,
      textCurrent: true,
    });
  });
});

describe("Build Story with narration", () => {
  it("places the voice of a narration that has a take at its chapter start, and warns about one that has none", async () => {
    const f = story();
    const ids = await narratedStory(f);
    writeVoice(f, [{ chapter: ids.one, text: WELCOME, take: take("t1", 2, ONE_WORDS) }]);
    const result = await build(f);

    expect(result.warnings).toContain(
      `Two: narration has no generated voice yet; nothing was placed (line "${narrationLine(ids.two)}").`,
    );
    const placed = voiceClips(await clipsOf(f));
    expect(placed).toHaveLength(1);
    expect(placed[0]).toMatchObject({ src: "assets/voice/narration.wav", duration: 2, start: 0 });
    expect(placed[0]?.provenance?.storyNode).toBe(narrationNode(ids.one));
    expect(f.made.read("index.html")).toContain(`data-ov-voice-line="${narrationLine(ids.one)}"`);
    const narration = result.materials.find((m) => m.node === narrationNode(ids.one));
    expect(narration).toMatchObject({ track: STORY_TRACKS.voice, start: 0, end: 2 });
  });

  it("lays the second chapter after the first and makes a chapter without A-roll as long as its narration", async () => {
    const f = story();
    const ids = await narratedStory(f);
    voices(f, ids);
    const result = await build(f);

    const [one, two] = result.chapters;
    expect(one?.node).toBe(ids.one);
    expect(two?.node).toBe(ids.two);
    // Two's estimate is 3 s; its narration is 5 s.
    expect((two?.end ?? 0) - (two?.start ?? 0)).toBeCloseTo(5, 2);
    const placed = voiceClips(await clipsOf(f));
    expect(placed.map((clip) => clip.start)).toEqual([0, two?.start]);
    expect(placed[1]?.duration).toBe(5);
    expect(placed.map((clip) => clip.provenance?.storyNode)).toEqual([
      narrationNode(ids.one),
      narrationNode(ids.two),
    ]);
    // The chapter's own span on the timeline includes its narration.
    const facts = (await f.view()).facts[ids.two];
    expect(facts?.timeline?.end).toBeCloseTo(two?.end ?? -1, 2);
  });

  it("takes the captions of a narrated chapter from the narration's words, the source text with the take's timings", async () => {
    const f = story();
    const ids = await narratedStory(f);
    voices(f, ids);
    const result = await build(f);

    // Chapter One's A-roll says "Hello there and welcome."; its captions are the narration instead.
    const captions = f.made.read("compositions/captions.html");
    expect(result.captions?.cues).toBeGreaterThanOrEqual(2);
    expect(captions).toContain("Welcome");
    expect(captions).toContain("show.");
    expect(captions).not.toContain("Hello");
    // "2022" is shown as written even though it was heard as "twenty twenty-two".
    expect(captions).toContain("2022");
    expect(captions).not.toContain("twenty");
  });

  it("keeps the A-roll captions of a chapter whose narration has no voice yet", async () => {
    const f = story();
    const ids = await narratedStory(f);
    writeVoice(f, [{ chapter: ids.two, text: SECOND, take: take("t2", 5, TWO_WORDS) }]);
    await build(f);
    const captions = f.made.read("compositions/captions.html");
    expect(captions).toContain("Hello");
    expect(captions).toContain("2022");
    expect(captions).not.toContain("Welcome");
  });

  it("rebuilds the narration only when its take changed, and leaves everything else as built", async () => {
    const f = story();
    const ids = await narratedStory(f);
    voices(f, ids);
    await build(f);
    expect((await syncOf(f)).state).toBe("in_sync");
    expect((await rebuild(f)).changed).toBe(false);
    const before = await clipsOf(f);
    const firstVoice = voiceClips(before)[0];

    // The same line, regenerated: a new take of the same length.
    writeVoice(f, [
      { chapter: ids.one, text: WELCOME, take: take("t1b", 2, ONE_WORDS) },
      { chapter: ids.two, text: SECOND, take: take("t2", 5, TWO_WORDS) },
    ]);
    const report = await syncOf(f);
    expect(report.state).toBe("out_of_sync");
    const unit = report.sections
      .find((entry) => entry.chapter === ids.one)
      ?.units.find((entry) => entry.role === "narration");
    expect(unit).toMatchObject({
      node: narrationNode(ids.one),
      change: "changed",
      action: "rebuild",
      reasons: ["the voice was generated again"],
    });
    const second = report.sections
      .find((entry) => entry.chapter === ids.two)
      ?.units.find((entry) => entry.role === "narration");
    expect(second?.change).toBe("unchanged");

    const result = await rebuild(f);
    expect(result.changed).toBe(true);
    expect((await syncOf(f)).state).toBe("in_sync");
    const after = await clipsOf(f);
    const nextVoice = voiceClips(after);
    expect(nextVoice).toHaveLength(2);
    expect(nextVoice[0]?.id).not.toBe(firstVoice?.id);
    expect(nextVoice[1]?.id).toBe(voiceClips(before)[1]?.id);
    // The A-roll was not touched.
    expect(
      after.filter((clip) => clip.track === STORY_TRACKS.aRoll).map((clip) => clip.id),
    ).toEqual(before.filter((clip) => clip.track === STORY_TRACKS.aRoll).map((clip) => clip.id));
    // And the next rebuild finds nothing to do.
    expect((await rebuild(f)).changed).toBe(false);
  });

  it("keeps the captions of a narration that a rebuild leaves in place (a locked chapter whose take was regenerated)", async () => {
    const f = story();
    const ids = await narratedStory(f);
    voices(f, ids);
    await build(f);
    const before = f.made.read("compositions/captions.html");
    const locked = await f.view();
    const graph: StoryGraph = structuredClone(await f.graph());
    for (const node of graph.nodes) if (node.id === ids.one) node.locked = true;
    await f.service.save(f.project, { baseVersion: locked.version, graph });

    // The locked chapter's voice is regenerated with other timings; its clip stays as it was built.
    writeVoice(f, [
      {
        chapter: ids.one,
        text: WELCOME,
        older: [take("t1", 2, ONE_WORDS)],
        take: take(
          "t1b",
          3,
          ONE_WORDS.map(([text, start, end]) => [text, start * 1.5, end * 1.5]),
        ),
      },
      { chapter: ids.two, text: SECOND, take: take("t2", 5, TWO_WORDS) },
    ]);
    const report = await syncOf(f);
    const unit = report.sections
      .find((entry) => entry.chapter === ids.one)
      ?.units.find((entry) => entry.role === "narration");
    expect(unit).toMatchObject({ change: "changed", action: "keep_locked" });
    // The captions still describe what is on the timeline: the built take's words, not the A-roll's speech.
    expect(report.captions?.change).toBe("unchanged");
    const result = await rebuild(f);
    expect(result.changed).toBe(false);
    expect(f.made.read("compositions/captions.html")).toBe(before);
    expect(before).toContain("Welcome");
    expect(before).not.toContain("Hello");
    expect(voiceClips(await clipsOf(f))[0]?.duration).toBe(2);
  });

  it("leaves out a narration whose voice file is gone, with a warning, instead of failing the build", async () => {
    const f = story();
    const ids = await narratedStory(f);
    writeVoice(f, [
      { chapter: ids.one, text: WELCOME, take: take("t1", 2, ONE_WORDS) },
      {
        chapter: ids.two,
        text: SECOND,
        take: take("t2", 5, TWO_WORDS, { file: "assets/voice/gone.wav" }),
      },
    ]);
    const result = await build(f);
    expect(result.warnings).toContain(
      "Two: the narration's voice file is missing (assets/voice/gone.wav); nothing was placed.",
    );
    const placed = voiceClips(await clipsOf(f));
    expect(placed).toHaveLength(1);
    expect(placed[0]?.provenance?.storyNode).toBe(narrationNode(ids.one));
  });

  it("places a voice generated after the build with the next rebuild and moves what follows", async () => {
    const f = story();
    const ids = await narratedStory(f);
    await build(f);
    expect(voiceClips(await clipsOf(f))).toHaveLength(0);

    voices(f, ids);
    const result = await rebuild(f);
    expect(result.changed).toBe(true);
    const placed = voiceClips(await clipsOf(f));
    expect(placed).toHaveLength(2);
    expect((await syncOf(f)).state).toBe("in_sync");
  });

  it("removes the narration clip when the narration is cleared", async () => {
    const f = story();
    const ids = await narratedStory(f);
    voices(f, ids);
    await build(f);
    await f.edit([{ op: "update_node", id: ids.two, set: { narration: "" } }]);
    const report = await syncOf(f);
    const unit = report.sections
      .find((entry) => entry.chapter === ids.two)
      ?.units.find((entry) => entry.role === "narration");
    expect(unit).toMatchObject({ change: "removed", action: "remove" });
    await rebuild(f);
    expect(voiceClips(await clipsOf(f))).toHaveLength(1);
  });
});
