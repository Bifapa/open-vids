// @vitest-environment node
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  COLOR_ADJUST_KEYS,
  EDIT_LIMITS,
  type ApplyEditsRequest,
  type EditOperation,
  type TimelineClip,
  type TranscriptWord,
} from "@hyperframes/agent-protocol";
import { parseAutomation } from "@hyperframes/core/audio-automation";
import { HF_AUDIO_FX_PRESET_IDS } from "@hyperframes/core/audio-fx-presets";
import { HF_COLOR_GRADING_ADJUST_KEYS } from "@hyperframes/core/color-grading";
import { MAX_PLAYBACK_RATE, MIN_PLAYBACK_RATE } from "@hyperframes/parsers/media-duration";
import { afterEach, describe, expect, it } from "vitest";
import { readStoredGroups } from "./captionData.js";
import { captionsFileFor } from "./captions.js";
import { commitWrites } from "./commit.js";
import { isEditFailure } from "./errors.js";
import { applyEdits } from "./operations.js";
import { wordsToCues } from "./opsTranscript.js";
import { parseComposition } from "./timeline.js";
import { cancelRunning, trackRunning } from "./replay.js";
import { MAIN_HTML, createTestProject, type TestProject } from "./testProject.js";
import type { AnalysisService } from "../analysis/service.js";

const SKINS = join(import.meta.dirname, "../../../../skills/hyperframes-creative/frame-presets");
const TEMPLATE = readFileSync(
  join(import.meta.dirname, "../../../cli/src/templates/blank/index.html"),
  "utf-8",
);

let project: TestProject | undefined;
afterEach(() => {
  project?.cleanup();
  project = undefined;
});

type Analysis = Pick<AnalysisService, "sourceData">;

function withProject(html?: string): TestProject {
  const made = createTestProject({
    ...(html !== undefined && { html }),
    adapter: { captionSkinsDir: () => SKINS },
  });
  project = made;
  return made;
}

async function apply(
  operations: EditOperation[],
  request: Omit<ApplyEditsRequest, "operations"> = {},
  extra: { analysis?: Analysis; signal?: AbortSignal } = {},
) {
  if (!project) throw new Error("no project");
  return applyEdits(
    {
      project: project.project,
      compositionPath: request.composition ?? "index.html",
      adapter: project.adapter,
      facts: project.facts,
      ...(extra.analysis && { analysis: extra.analysis }),
    },
    { ...request, operations },
    extra.signal ? { signal: extra.signal } : {},
  );
}

async function refusal(operations: EditOperation[], request = {}, extra = {}) {
  try {
    await apply(operations, request, extra);
  } catch (error) {
    if (isEditFailure(error)) return error.error;
    throw error;
  }
  throw new Error("expected the batch to be refused");
}

const clipOf = (clips: TimelineClip[], id: string): TimelineClip => {
  const clip = clips.find((candidate) => candidate.id === id || candidate.domId === id);
  if (!clip) throw new Error(`no clip ${id}`);
  return clip;
};

describe("limits shared with the engine", () => {
  it("mirrors the playback rate bounds and the colour adjustment keys", () => {
    expect(EDIT_LIMITS.minRate).toBe(MIN_PLAYBACK_RATE);
    expect(EDIT_LIMITS.maxRate).toBe(MAX_PLAYBACK_RATE);
    expect([...COLOR_ADJUST_KEYS].sort()).toEqual([...HF_COLOR_GRADING_ADJUST_KEYS].sort());
  });
});

