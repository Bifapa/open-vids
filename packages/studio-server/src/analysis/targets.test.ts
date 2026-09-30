// @vitest-environment node
import type {
  Segment,
  SegmentMap,
  Shot,
  ShotMap,
  TakeAnalysis,
  TakeIssue,
  VisionAnalysis,
} from "@hyperframes/agent-protocol";
import { describe, expect, it } from "vitest";
import { visionTargets } from "./targets.js";

const SOURCE = "media/talk.mp4";

function shotMap(shots: Array<[number, number]>, problems: ShotMap["problems"] = []): ShotMap {
  return {
    source: SOURCE,
    sceneThreshold: 0.3,
    shots: shots.map(([start, end], index): Shot => ({ id: `k${index + 1}`, start, end })),
    problems,
  };
}

function segmentMap(ranges: Array<[number, number]>): SegmentMap {
  return {
    source: SOURCE,
    origin: "draft",
    transcriptVersion: "sha256:t",
    segments: ranges.map(
      ([start, end], index): Segment => ({
        id: `g${index + 1}`,
        start,
        end,
        firstSentence: `s${index + 1}`,
        lastSentence: `s${index + 1}`,
        title: "",
        summary: "",
        role: "main",
        priority: "should",
        speaker: null,
      }),
    ),
  };
}

function issue(
  patch: Partial<TakeIssue> & Pick<TakeIssue, "id" | "kind" | "start" | "end">,
): TakeIssue {
  return {
    sentences: ["s1"],
    confidence: 0.5,
    action: "review",
    note: "",
    keep: null,
    ...patch,
  };
}

const vision = (inspectedFrames: number[]): VisionAnalysis => ({
  source: SOURCE,
  notes: [],
  inspectedFrames,
});

describe("visionTargets", () => {
  it("looks at both ends and the middle of a black range, and marks inspected frames", () => {
    const shots = shotMap([[0, 60]], [{ kind: "black", start: 10, end: 14 }]);
    const takes: TakeAnalysis = {
      source: SOURCE,
      issues: [issue({ id: "t3", kind: "black", start: 10, end: 14 })],
    };
    const fresh = visionTargets({ duration: 60, shots, takes, segments: null, vision: null });
    expect(fresh[0]).toMatchObject({
      reason: "visual_problem",
      ref: "t3",
      start: 10,
      end: 14,
      times: [10.5, 12, 13.5],
      inspected: false,
    });

    const partly = visionTargets({
      duration: 60,
      shots,
      takes,
      segments: null,
      vision: vision([10.5, 12]),
    });
    expect(partly[0]?.inspected).toBe(false);
    const all = visionTargets({
      duration: 60,
      shots,
      takes,
      segments: null,
      vision: vision([10.52, 11.97, 13.5]),
    });
    expect(all[0]?.inspected).toBe(true);
  });

  it("adds one middle frame for take issues that need a review, but not for cuts or fillers", () => {
    const takes: TakeAnalysis = {
      source: SOURCE,
      issues: [
        issue({ id: "t1", kind: "retake", start: 20, end: 30 }),
        issue({ id: "t2", kind: "retake", start: 40, end: 50, action: "cut" }),
        issue({ id: "t3", kind: "filler", start: 60, end: 60.4 }),
      ],
    };
    const targets = visionTargets({
      duration: 100,
      shots: null,
      takes,
      segments: null,
      vision: null,
    });
    expect(targets).toEqual([
      { reason: "take_review", ref: "t1", start: 20, end: 30, times: [25], inspected: false },
    ]);
  });

  it("takes one frame per segment from the middle of its longest shot", () => {
    const targets = visionTargets({
      duration: 100,
      shots: shotMap([
        [0, 10],
        [10, 40],
        [40, 100],
      ]),
      takes: null,
      segments: segmentMap([
        [0, 45],
        [45, 100],
      ]),
      vision: null,
    });
    const samples = targets.filter((target) => target.reason === "segment_sample");
    // Segment g1: shot k2 (30 s) beats k1 (10 s) and the 5 s of k3 inside it.
    expect(samples.map((target) => [target.ref, target.times])).toEqual([
      ["g1", [25]],
      ["g2", [72.5]],
    ]);
  });

  it("falls back to the segment middle without a shot map", () => {
    const targets = visionTargets({
      duration: 100,
      shots: null,
      takes: null,
      segments: segmentMap([[10, 30]]),
      vision: null,
    });
    expect(targets.map((target) => target.times)).toEqual([[20]]);
  });

  it("adds up to six frames for the longest shots nothing else covers", () => {
    const ranges: Array<[number, number]> = Array.from({ length: 12 }, (_, index) => [
      index * 10,
      index * 10 + 10 - (index % 3),
    ]);
    const targets = visionTargets({
      duration: 120,
      shots: shotMap(ranges),
      takes: null,
      segments: segmentMap([[0, 20]]),
      vision: null,
    });
    const extra = targets.filter((target) => target.reason === "shot_sample");
    expect(extra).toHaveLength(6);
    // The segment's own frame already lies in shot k1, so k1 is not sampled again.
    expect(new Set(extra.map((target) => target.ref)).size).toBe(6);
    expect(extra.every((target) => target.ref !== "k1")).toBe(true);
    const lengths = extra.map((target) => target.end - target.start);
    expect(Math.min(...lengths)).toBeGreaterThanOrEqual(8);
  });

  it("never asks for more than 40 frames, rounds to 0.1 s and sorts by start", () => {
    const problems: ShotMap["problems"] = Array.from({ length: 20 }, (_, index) => ({
      kind: "black" as const,
      start: 100 - index * 5 + 0.037,
      end: 102 - index * 5 + 0.037,
    }));
    const targets = visionTargets({
      duration: 200,
      shots: shotMap([[0, 200]], problems),
      takes: null,
      segments: segmentMap(Array.from({ length: 30 }, (_, i) => [i * 6, i * 6 + 6])),
      vision: null,
    });
    const frames = targets.flatMap((target) => target.times);
    expect(frames.length).toBeLessThanOrEqual(40);
    expect(frames.length).toBe(40);
    for (const time of frames) expect(Math.round(time * 10) / 10).toBe(time);
    expect(targets.map((target) => target.start)).toEqual(
      [...targets.map((target) => target.start)].sort((a, b) => a - b),
    );
    // Problems come first in priority and use the whole budget: 13 × 3 frames and one with a single frame.
    expect(targets.filter((target) => target.reason === "visual_problem")).toHaveLength(14);
    expect(targets.some((target) => target.reason === "segment_sample")).toBe(false);
  });

  it("keeps frames inside the media", () => {
    const targets = visionTargets({
      duration: 10,
      shots: shotMap([[0, 10]], [{ kind: "frozen", start: 9, end: 10 }]),
      takes: null,
      segments: null,
      vision: null,
    });
    for (const time of targets.flatMap((target) => target.times)) {
      expect(time).toBeGreaterThanOrEqual(0);
      expect(time).toBeLessThan(10);
    }
  });
});
