import {
  STORY_GRAPH_SCHEMA,
  type QaIssueDraft,
  type StoryGraph,
  type TimelineClip,
} from "@hyperframes/agent-protocol";
import { describe, expect, it } from "vitest";
import { MAX_LAYOUT_SAMPLES, layoutSampleTimes } from "./layoutChecks.js";
import { contextAt, planSamples } from "./samples.js";
import type { QaTimeline } from "./timelineModel.js";

function clip(
  partial: Partial<TimelineClip> & Pick<TimelineClip, "id" | "kind" | "start" | "end">,
): TimelineClip {
  return {
    domId: null,
    label: "",
    duration: partial.end - partial.start,
    track: 0,
    zIndex: null,
    src: null,
    mediaStart: null,
    sourceDuration: null,
    volume: null,
    muted: false,
    compositionSrc: null,
    locked: false,
    provenance: null,
    ...partial,
  };
}

function timeline(
  duration: number,
  clips: TimelineClip[],
  extra: Partial<QaTimeline> = {},
): QaTimeline {
  return {
    snapshot: {
      composition: { path: "index.html", width: 1920, height: 1080, duration },
      version: "v",
      tracks: [],
      clips,
    },
    rates: new Map(),
    missing: new Set(),
    hasAudio: new Map(),
    transcripts: new Map(),
    cues: [],
    graph: null,
    ...extra,
  };
}

function suspect(start: number, end = start): QaIssueDraft {
  return {
    kind: "frozen_frames",
    severity: "warning",
    source: "render",
    check: "freezedetect",
    start,
    end,
    clipIds: [],
    subject: null,
    message: "m",
    fixable: true,
    owner: "editor",
    suggestion: null,
  };
}

const countBy = (samples: ReturnType<typeof planSamples>) => {
  const counts: Record<string, number> = {};
  for (const sample of samples) counts[sample.reason] = (counts[sample.reason] ?? 0) + 1;
  return counts;
};

describe("planSamples", () => {
  it("spends the frame budget on suspects first, then B-roll, cuts, captions, graphics and coverage", () => {
    const clips = [
      clip({ id: "a1", kind: "video", start: 0, end: 20, src: "assets/a.mp4" }),
      clip({ id: "a2", kind: "video", start: 20, end: 40, src: "assets/a.mp4" }),
      clip({ id: "a3", kind: "video", start: 40, end: 60, src: "assets/a.mp4" }),
      clip({ id: "b1", kind: "video", start: 5, end: 11, track: 1, src: "assets/b.mp4" }),
      clip({ id: "b2", kind: "image", start: 25, end: 31, track: 1, src: "assets/b.png" }),
      clip({ id: "t1", kind: "text", start: 50, end: 54, track: 2, label: "Title" }),
    ];
    const cues = Array.from({ length: 10 }, (_, index) => ({
      text: `cue ${index}`,
      start: index * 6,
      end: index * 6 + 2,
    }));
    const base = timeline(60, clips, { cues });
    const input = { timeline: base, duration: 60, framesPerMinute: 12 };

    // Room for everything: every class shows up, in time order, each frame at least 0.4 s from the next.
    const all = planSamples({ ...input, issues: [suspect(33), suspect(45, 47)], maxFrames: 96 });
    expect(Object.keys(countBy(all)).sort()).toEqual(
      ["broll", "caption", "coverage", "cut", "graphic", "suspect"].sort(),
    );
    for (let index = 1; index < all.length; index += 1) {
      expect(all[index]!.time - all[index - 1]!.time).toBeGreaterThanOrEqual(0.4);
    }

    // Eight frames: the two suspects and the two B-roll clips win, the rest goes to cuts; nothing below them fits.
    const capped = planSamples({ ...input, issues: [suspect(33), suspect(45, 47)], maxFrames: 8 });
    expect(capped).toHaveLength(8);
    expect(countBy(capped)).toEqual({ suspect: 2, broll: 2, cut: 4 });
    expect(capped.map((sample) => sample.time)).toEqual(
      [...capped.map((sample) => sample.time)].sort((a, b) => a - b),
    );
    const suspects = capped
      .filter((sample) => sample.reason === "suspect")
      .map((sample) => sample.time);
    expect(suspects).toEqual([33, 46]);

    // Fewer slots than a class has candidates: the class is thinned evenly, not cut short at its start.
    const thin = planSamples({ ...input, issues: [], maxFrames: 4 });
    expect(countBy(thin)).toEqual({ broll: 2, cut: 2 });
    const cuts = thin.filter((sample) => sample.reason === "cut").map((sample) => sample.time);
    expect(cuts[1]! - cuts[0]!).toBeGreaterThan(20);
  });

  it("merges frames less than 0.4 s apart and keeps the more important reason", () => {
    const base = timeline(30, [clip({ id: "a", kind: "video", start: 0, end: 30 })]);
    const planned = planSamples({
      timeline: base,
      duration: 30,
      framesPerMinute: 2,
      maxFrames: 20,
      // 10.0 and 10.3 are one frame; 20.0 and 20.4 are two.
      issues: [suspect(10), suspect(10.3), suspect(20), suspect(20.4)],
    });
    const times = planned
      .filter((sample) => sample.reason === "suspect")
      .map((sample) => sample.time);
    expect(times).toEqual([10, 20, 20.4]);
  });

  it("covers a timeline without anything special evenly at the requested rate", () => {
    const base = timeline(120, [clip({ id: "a", kind: "video", start: 0, end: 120 })]);
    const planned = planSamples({
      timeline: base,
      duration: 120,
      framesPerMinute: 6,
      maxFrames: 96,
      issues: [],
    });
    expect(planned).toHaveLength(12);
    expect(new Set(planned.map((sample) => sample.reason))).toEqual(new Set(["coverage"]));
    expect(planned.map((sample) => sample.time)).toEqual(
      Array.from({ length: 12 }, (_, index) => index * 10 + 5),
    );
  });

  it("never plans a frame past the end of the render", () => {
    const base = timeline(10, [clip({ id: "a", kind: "video", start: 0, end: 10 })]);
    const planned = planSamples({
      timeline: base,
      duration: 10,
      framesPerMinute: 6,
      maxFrames: 20,
      issues: [suspect(10, 10)],
    });
    expect(Math.max(...planned.map((sample) => sample.time))).toBeLessThanOrEqual(9.95);
  });
});