describe("set_speed", () => {
  it("writes data-playback-rate and scales the timeline length with the same stretch of source", async () => {
    withProject();
    const { timeline, results } = await apply([{ op: "set_speed", clip: "intro", rate: 2 }]);
    expect(clipOf(timeline.clips, "intro")).toMatchObject({ duration: 2, playbackRate: 2 });
    expect(project?.read("index.html")).toContain('data-playback-rate="2"');
    expect(results[0]?.note).toContain("2×");
  });

  it("ripples later clips by the difference, on the track or on every track", async () => {
    withProject();
    const { timeline } = await apply([
      { op: "add_clip", asset: "assets/b.mp4", start: 4, track: 0 },
      { op: "set_speed", clip: "intro", rate: 2, ripple: true, rippleScope: "all" },
    ]);
    // The B clip on the same track and the lower-third host on another track both move up by 2 s.
    expect(timeline.clips.find((clip) => clip.src === "assets/b.mp4")?.start).toBe(2);
    expect(clipOf(timeline.clips, "host").start).toBe(3);
    expect(clipOf(timeline.clips, "music").start).toBe(0);
  });

  it("keepDuration plays more of the source and is refused past the end of the media", async () => {
    withProject();
    const kept = await apply([{ op: "set_speed", clip: "intro", rate: 2, keepDuration: true }]);
    expect(clipOf(kept.timeline.clips, "intro")).toMatchObject({ duration: 4, playbackRate: 2 });
    expect(
      await refusal([{ op: "set_speed", clip: "intro", rate: 3, keepDuration: true }]),
    ).toMatchObject({ code: "out_of_bounds" });
  });

  it("rate 1 removes the attribute; text clips are refused", async () => {
    withProject();
    await apply([{ op: "set_speed", clip: "intro", rate: 0.5 }]);
    await apply([{ op: "set_speed", clip: "intro", rate: 1 }]);
    expect(project?.read("index.html")).not.toContain("data-playback-rate");
    expect(await refusal([{ op: "set_speed", clip: "title", rate: 2 }])).toMatchObject({
      code: "unsupported",
    });
  });
});

describe("remove_clip ripple scope", () => {
  it("closes the gap on every track with rippleScope all, on the clip's own track by default", async () => {
    withProject();
    const own = await apply([{ op: "remove_clip", clip: "intro", ripple: true }]);
    expect(clipOf(own.timeline.clips, "host").start).toBe(5);
    project?.cleanup();
    withProject();
    const all = await apply([
      { op: "remove_clip", clip: "intro", ripple: true, rippleScope: "all" },
    ]);
    expect(clipOf(all.timeline.clips, "host").start).toBe(1);
  });
});

describe("retime_captions", () => {
  const cues = [
    { text: "one two", start: 0, end: 2 },
    { text: "three four", start: 3, end: 5 },
  ];
  const captionGroups = () => {
    const file = captionsFileFor("index.html");
    return readStoredGroups(project?.read(file) ?? "") ?? [];
  };

  it("shifts the cues from a time on, words included", async () => {
    withProject();
    await apply([{ op: "apply_captions", preset: "coral", cues }]);
    const { results } = await apply([{ op: "retime_captions", shift: 1, from: 3 }]);
    expect(results[0]?.note).toBe("1 of 2 cues retimed");
    const groups = captionGroups();
    expect(groups.map((group) => [group.start, group.end])).toEqual([
      [0, 2],
      [4, 6],
    ]);
    expect(groups[1]?.words[0]?.start).toBe(4);
  });

  it("stretches around from with scale", async () => {
    withProject();
    await apply([{ op: "apply_captions", preset: "coral", cues }]);
    await apply([{ op: "retime_captions", scale: 1.5 }]);
    expect(captionGroups().map((group) => [group.start, group.end])).toEqual([
      [0, 3],
      [4.5, 7.5],
    ]);
  });

  it("refuses a retime that overlaps, starts before 0 or leaves the captions' length", async () => {
    withProject();
    await apply([{ op: "apply_captions", preset: "coral", cues }]);
    expect(await refusal([{ op: "retime_captions", shift: -2, from: 3 }])).toMatchObject({
      code: "out_of_bounds",
      message: expect.stringContaining("overlap"),
    });
    expect(await refusal([{ op: "retime_captions", shift: -1 }])).toMatchObject({
      message: expect.stringContaining("before 0"),
    });
    expect(await refusal([{ op: "retime_captions", shift: 20, from: 3 }])).toMatchObject({
      message: expect.stringContaining("past the captions' length"),
    });
    expect(await refusal([{ op: "retime_captions", shift: 1, from: 8 }])).toMatchObject({
      message: expect.stringContaining("No caption cue starts"),
    });
  });

  it("refuses a composition without captions", async () => {
    withProject();
    expect(await refusal([{ op: "retime_captions", shift: 1 }])).toMatchObject({
      code: "unknown_clip",
    });
  });
});

describe("captions_from_transcript", () => {
  const word = (i: number, text: string, start: number, end: number): TranscriptWord => ({
    i,
    text,
    start,
    end,
    speaker: null,
  });
  const analysis = (transcripts: Record<string, TranscriptWord[]>): Analysis => ({
    sourceData: async (_project, source) => {
      const words = transcripts[source];
      return {
        source,
        kind: "video",
        duration: 8,
        transcript: words
          ? { source, language: "en", words, sentences: [], speechSeconds: 1 }
          : null,
        takes: null,
        silence: null,
        segments: null,
        version: "v1",
      };
    },
  });

  const speech = analysis({
    "assets/a.mp4": [
      word(0, "Hello", 0.5, 0.9),
      word(1, "After", 2.5, 2.9),
      word(2, "cut", 3, 3.4),
      word(3, "gone", 6, 6.5),
    ],
  });
  const place: EditOperation[] = [
    { op: "remove_clip", clips: ["intro", "title", "host", "music"] },
    // Source 2–4 s on the timeline from 10 s: "After" and "cut" are the only words inside it.
    { op: "add_clip", asset: "assets/a.mp4", start: 10, track: 0, mediaStart: 2, duration: 2 },
  ];
  const captionGroups = () =>
    readStoredGroups(project?.read(captionsFileFor("index.html")) ?? "") ?? [];

  it("maps the words each clip plays onto the timeline through its in-point", async () => {
    withProject();
    const { results } = await apply(
      [...place, { op: "captions_from_transcript", preset: "coral" }],
      {},
      { analysis: speech },
    );
    expect(captionGroups().map((group) => [group.text, group.start, group.end])).toEqual([
      ["After cut", 10.5, 11.4],
    ]);
    expect(results[2]?.note).toContain("1 cues from 1 clip");
  });

  it("applies the clip's speed", async () => {
    withProject();
    const placed = await apply(place, {}, { analysis: speech });
    const id = placed.results[1]?.clipId ?? "";
    await apply(
      [
        { op: "set_speed", clip: id, rate: 2, keepDuration: true },
        { op: "captions_from_transcript", preset: "coral" },
      ],
      {},
      { analysis: speech },
    );
    // Source 2–6 s now plays in 2 s from 10 s: "After" at 10.25, "cut" at 10.5, and "gone" at 6 is past the window.
    const groups = captionGroups();
    expect(groups[0]?.start).toBeCloseTo(10.25, 2);
    expect(groups[0]?.end).toBeCloseTo(10.7, 2);
  });

  it("says which sources lack a transcript", async () => {
    withProject();
    expect(
      await refusal(
        [{ op: "captions_from_transcript", preset: "coral" }],
        {},
        {
          analysis: analysis({}),
        },
      ),
    ).toMatchObject({
      code: "unsupported",
      message: expect.stringContaining("assets/music.mp3"),
    });
  });

  it("breaks cues at sentence ends, pauses and the word limit", () => {
    const words = [
      { text: "a", start: 0, end: 0.2 },
      { text: "b.", start: 0.2, end: 0.4 },
      { text: "c", start: 0.5, end: 0.7 },
      { text: "d", start: 2, end: 2.2 },
      { text: "e", start: 2.2, end: 2.4 },
      { text: "f", start: 2.4, end: 2.6 },
    ];
    expect(wordsToCues(words, 2).map((cue) => cue.text)).toEqual(["a b.", "c", "d e", "f"]);
  });
});

describe("mount_composition", () => {
  it("mounts a project composition as a clip with its own size and length", async () => {
    withProject();
    const { timeline, results } = await apply([
      { op: "mount_composition", composition: "compositions/lower-third.html", start: 6, track: 6 },
    ]);
    const clip = clipOf(timeline.clips, results[0]?.clipId ?? "");
    expect(clip).toMatchObject({
      kind: "composition",
      compositionSrc: "compositions/lower-third.html",
      start: 6,
      duration: 3,
    });
  });

  it("refuses itself and files that are not compositions", async () => {
    withProject();
    expect(
      await refusal([{ op: "mount_composition", composition: "index.html", start: 0, track: 1 }]),
    ).toMatchObject({ code: "invalid_request" });
    expect(
      await refusal([{ op: "mount_composition", composition: "nope.html", start: 0, track: 1 }]),
    ).toMatchObject({ code: "unknown_composition" });
    expect(
      await refusal([{ op: "mount_composition", composition: "assets/a.mp4", start: 0, track: 1 }]),
    ).toMatchObject({ code: "unknown_composition" });
  });
});