describe("sample context", () => {
  const graph: StoryGraph = {
    schema: STORY_GRAPH_SCHEMA,
    id: "s",
    title: "Story",
    brief: "",
    settings: { composition: null, captionPreset: null },
    nodes: [
      {
        id: "v1",
        kind: "video",
        title: "Commute",
        position: { x: 0, y: 0 },
        locked: false,
        createdBy: "ai",
        userEdited: [],
        asset: "assets/city.mp4",
        sourceIn: 0,
        sourceOut: null,
        usageIntent: "busy street at dusk",
        previewFrame: null,
      },
    ],
    edges: [],
    attachments: [],
    removedByUser: [],
    review: null,
    build: null,
    updatedAt: 1,
    updatedBy: "ai",
  };
  const words = "I spend an hour on the train every single day and it is tiring".split(" ");
  const talk = clip({
    id: "c1",
    kind: "video",
    start: 0,
    end: 60,
    src: "assets/talk.mp4",
    mediaStart: 100,
  });
  const broll = clip({
    id: "c12",
    kind: "video",
    start: 10,
    end: 20,
    track: 1,
    src: "assets/city.mp4",
    provenance: { storyNode: "v1", cut: null, turn: null },
  });
  const title = clip({
    id: "c3",
    kind: "text",
    start: 0,
    end: 30,
    track: 2,
    label: "TOP 5 COOKING TIPS",
  });
  const transcripts = new Map([
    [
      "assets/talk.mp4",
      {
        source: "assets/talk.mp4",
        language: "en",
        sentences: [],
        speechSeconds: 10,
        // Source seconds: the clip plays the source from 100 s, so timeline 15 s is source 115 s.
        words: [
          ...words.map((text, index) => ({
            i: index,
            text,
            start: 100 + index * 2,
            end: 101.8 + index * 2,
            speaker: null,
          })),
          { i: 99, text: "FARAWAY", start: 400, end: 401, speaker: null },
        ],
      },
    ],
  ]);
  const base = timeline(60, [talk, broll, title], {
    graph,
    transcripts,
    cues: [{ text: "every single day", start: 14, end: 17 }],
  });

  it("says what is visible, the story intent, the caption and what is being said around that time", () => {
    const context = contextAt(base, 15);
    expect(context).toContain("track 0 video assets/talk.mp4 (clip c1)");
    expect(context).toContain(
      'track 1 video assets/city.mp4 (clip c12, story node "Commute": busy street at dusk)',
    );
    expect(context).toContain('track 2 text "TOP 5 COOKING TIPS" (clip c3)');
    expect(context).toContain('caption "every single day"');
    // Source time 115 s ± 3 s: the words spoken between 112 s and 118 s, nothing from far away.
    expect(context).toContain('said around here: "train every single"');
    expect(context).not.toContain("FARAWAY");
    expect(context).not.toContain("hour");
    expect(context.length).toBeLessThanOrEqual(400);
  });

  it("does not claim speech from a muted clip and says so when nothing is placed", () => {
    const muted = timeline(60, [{ ...talk, muted: true }], { transcripts });
    expect(contextAt(muted, 15)).not.toContain("said around here");
    expect(contextAt(timeline(60, []), 5)).toBe("nothing is placed on the timeline here");
  });
});

describe("layoutSampleTimes", () => {
  it("samples caption cues and text or graphic clips, spaced, inside the render, capped", () => {
    const cues = Array.from({ length: 60 }, (_, index) => ({
      text: "c",
      start: index,
      end: index + 0.8,
    }));
    const clips = [
      clip({ id: "t", kind: "text", start: 100, end: 102, track: 2, label: "late" }),
      clip({
        id: "cap",
        kind: "composition",
        start: 0,
        end: 60,
        track: 3,
        compositionSrc: "compositions/captions.html",
      }),
      clip({ id: "v", kind: "video", start: 0, end: 60 }),
    ];
    const times = layoutSampleTimes(timeline(60, clips, { cues }), 60);
    expect(times).toHaveLength(MAX_LAYOUT_SAMPLES);
    expect(times[0]).toBeCloseTo(0.4, 5);
    // The text clip is past the end of the render: not sampled. Video and the captions host are not audited themselves.
    expect(Math.max(...times)).toBeLessThanOrEqual(60);
    expect(times).toEqual([...times].sort((a, b) => a - b));

    const few = layoutSampleTimes(
      timeline(10, [clip({ id: "t", kind: "text", start: 2, end: 4, track: 2 })]),
      10,
    );
    expect(few).toEqual([3]);
    expect(
      layoutSampleTimes(timeline(10, [clip({ id: "v", kind: "video", start: 0, end: 10 })]), 10),
    ).toEqual([]);
  });
});