describe("set_color_grade", () => {
  it("writes the normalised grade Studio's panel writes, and layers tonal changes", async () => {
    withProject();
    const first = await apply([{ op: "set_color_grade", clip: "intro", preset: "warm-daylight" }]);
    expect(clipOf(first.timeline.clips, "intro").colorGrade).toBe("warm-daylight");
    const attribute = /data-color-grading='([^']*)'|data-color-grading="([^"]*)"/.exec(
      project?.read("index.html") ?? "",
    );
    expect(attribute).not.toBeNull();
    const second = await apply([
      { op: "set_color_grade", clip: "intro", adjust: { exposure: 0.5 }, intensity: 0.6 },
    ]);
    expect(clipOf(second.timeline.clips, "intro").colorGrade).toBe("warm-daylight");
    const html = project?.read("index.html") ?? "";
    expect(html).toContain("0.5");
    expect(html).toContain("0.6");
  });

  it("clears the grade, refuses unknown presets and audio", async () => {
    withProject();
    await apply([{ op: "set_color_grade", clip: "intro", preset: "warm-daylight" }]);
    const cleared = await apply([{ op: "set_color_grade", clip: "intro", clear: true }]);
    expect(clipOf(cleared.timeline.clips, "intro").colorGrade).toBeUndefined();
    expect(project?.read("index.html")).not.toContain("data-color-grading");
    expect(await refusal([{ op: "set_color_grade", clip: "intro", preset: "nope" }])).toMatchObject(
      { code: "unknown_preset" },
    );
    expect(
      await refusal([{ op: "set_color_grade", clip: "music", preset: "warm-daylight" }]),
    ).toMatchObject({ code: "unsupported" });
  });
});

describe("set_audio_fx", () => {
  const preset = HF_AUDIO_FX_PRESET_IDS[0] ?? "";

  it("applies a preset into data-fx-chain and clears it again", async () => {
    withProject();
    const applied = await apply([{ op: "set_audio_fx", clip: "music", preset }]);
    expect(clipOf(applied.timeline.clips, "music").audioFx).toBeGreaterThan(0);
    expect(project?.read("index.html")).toContain("data-fx-chain");
    const cleared = await apply([{ op: "set_audio_fx", clip: "music", clear: true }]);
    expect(clipOf(cleared.timeline.clips, "music").audioFx).toBeUndefined();
    expect(project?.read("index.html")).not.toContain("data-fx-chain");
  });

  it("re-applying a preset replaces its own nodes instead of stacking", async () => {
    withProject();
    const once = await apply([{ op: "set_audio_fx", clip: "music", preset }]);
    const twice = await apply([{ op: "set_audio_fx", clip: "music", preset }]);
    expect(clipOf(twice.timeline.clips, "music").audioFx).toBe(
      clipOf(once.timeline.clips, "music").audioFx,
    );
  });

  it("refuses unknown presets and non-audible clips", async () => {
    withProject();
    expect(await refusal([{ op: "set_audio_fx", clip: "music", preset: "nope" }])).toMatchObject({
      code: "unknown_preset",
    });
    expect(await refusal([{ op: "set_audio_fx", clip: "title", preset }])).toMatchObject({
      code: "unsupported",
    });
  });
});

describe("volume automation and ducking", () => {
  it("writes the volume lane, reports it, and removes it", async () => {
    withProject();
    const { timeline } = await apply([
      {
        op: "set_volume_automation",
        clip: "music",
        points: [
          { t: 0, v: 0.2 },
          { t: 5, v: 1 },
        ],
      },
    ]);
    expect(clipOf(timeline.clips, "music").automation).toEqual(["volume"]);
    expect(project?.read("index.html")).toContain("data-automation");
    const cleared = await apply([{ op: "set_volume_automation", clip: "music", clear: true }]);
    expect(clipOf(cleared.timeline.clips, "music").automation).toBeUndefined();
  });

  it("refuses points past the clip's end", async () => {
    withProject();
    expect(
      await refusal([{ op: "set_volume_automation", clip: "music", points: [{ t: 11, v: 1 }] }]),
    ).toMatchObject({ code: "out_of_bounds" });
  });

  it("ducks the music under the clips on a track with attack and release ramps", async () => {
    withProject();
    const { timeline, results } = await apply([
      { op: "duck_audio", clip: "music", underTrack: 0, reduceDb: 12, attack: 0.5, release: 1 },
    ]);
    expect(clipOf(timeline.clips, "music").automation).toEqual(["volume"]);
    expect(results[0]?.note).toContain("0.5 → 0.126");
    const music = parseComposition(project?.read("index.html") ?? "", "index.html")?.clips.find(
      (clip) => clip.id === "hf-music",
    );
    const points = parseAutomation(
      music?.element.getAttribute("data-automation") ?? "",
    ).lanes[0]?.points.map(({ t, v }) => ({ t, v }));
    // Starts ducked (the speech is already running at 0), holds to the end of the speech, then releases over 1 s.
    expect(points).toEqual([
      { t: 0, v: 0.126 },
      { t: 4, v: 0.126 },
      { t: 5, v: 0.5 },
    ]);
  });

  it("merges stretches that sit closer than the ramps and refuses ducking under nothing", async () => {
    withProject();
    const { results } = await apply([
      { op: "duck_audio", clip: "music", under: ["intro", "title"], attack: 0.2, release: 0.2 },
    ]);
    expect(results[0]?.note).toContain("under 1 stretches");
    expect(await refusal([{ op: "duck_audio", clip: "music", underTrack: 9 }])).toMatchObject({
      code: "unknown_clip",
    });
  });
});

describe("set_locked", () => {
  it("locks a clip, refuses edits to it, and lifts only the agent's own lock", async () => {
    withProject();
    const locked = await apply([{ op: "set_locked", clips: ["title"], locked: true }]);
    expect(clipOf(locked.timeline.clips, "title").locked).toBe(true);
    expect(await refusal([{ op: "move_clip", clip: "title", start: 2 }])).toMatchObject({
      code: "locked",
    });
    const unlocked = await apply([{ op: "set_locked", clips: ["title"], locked: false }]);
    expect(clipOf(unlocked.timeline.clips, "title").locked).toBe(false);
  });

  it("does not lift a lock the user set", async () => {
    withProject(
      MAIN_HTML.replace(
        'id="title" data-hf-id="hf-title"',
        'id="title" data-timeline-locked data-hf-id="hf-title"',
      ),
    );
    expect(await refusal([{ op: "set_locked", clips: ["title"], locked: false }])).toMatchObject({
      code: "locked",
      message: expect.stringContaining("user"),
    });
  });
});

describe("set_clip opacity", () => {
  it("writes the inline opacity and reports it; 1 removes it; audio is refused", async () => {
    withProject();
    const { timeline } = await apply([{ op: "set_clip", clip: "intro", opacity: 0.4 }]);
    expect(clipOf(timeline.clips, "intro").opacity).toBe(0.4);
    const full = await apply([{ op: "set_clip", clip: "intro", opacity: 1 }]);
    expect(clipOf(full.timeline.clips, "intro").opacity).toBeUndefined();
    expect(await refusal([{ op: "set_clip", clip: "music", opacity: 0.5 }])).toMatchObject({
      code: "unsupported",
    });
  });
});

describe("set_canvas fit", () => {
  const styleOf = (id: string) => {
    const html = project?.read("index.html") ?? "";
    const match = new RegExp(`id="${id}"[^>]*style="([^"]*)"`).exec(html);
    return match?.[1] ?? "";
  };

  it("contain scales the picture into the new canvas and centres it", async () => {
    withProject();
    const { results } = await apply([
      { op: "set_canvas", width: 1080, height: 1920, fit: "contain" },
    ]);
    expect(results[0]?.note).toContain("contain");
    // 1920×1080 → ×0.5625 = 1080×607.5, centred vertically in 1920.
    expect(styleOf("intro")).toContain("width: 1080px");
    expect(styleOf("intro")).toContain("height: 607.5px");
    expect(styleOf("intro")).toContain("top: 656.25px");
  });

  it("cover fills the new canvas and crops", async () => {
    withProject();
    await apply([{ op: "set_canvas", width: 1080, height: 1920, fit: "cover" }]);
    expect(styleOf("intro")).toContain("height: 1920px");
    expect(styleOf("intro")).toContain("left: -1166.67px");
  });

  it("keep (the default) leaves the frames where they are", async () => {
    withProject();
    await apply([{ op: "set_canvas", width: 1080, height: 1920 }]);
    expect(styleOf("intro")).toContain("width: 1920px");
  });
});

describe("the composition length rule", () => {
  it("lets the blank template's own 10 s go once its placeholder is replaced", async () => {
    withProject(TEMPLATE);
    const { timeline } = await apply([
      { op: "remove_clip", clip: "title" },
      { op: "add_clip", asset: "assets/b.mp4", start: 0, track: 0 },
    ]);
    expect(timeline.composition.duration).toBe(5);
  });

  it("keeps a tail the content does not fill", async () => {
    withProject();
    const { timeline } = await apply([{ op: "trim_clip", clip: "music", end: 6 }]);
    expect(timeline.composition.duration).toBe(10);
  });
});

describe("overlap warnings", () => {
  it("warns about a new overlap on track 0 and not about one that was already there", async () => {
    withProject();
    const { warnings } = await apply([
      { op: "add_clip", asset: "assets/b.mp4", start: 1, track: 0 },
    ]);
    expect(warnings).toHaveLength(1);
    expect(warnings?.[0]).toContain("overlap on track 0");
    const again = await apply([{ op: "set_clip", clip: "intro", volume: 0.5 }]);
    expect(again.warnings).toBeUndefined();
  });

  it("says nothing for clips on other tracks", async () => {
    withProject();
    const { warnings } = await apply([
      { op: "add_clip", asset: "assets/b.mp4", start: 1, track: 1 },
    ]);
    expect(warnings).toBeUndefined();
  });
});

describe("requestId, dryRun and cancellation", () => {
  const add: EditOperation = { op: "add_clip", asset: "assets/b.mp4", start: 10, track: 1 };

  it("answers a repeated request id with the stored result, before any version check", async () => {
    withProject();
    const first = await apply([add], { requestId: "r-1" });
    const second = await apply([add], { requestId: "r-1", baseVersion: "sha256:stale" });
    expect(second.replayed).toBe(true);
    expect(second.results).toEqual(first.results);
    const clips = second.timeline.clips.filter((clip) => clip.src === "assets/b.mp4");
    expect(clips).toHaveLength(1);
    expect(first.replayed).toBeUndefined();
  });

  it("applies the same id again once something else has changed the composition", async () => {
    withProject();
    await apply([add], { requestId: "r-1" });
    await apply([{ op: "set_clip", clip: "intro", volume: 0.3 }]);
    const again = await apply([add], { requestId: "r-1" });
    expect(again.replayed).toBeUndefined();
    expect(again.timeline.clips.filter((clip) => clip.src === "assets/b.mp4")).toHaveLength(2);
  });

  it("applies the same id again once a side file the batch wrote has changed", async () => {
    withProject();
    const cues = [{ text: "one two", start: 0, end: 2 }];
    await apply([{ op: "apply_captions", preset: "coral", cues }]);
    const file = captionsFileFor("index.html");
    const starts = () =>
      (readStoredGroups(project?.read(file) ?? "") ?? []).map((group) => group.start);
    const forward: EditOperation = { op: "retime_captions", shift: 0.5 };
    const first = await apply([forward], { requestId: "shift-up" });
    expect(first.changedFiles).toEqual([file]);
    expect(starts()).toEqual([0.5]);
    // A retry of the same call, with nothing changed since, is answered from the store.
    const retry = await apply([forward], { requestId: "shift-up" });
    expect(retry.replayed).toBe(true);
    expect(starts()).toEqual([0.5]);
    // Another batch moves the captions back; the first call, repeated, now means "shift again".
    await apply([{ op: "retime_captions", shift: -0.5 }], { requestId: "shift-down" });
    expect(starts()).toEqual([0]);
    const third = await apply([forward], { requestId: "shift-up" });
    expect(third.replayed).toBeUndefined();
    expect(starts()).toEqual([0.5]);
  });

  it("applies the same id again after the user edited a file the batch wrote", async () => {
    withProject();
    const cues = [{ text: "one two", start: 0, end: 2 }];
    const captions = { op: "apply_captions", preset: "coral", cues } satisfies EditOperation;
    await apply([captions], { requestId: "caps" });
    project?.write(captionsFileFor("index.html"), "<!-- edited by the user -->");
    const again = await apply([captions], { requestId: "caps" });
    expect(again.replayed).toBeUndefined();
    expect(project?.read(captionsFileFor("index.html"))).not.toBe("<!-- edited by the user -->");
  });

  it("treats another id as a new batch", async () => {
    withProject();
    await apply([add], { requestId: "r-1" });
    const again = await apply([add], { requestId: "r-2" });
    expect(again.timeline.clips.filter((clip) => clip.src === "assets/b.mp4")).toHaveLength(2);
  });

  it("dryRun answers what would change and writes nothing", async () => {
    withProject();
    const before = project?.read("index.html");
    const dry = await apply(
      [add, { op: "apply_captions", preset: "coral", cues: [{ text: "x", start: 0, end: 1 }] }],
      {
        dryRun: true,
        requestId: "dry-1",
      },
    );
    expect(dry.dryRun).toBe(true);
    expect(dry.changedFiles).toContain("index.html");
    expect(dry.changedFiles).toContain(captionsFileFor("index.html"));
    expect(dry.timeline.clips.some((clip) => clip.src === "assets/b.mp4")).toBe(true);
    expect(project?.read("index.html")).toBe(before);
    expect(existsSync(join(project?.project.dir ?? "", captionsFileFor("index.html")))).toBe(false);
    // A dry run is not remembered: the real batch with the same id applies.
    const real = await apply([add], { requestId: "dry-1" });
    expect(real.replayed).toBeUndefined();
  });

  it("refuses add_component in a dry run before installing anything", async () => {
    const made = withProject();
    const before = made.read("index.html");
    const error = await refusal([{ op: "add_component", name: "sparkle", start: 0, track: 5 }], {
      dryRun: true,
    });
    expect(error).toMatchObject({ code: "unsupported", opIndex: 0 });
    expect(error.message).toContain("dry-run");
    expect(made.read("index.html")).toBe(before);
    expect(existsSync(join(made.project.dir, "compositions/sparkle.html"))).toBe(false);
    expect(existsSync(join(made.project.dir, "hyperframes.lock.json"))).toBe(false);
  });

  it("a cancelled batch writes nothing", async () => {
    withProject();
    const before = project?.read("index.html");
    const controller = new AbortController();
    controller.abort();
    expect(await refusal([add], {}, { signal: controller.signal })).toMatchObject({
      code: "aborted",
    });
    expect(project?.read("index.html")).toBe(before);
  });

  it("cancelRunning reaches a tracked request", () => {
    const tracked = trackRunning("/p", "index.html", "req-9");
    expect(cancelRunning("/p", "req-9")).toBe(true);
    expect(tracked.controller.signal.aborted).toBe(true);
    tracked.done();
    expect(cancelRunning("/p", "req-9")).toBe(false);
  });
});

describe("the commit point", () => {
  it("writes nothing when one file changed since the batch read it", () => {
    const made = withProject();
    const dir = made.project.dir;
    writeFileSync(join(dir, "extra.txt"), "old");
    expect(() =>
      commitWrites(dir, [
        { path: "extra.txt", content: "new", expected: null },
        { path: "index.html", content: "<html></html>", expected: "not what is on disk" },
      ]),
    ).toThrowError(/changed while the edits were being applied/);
    expect(readFileSync(join(dir, "extra.txt"), "utf-8")).toBe("old");
    expect(made.read("index.html")).toContain("data-composition-id");
  });

  it("puts back the files already replaced when a later write fails", () => {
    const made = withProject();
    const dir = made.project.dir;
    const before = made.read("index.html");
    // The second file's parent is a regular file, so creating it fails after the first write landed.
    mkdirSync(join(dir, "side"), { recursive: true });
    writeFileSync(join(dir, "side/blocker"), "file");
    expect(() =>
      commitWrites(dir, [
        { path: "index.html", content: "<html>changed</html>", expected: before },
        { path: "side/blocker/child.txt", content: "x", expected: null },
      ]),
    ).toThrow();
    expect(made.read("index.html")).toBe(before);
  });
});
