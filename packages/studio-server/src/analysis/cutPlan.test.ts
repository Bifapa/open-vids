// @vitest-environment node
import type {
  AssetRange,
  CutPlan,
  CutPlanRequest,
  SegmentMap,
  ShotMap,
  SilenceMap,
  TakeAnalysis,
  TakeIssue,
  TranscriptArtifact,
} from "@hyperframes/agent-protocol";
import { describe, expect, it } from "vitest";
import { cleanRanges, mergeCutRequest, planCut } from "./cutPlan.js";
import { isAnalysisFailure } from "./errors.js";
import { semanticSegments } from "./segmentation.js";
import { detectTakeIssues } from "./takes.js";
import { transcriptOf } from "./testTranscript.js";
import { buildTranscript } from "./transcript.js";

const SOURCE = "media/talk.mp4";
const SCRIPT = [
  "Welcome |0.5 everyone to the |0.5 channel.",
  "Today we cover three things.",
  "First um the setup is simple. |1.5",
  "You just plug it in.",
  "Second the results are great.",
  "The the numbers speak for themselves.",
  "Finally we look at costs and pricing for teams. |1.0",
  "Finally we look at costs and pricing for teams and companies.",
  "Thanks for watching and see you soon.",
].join(" ");
const SEGMENT_SPANS = [
  ["s1", "s2", "intro", "should"],
  ["s3", "s4", "main", "must"],
  ["s5", "s6", "main", "should"],
  ["s7", "s8", "main", "should"],
  ["s9", "s9", "outro", "should"],
] as const;

interface Fixture {
  transcript: TranscriptArtifact;
  takes: TakeAnalysis;
  segments: SegmentMap;
  duration: number;
}

function fixture(): Fixture {
  const transcript = transcriptOf(SCRIPT);
  const takes = detectTakeIssues({ transcript, silence: null, shots: null });
  const segments = semanticSegments({
    transcript,
    transcriptVersion: "sha256:t",
    speakers: null,
    request: {
      source: transcript.source,
      transcriptVersion: "sha256:t",
      segments: SEGMENT_SPANS.map(([firstSentence, lastSentence, role, priority]) => ({
        firstSentence,
        lastSentence,
        title: `${firstSentence}`,
        summary: "",
        role,
        priority,
      })),
    },
  });
  const duration = (transcript.words[transcript.words.length - 1]?.end ?? 0) + 1;
  return { transcript, takes, segments, duration };
}

function plan(
  request: Partial<CutPlanRequest> = {},
  patch: Partial<{
    takes: TakeAnalysis | null;
    segments: SegmentMap;
    shots: ShotMap | null;
    transcript: TranscriptArtifact;
    mediaRange: AssetRange | null;
  }> = {},
): CutPlan {
  const base = fixture();
  return planCut({
    id: "cut-1",
    createdAt: 1,
    request: { source: SOURCE, ...request },
    basedOn: null,
    transcript: patch.transcript ?? base.transcript,
    transcriptVersion: "sha256:t",
    silence: null,
    takes: patch.takes === undefined ? base.takes : patch.takes,
    segments: patch.segments ?? base.segments,
    segmentsVersion: "sha256:g",
    shots: patch.shots === undefined ? null : patch.shots,
    sourceDuration: base.duration,
    mediaRange: patch.mediaRange ?? null,
  });
}

function refusal(run: () => unknown) {
  try {
    run();
  } catch (error) {
    if (isAnalysisFailure(error)) return error.error;
    throw error;
  }
  throw new Error("expected a refusal");
}

const middle = (word: { start: number; end: number }) => (word.start + word.end) / 2;
const inside = (range: { from: number; to: number }, time: number) =>
  time > range.from && time < range.to;

/** Words whose middle lies in a non-hook range, and how many ranges hold each. */
function coverage(cut: CutPlan, transcript: TranscriptArtifact) {
  return transcript.words.map(
    (word) => cut.ranges.filter((range) => !range.hook && inside(range, middle(word))).length,
  );
}

function issueWords(transcript: TranscriptArtifact, issue: TakeIssue): number[] {
  return transcript.words
    .filter((word) => middle(word) >= issue.start && middle(word) <= issue.end)
    .map((word) => word.i);
}

describe("planCut: default rough cut", () => {
  const { transcript, takes } = fixture();
  const cut = plan();
  const cutIssues = takes.issues.filter((issue) => issue.action === "cut");

  it("finds the issues the plan relies on", () => {
    expect(new Set(cutIssues.map((issue) => issue.kind))).toEqual(
      new Set(["filler", "stutter", "retake"]),
    );
  });

  it("puts ranges back to back on the timeline with strictly increasing, contiguous positions", () => {
    let position = 0;
    for (const range of cut.ranges) {
      expect(range.to).toBeGreaterThan(range.from);
      expect(range.at).toBeCloseTo(position, 6);
      position += range.to - range.from;
    }
    expect(cut.stats.cutDuration).toBeCloseTo(position, 6);
    expect(cut.stats.ranges).toBe(cut.ranges.length);
    expect(cut.stats.sourceDuration).toBeGreaterThan(cut.stats.cutDuration);
  });

  it("keeps every kept word in exactly one range and no cut word in any", () => {
    const counts = coverage(cut, transcript);
    const removed = new Set(cutIssues.flatMap((issue) => issueWords(transcript, issue)));
    expect(removed.size).toBeGreaterThan(0);
    for (const word of transcript.words)
      expect(counts[word.i], `word ${word.i} "${word.text}"`).toBe(removed.has(word.i) ? 0 : 1);
  });

  it("never overlaps ranges in the source and keeps them in source order", () => {
    const main = cut.ranges.filter((range) => !range.hook);
    for (let index = 1; index < main.length; index++)
      expect(main[index]?.from).toBeGreaterThanOrEqual(main[index - 1]?.to ?? 0);
  });

  it("pads speech by 0.08 s before and 0.12 s after, never into a removed word", () => {
    const first = transcript.words[0];
    expect(cut.ranges[0]?.from).toBe(Math.max(0, (first?.start ?? 0) - 0.08));
    const um = transcript.words.find((word) => word.text === "um");
    const before = transcript.words[(um?.i ?? 0) - 1];
    const after = transcript.words[(um?.i ?? 0) + 1];
    const around = cut.ranges.filter(
      (range) => range.to > (before?.start ?? 0) && range.from < (after?.end ?? 0),
    );
    expect(around.length).toBe(2);
    expect(around[0]?.to).toBeCloseTo(Math.min((before?.end ?? 0) + 0.12, um?.start ?? 0), 3);
    expect(around[1]?.from).toBeCloseTo(Math.max((after?.start ?? 0) - 0.08, um?.end ?? 0), 3);
  });

  it("shortens a long pause to pauseKeep and lists it as removed", () => {
    const pauses = cut.removed.filter((entry) => entry.reason === "pause");
    expect(pauses).toHaveLength(1);
    // 1.55 s between "simple." and "You", of which 0.3 s stay.
    expect((pauses[0]?.to ?? 0) - (pauses[0]?.from ?? 0)).toBeCloseTo(1.25, 2);
    expect(cut.stats.removedPauseSeconds).toBeCloseTo(1.25, 2);
    // The 0.5 s pauses inside the first sentence are under maxPause and stay.
    expect(coverage(cut, transcript).slice(0, 5)).toEqual([1, 1, 1, 1, 1]);
  });

  it("records removed fillers and takes with their issue ids", () => {
    const byReason = (reason: string) => cut.removed.filter((entry) => entry.reason === reason);
    const fillerIssue = cutIssues.find((issue) => issue.kind === "filler");
    expect(byReason("filler")).toEqual([
      { from: fillerIssue?.start, to: fillerIssue?.end, reason: "filler", ref: fillerIssue?.id },
    ]);
    expect(byReason("take").map((entry) => entry.ref)).toEqual(
      cutIssues.filter((issue) => issue.kind !== "filler").map((issue) => issue.id),
    );
    expect(cut.stats.removedFillers).toBe(1);
    expect(cut.stats.removedTakes).toBe(cutIssues.length - 1);
    expect(cut.stats.droppedSegments).toEqual([]);
    expect(cut.stats.movedSegments).toEqual([]);
    expect(cut.stats.hookSeconds).toBe(0);
    expect(cut.warnings).toEqual([]);
  });

  it("does not force a cut at a segment boundary in source order", () => {
    // s1|s2 are both in g1; s2|s3 is a boundary with a 0.05 s gap: one continuous range.
    const s2 = transcript.sentences[1];
    const s3 = transcript.sentences[2];
    const crossing = cut.ranges.filter(
      (range) => range.from < (s2?.end ?? 0) && range.to > (s3?.start ?? 0),
    );
    expect(crossing).toHaveLength(1);
  });

  it("carries the effective request, versions and label", () => {
    expect(cut).toMatchObject({
      id: "cut-1",
      source: SOURCE,
      label: "rough cut",
      basedOn: null,
      applied: null,
      transcriptVersion: "sha256:t",
      segmentsVersion: "sha256:g",
    });
    expect(cut.request).toMatchObject({
      removeIssues: "auto",
      removeFillers: true,
      maxPause: 0.7,
      pauseKeep: 0.3,
    });
  });
});

describe("planCut: fillers and issue selection", () => {
  const { transcript, takes } = fixture();
  const filler = takes.issues.find((issue) => issue.kind === "filler");
  const stutter = takes.issues.find((issue) => issue.kind === "stutter");

  it("keeps fillers when removeFillers is false", () => {
    const cut = plan({ removeFillers: false });
    const um = transcript.words.find((word) => word.text === "um");
    expect(coverage(cut, transcript)[um?.i ?? 0]).toBe(1);
    expect(cut.stats.removedFillers).toBe(0);
  });

  it("keepIssues restores an issue that auto would cut", () => {
    const cut = plan({ keepIssues: [stutter?.id ?? ""] });
    const words = issueWords(transcript, stutter as TakeIssue);
    for (const index of words) expect(coverage(cut, transcript)[index]).toBe(1);
    expect(cut.removed.some((entry) => entry.ref === stutter?.id)).toBe(false);
  });

  it("removes exactly the listed issues when removeIssues is a list (fillers still follow removeFillers)", () => {
    const cut = plan({ removeIssues: [stutter?.id ?? ""], removeFillers: false });
    expect(
      cut.removed.filter((entry) => entry.reason !== "pause").map((entry) => entry.ref),
    ).toEqual([stutter?.id]);
    const cutWithFiller = plan({ removeIssues: [], removeFillers: true });
    expect(cutWithFiller.removed.map((entry) => entry.ref).filter(Boolean)).toEqual([filler?.id]);
  });

  it("refuses unknown issue ids", () => {
    expect(refusal(() => plan({ removeIssues: ["t99"] }))).toMatchObject({
      code: "invalid_request",
      message: expect.stringContaining("t99"),
    });
    expect(refusal(() => plan({ keepIssues: ["t98"] })).message).toContain("t98");
  });
});

describe("planCut: segments, order and the must guard", () => {
  const { transcript, segments } = fixture();
  const sequence = (cut: CutPlan) => {
    const seen: string[] = [];
    for (const range of cut.ranges) {
      if (range.hook || range.segment === null) continue;
      if (seen[seen.length - 1] !== range.segment) seen.push(range.segment);
    }
    return seen;
  };

  it("plays segments in the requested order and reports the moved ones", () => {
    const cut = plan({ order: ["g1", "g3", "g2", "g4", "g5"] });
    // g5 follows g4 directly in the source, so its material continues g4's last range.
    expect(sequence(cut)).toEqual(["g1", "g3", "g2", "g4"]);
    expect(cut.stats.movedSegments).toEqual(["g2"]);
    expect(cut.stats.droppedSegments).toEqual([]);
    // The rearranged material still holds each kept word once and overlaps nothing in the source.
    const counts = coverage(cut, transcript);
    expect(counts.every((count) => count <= 1)).toBe(true);
    const sorted = [...cut.ranges].sort((a, b) => a.from - b.from);
    for (let index = 1; index < sorted.length; index++)
      expect(sorted[index]?.from).toBeGreaterThanOrEqual(sorted[index - 1]?.to ?? 0);
    expect(
      cut.ranges.some(
        (range, index) => index > 0 && range.from < (cut.ranges[index - 1]?.from ?? 0),
      ),
    ).toBe(true);
  });

  it("drops segments that are not in the order or are listed in drop, and records them", () => {
    const cut = plan({ order: ["g1", "g2", "g3", "g5"] });
    expect(cut.stats.droppedSegments).toEqual(["g4"]);
    const g4 = segments.segments[3];
    expect(cut.removed).toContainEqual({
      from: g4?.start,
      to: g4?.end,
      reason: "segment",
      ref: "g4",
    });
    const words = transcript.words.filter(
      (word) => word.start >= (g4?.start ?? 0) && word.end <= (g4?.end ?? 0),
    );
    const counts = coverage(cut, transcript);
    for (const word of words) expect(counts[word.i]).toBe(0);
    expect(plan({ drop: ["g4"] }).stats.droppedSegments).toEqual(["g4"]);
  });

  it("drops priority-drop segments unless they are listed in order", () => {
    const flagged: SegmentMap = {
      ...segments,
      segments: segments.segments.map((segment) =>
        segment.id === "g3" ? { ...segment, priority: "drop" } : segment,
      ),
    };
    expect(plan({}, { segments: flagged }).stats.droppedSegments).toEqual(["g3"]);
    expect(
      plan({ order: ["g1", "g2", "g3", "g4", "g5"] }, { segments: flagged }).stats.droppedSegments,
    ).toEqual([]);
  });

  it("refuses to drop a must segment without allowDropMust, however it is dropped", () => {
    for (const request of [{ drop: ["g2"] }, { order: ["g1", "g3", "g4", "g5"] }]) {
      const error = refusal(() => plan(request));
      expect(error.code).toBe("invalid_request");
      expect(error.message).toContain("g2");
      expect(error.message).toContain("allowDropMust");
    }
    const allowed = plan({ drop: ["g2"], allowDropMust: ["g2"] });
    expect(allowed.stats.droppedSegments).toEqual(["g2"]);
  });

  it("refuses unknown and repeated segment ids", () => {
    expect(refusal(() => plan({ order: ["g1", "g9"] })).message).toContain("g9");
    expect(refusal(() => plan({ drop: ["g8"] })).message).toContain("g8");
    expect(refusal(() => plan({ allowDropMust: ["g7"] })).message).toContain("g7");
    expect(refusal(() => plan({ order: ["g1", "g1"] })).message).toContain("twice");
  });

  it("refuses a plan that keeps nothing", () => {
    const error = refusal(() =>
      plan({ drop: ["g1", "g2", "g3", "g4", "g5"], allowDropMust: ["g2"] }),
    );
    expect(error.code).toBe("invalid_request");
  });
});

describe("planCut: hook", () => {
  const { transcript } = fixture();

  it("plays the hook sentences first, flagged, and again at their place", () => {
    const cut = plan({ hook: { firstSentence: "s2", lastSentence: "s2" } });
    const hook = cut.ranges.filter((range) => range.hook);
    expect(cut.ranges.slice(0, hook.length).every((range) => range.hook)).toBe(true);
    expect(hook.length).toBeGreaterThan(0);
    expect(cut.ranges[0]?.at).toBe(0);
    const s2 = transcript.sentences[1];
    const before = transcript.words[(s2?.firstWord ?? 1) - 1];
    const after = transcript.words[(s2?.lastWord ?? 0) + 1];
    // Padding stops at the neighbouring words.
    expect(hook[0]?.from).toBeCloseTo(before?.end ?? 0, 3);
    expect(hook[hook.length - 1]?.to).toBeCloseTo(after?.start ?? 0, 3);
    expect(cut.stats.hookSeconds).toBeCloseTo(
      hook.reduce((sum, range) => sum + range.to - range.from, 0),
      3,
    );
    // The sentence is also in the main material.
    const s2Words = transcript.words.filter(
      (word) => word.i >= (s2?.firstWord ?? 0) && word.i <= (s2?.lastWord ?? 0),
    );
    for (const word of s2Words) expect(coverage(cut, transcript)[word.i]).toBe(1);
    const plain = plan();
    expect(cut.stats.cutDuration).toBeCloseTo(plain.stats.cutDuration + cut.stats.hookSeconds, 3);
    expect(cut.ranges.filter((range) => !range.hook)).toEqual(
      plain.ranges.map((range) => ({ ...range, at: expect.any(Number) })),
    );
  });

  it("leaves cut words out of the hook too", () => {
    const cut = plan({ hook: { firstSentence: "s3", lastSentence: "s4" } });
    const um = transcript.words.find((word) => word.text === "um");
    expect(
      cut.ranges
        .filter((range) => range.hook)
        .some((range) => inside(range, middle(um ?? { start: 0, end: 0 }))),
    ).toBe(false);
  });

  it("refuses unknown or reversed hook sentences", () => {
    expect(
      refusal(() => plan({ hook: { firstSentence: "s99", lastSentence: "s99" } })).message,
    ).toContain("s99");
    expect(
      refusal(() => plan({ hook: { firstSentence: "s5", lastSentence: "s2" } })).message,
    ).toContain("comes after");
  });
});

describe("planCut: pacing pass", () => {
  it("a refinement with a smaller maxPause is never longer and removes more pause", () => {
    const first = plan();
    const merged = mergeCutRequest(first.request, {
      source: SOURCE,
      basedOn: "cut-1",
      maxPause: 0.3,
      pauseKeep: 0.1,
      label: "pacing pass",
    });
    const paced = plan(merged);
    expect(merged).toMatchObject({
      basedOn: "cut-1",
      maxPause: 0.3,
      pauseKeep: 0.1,
      label: "pacing pass",
    });
    expect(paced.stats.cutDuration).toBeLessThanOrEqual(first.stats.cutDuration);
    expect(paced.stats.removedPauseSeconds).toBeGreaterThan(first.stats.removedPauseSeconds);
    // The three 0.5 s pauses of the first sentence are now cut down.
    expect(paced.removed.filter((entry) => entry.reason === "pause").length).toBeGreaterThan(1);
  });

  it("a pause of exactly maxPause is kept", () => {
    const transcript = transcriptOf("one two |0.7 three four five six", { gapSeconds: 0 });
    const segments = semanticSegments({
      transcript,
      transcriptVersion: "sha256:t",
      speakers: null,
      request: {
        source: transcript.source,
        transcriptVersion: "sha256:t",
        segments: [
          {
            firstSentence: "s1",
            lastSentence: "s1",
            title: "a",
            summary: "",
            role: "main",
            priority: "should",
          },
        ],
      },
    });
    const cut = plan({}, { transcript, segments, takes: null });
    expect(cut.removed).toEqual([]);
  });
});

describe("planCut: silence map", () => {
  type Raw = Array<{ text: string; start: number; end: number }>;
  const silenceMap = (ranges: Array<[number, number]>): SilenceMap => ({
    source: SOURCE,
    thresholdDb: -40,
    minSilence: 0.35,
    silences: ranges.map(([start, end]) => ({ start, end })),
    silenceSeconds: ranges.reduce((sum, [start, end]) => sum + end - start, 0),
  });

  function planRaw(
    raw: Raw,
    silence: SilenceMap | null,
    request: Partial<CutPlanRequest> = {},
    sourceDuration = 12,
  ): CutPlan {
    const transcript = buildTranscript(SOURCE, raw, "en", null);
    const last = transcript.sentences[transcript.sentences.length - 1];
    const segments = semanticSegments({
      transcript,
      transcriptVersion: "sha256:t",
      speakers: null,
      request: {
        source: SOURCE,
        transcriptVersion: "sha256:t",
        segments: [
          {
            firstSentence: "s1",
            lastSentence: last?.id ?? "s1",
            title: "all",
            summary: "",
            role: "main",
            priority: "should",
          },
        ],
      },
    });
    return planCut({
      id: "cut-1",
      createdAt: 1,
      request: { source: SOURCE, ...request },
      basedOn: null,
      transcript,
      transcriptVersion: "sha256:t",
      silence,
      takes: null,
      segments,
      segmentsVersion: "sha256:g",
      shots: null,
      sourceDuration,
    });
  }

  const bounds = (cut: CutPlan) => cut.ranges.map((range) => [range.from, range.to]);
  /** Seconds of a source span that the ranges still play. */
  const kept = (cut: CutPlan, [from, to]: [number, number]) =>
    cut.ranges.reduce(
      (sum, range) => sum + Math.max(0, Math.min(to, range.to) - Math.max(from, range.from)),
      0,
    );

  // "friend." is timed to 3.0 s although the speaker stops at 1.3 s: the recognizer stretched it over the pause.
  const stretched: Raw = [
    { text: "hello", start: 0, end: 0.4 },
    { text: "there", start: 0.45, end: 0.85 },
    { text: "friend.", start: 0.9, end: 3.0 },
    { text: "this", start: 3.6, end: 3.9 },
    { text: "is", start: 3.95, end: 4.2 },
    { text: "next.", start: 4.25, end: 4.6 },
  ];

  it("shortens a silence that the word timestamps hide to pauseKeep and never cuts audible speech", () => {
    const cut = planRaw(stretched, silenceMap([[1.3, 3.5]]));
    // Every word gap is under maxPause, so the word-gap fallback finds nothing.
    expect(planRaw(stretched, null).removed).toEqual([]);
    expect(cut.removed).toEqual([{ from: 1.45, to: 3.35, reason: "pause", ref: null }]);
    expect(bounds(cut)).toEqual([
      [0, 1.45],
      [3.35, 4.72],
    ]);
    expect(kept(cut, [1.3, 3.5])).toBeCloseTo(0.3, 3);
    expect(cut.stats.removedPauseSeconds).toBeCloseTo(1.9, 3);
    expect(cut.stats.cutDuration).toBeCloseTo(1.45 + 1.37, 3);
  });

  it("treats a word that starts inside the silence as starting at the silence edge", () => {
    // "again" is timed from 1.5 s but is only heard from 4.0 s.
    const cut = planRaw(
      [
        { text: "hello", start: 0, end: 0.4 },
        { text: "there.", start: 0.45, end: 0.85 },
        { text: "again", start: 1.5, end: 4.3 },
        { text: "friend.", start: 4.35, end: 4.8 },
      ],
      silenceMap([[0.9, 4.0]]),
    );
    expect(cut.removed).toEqual([{ from: 1.05, to: 3.85, reason: "pause", ref: null }]);
    expect(bounds(cut)).toEqual([
      [0, 1.05],
      [3.85, 4.92],
    ]);
  });

  it("drops a word that lies entirely inside a cut silence and keeps the rest", () => {
    const cut = planRaw(
      [
        { text: "one.", start: 0, end: 0.4 },
        { text: "ghost", start: 1.0, end: 1.3 },
        { text: "two.", start: 3.2, end: 3.6 },
      ],
      silenceMap([[0.5, 3.1]]),
    );
    expect(bounds(cut)).toEqual([
      [0, 0.65],
      [2.95, 3.72],
    ]);
    expect(cut.removed).toEqual([{ from: 0.65, to: 2.95, reason: "pause", ref: null }]);
  });

  it("keeps a silence of at most maxPause and uses word gaps only when there is no silence map", () => {
    const raw: Raw = [
      { text: "hello", start: 0, end: 0.4 },
      { text: "there.", start: 1.5, end: 1.9 },
    ];
    const withMap = planRaw(raw, silenceMap([[0.4, 1.1]]));
    expect(withMap.removed).toEqual([]);
    expect(withMap.ranges).toHaveLength(1);
    const fallback = planRaw(raw, null);
    expect(fallback.removed).toHaveLength(1);
    expect(fallback.ranges).toHaveLength(2);
  });

  it("leaves no cuttable silence longer than pauseKeep in any range, never re-adds it with padding, and a pacing pass cuts more", () => {
    const raw: Raw = [];
    const silences: Array<[number, number]> = [];
    let time = 0;
    const gaps = [0.5, 1.4, 0.9, 3, 0.8, 2.2];
    for (const [sentence, gap] of gaps.entries()) {
      for (const text of ["we", "keep", "going."]) {
        raw.push({ text, start: time, end: time + 0.3 });
        time += 0.35;
      }
      // Every other pause has its last word stretched over it.
      const lastWord = raw[raw.length - 1];
      if (lastWord && sentence % 2 === 0) lastWord.end += gap - 0.1;
      silences.push([time - 0.05, time - 0.05 + gap]);
      time += gap;
    }
    const first = planRaw(raw, silenceMap(silences), {}, time + 1);
    for (const silence of silences)
      if (silence[1] - silence[0] > 0.7)
        expect(kept(first, silence)).toBeLessThanOrEqual(0.3 + 2e-3);
    // Four pauses lie between words and are cut; the 0.5 s one is short and the last one trails the speech.
    expect(first.removed.filter((entry) => entry.reason === "pause")).toHaveLength(4);

    const paced = planRaw(
      raw,
      silenceMap(silences),
      mergeCutRequest(first.request, { source: SOURCE, maxPause: 0.4, pauseKeep: 0.1 }),
      time + 1,
    );
    expect(paced.stats.cutDuration).toBeLessThan(first.stats.cutDuration);
    for (const silence of silences) expect(kept(paced, silence)).toBeLessThanOrEqual(0.1 + 2e-3);
    for (const cut of [first, paced])
      for (let index = 1; index < cut.ranges.length; index++)
        expect(cut.ranges[index]?.from).toBeGreaterThanOrEqual(cut.ranges[index - 1]?.to ?? 0);
  });
});

describe("planCut: warnings", () => {
  const { transcript, segments } = fixture();
  const takes = (issues: TakeIssue[]): TakeAnalysis => ({ source: SOURCE, issues });
  const review = (patch: Partial<TakeIssue>): TakeIssue => ({
    id: "t1",
    kind: "retake",
    start: 0,
    end: 0.3,
    sentences: ["s1"],
    confidence: 0.6,
    action: "review",
    note: "s1 might be said again",
    keep: null,
    ...patch,
  });

  it("warns when the target duration is missed by more than 10 %", () => {
    const plain = plan();
    const target = plain.stats.cutDuration * 2;
    const warnings = plan({ targetDuration: target }).warnings;
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("under");
    expect(plan({ targetDuration: plain.stats.cutDuration * 1.05 }).warnings).toEqual([]);
    expect(plan({ targetDuration: plain.stats.cutDuration / 2 }).warnings[0]).toContain("over");
  });

  it("warns about a take issue that needs review and is left in", () => {
    const cut = plan({}, { takes: takes([review({ id: "t7", start: 1, end: 2 })]) });
    expect(cut.warnings).toHaveLength(1);
    expect(cut.warnings[0]).toContain("t7");
    expect(cut.warnings[0]).toContain("needs a decision");
    // Listing it in removeIssues removes it and the warning goes away.
    const fixed = plan(
      { removeIssues: ["t7"] },
      { takes: takes([review({ id: "t7", start: 1, end: 2 })]) },
    );
    expect(fixed.warnings).toEqual([]);
    expect(fixed.stats.removedTakes).toBe(1);
  });

  it("reports black or frozen picture inside kept ranges with timeline times", () => {
    const probeFrom = (transcript.sentences[1]?.start ?? 0) + 0.2;
    const probeTo = probeFrom + 1;
    const shots: ShotMap = {
      source: SOURCE,
      sceneThreshold: 0.3,
      shots: [],
      problems: [{ kind: "black", start: probeFrom, end: probeTo }],
    };
    const cut = plan({}, { shots });
    const message = cut.warnings.find((warning) => warning.startsWith("Black picture"));
    expect(message).toBeDefined();
    const range = cut.ranges.find(
      (candidate) => candidate.from <= probeFrom && candidate.to >= probeTo,
    );
    expect(range).toBeDefined();
    const at = (range?.at ?? 0) + (probeFrom - (range?.from ?? 0));
    expect(message).toContain(
      `${at.toFixed(1)} s–${(at + 1).toFixed(1)} s on the timeline (source ${probeFrom.toFixed(1)} s–${probeTo.toFixed(1)} s)`,
    );
  });

  it("does not warn about a visual problem in material that is cut", () => {
    const g5 = segments.segments[4];
    const shots: ShotMap = {
      source: SOURCE,
      sceneThreshold: 0.3,
      shots: [],
      problems: [{ kind: "frozen", start: (g5?.start ?? 0) + 0.2, end: (g5?.end ?? 0) - 0.2 }],
    };
    expect(plan({ drop: ["g5"] }, { shots }).warnings).toEqual([]);
    expect(plan({}, { shots }).warnings).toHaveLength(1);
  });

  it("warns when more than 30 % of the should segments are left out", () => {
    const one = plan({ drop: ["g5"] });
    expect(one.warnings).toEqual([]);
    const two = plan({ drop: ["g4", "g5"] });
    expect(two.warnings).toHaveLength(1);
    expect(two.warnings[0]).toContain("g4, g5");
    expect(transcript.sentences.length).toBeGreaterThan(0);
  });
});

describe("mergeCutRequest", () => {
  it("fills in the defaults", () => {
    expect(mergeCutRequest(null, { source: SOURCE })).toEqual({
      source: SOURCE,
      label: "rough cut",
      removeIssues: "auto",
      removeFillers: true,
      maxPause: 0.7,
      pauseKeep: 0.3,
    });
  });

  it("takes every option not given from the base and lets the request override", () => {
    const base = mergeCutRequest(null, {
      source: SOURCE,
      order: ["g2", "g1"],
      drop: ["g3"],
      hook: { firstSentence: "s1", lastSentence: "s1" },
      removeFillers: false,
      maxPause: 0.9,
      pauseKeep: 0.4,
      targetDuration: 60,
      label: "first",
    });
    const merged = mergeCutRequest(base, {
      source: SOURCE,
      basedOn: "cut-1",
      maxPause: 0.5,
      drop: [],
    });
    expect(merged).toMatchObject({
      order: ["g2", "g1"],
      drop: [],
      hook: { firstSentence: "s1", lastSentence: "s1" },
      removeFillers: false,
      maxPause: 0.5,
      pauseKeep: 0.4,
      targetDuration: 60,
      basedOn: "cut-1",
      label: "rough cut",
    });
  });

  it("clears the hook with null and lowers an inherited pauseKeep that no longer fits", () => {
    const base = mergeCutRequest(null, {
      source: SOURCE,
      hook: { firstSentence: "s1", lastSentence: "s1" },
    });
    const merged = mergeCutRequest(base, { source: SOURCE, hook: null, maxPause: 0.2 });
    expect(merged.hook).toBeNull();
    expect(merged.maxPause).toBe(0.2);
    expect(merged.pauseKeep).toBe(0.2);
  });

  it("refuses another source and a pauseKeep above maxPause", () => {
    const base = mergeCutRequest(null, { source: SOURCE });
    expect(refusal(() => mergeCutRequest(base, { source: "media/other.mp4" })).code).toBe(
      "invalid_request",
    );
    expect(
      refusal(() => mergeCutRequest(base, { source: SOURCE, maxPause: 0.2, pauseKeep: 0.5 }))
        .message,
    ).toContain("pauseKeep");
  });
});

describe("cleanRanges", () => {
  const base = fixture();
  const asRanges = (segments: SegmentMap["segments"]) =>
    segments.map((segment) => ({ from: segment.start, to: segment.end, segment: segment.id }));
  const clean = (
    ranges: Array<{ from: number; to: number; segment: string | null }>,
    silence: SilenceMap | null,
  ) =>
    cleanRanges({
      ranges,
      transcript: base.transcript,
      takes: base.takes,
      silence,
      sourceDuration: base.duration,
    });

  /** The longest gap between two words, as a silence map (what the level analysis would report for it). */
  const gapSilence = (): SilenceMap => {
    const { words } = base.transcript;
    let widest = { start: 0, end: 0 };
    for (let i = 1; i < words.length; i++) {
      const start = words[i - 1]?.end ?? 0;
      const end = words[i]?.start ?? 0;
      if (end - start > widest.end - widest.start) widest = { start, end };
    }
    return {
      source: SOURCE,
      thresholdDb: -40,
      minSilence: 0.3,
      silences: [widest],
      silenceSeconds: 0,
    };
  };

  it("cuts exactly what the planner cuts when given the planner's segments (word gaps and a silence map)", () => {
    for (const silence of [null, gapSilence()]) {
      const cut = planCut({
        id: "cut-1",
        createdAt: 1,
        request: { source: SOURCE },
        basedOn: null,
        transcript: base.transcript,
        transcriptVersion: "sha256:t",
        silence,
        takes: base.takes,
        segments: base.segments,
        segmentsVersion: "sha256:g",
        shots: null,
        sourceDuration: base.duration,
      });
      const planned = cut.ranges
        .filter((range) => !range.hook)
        .map(({ from, to }) => ({ from, to }));
      const cleaned = clean(asRanges(base.segments.segments), silence).map(({ from, to }) => ({
        from,
        to,
      }));
      expect(planned.length).toBeGreaterThan(3);
      expect(cleaned).toEqual(planned);
    }
  });

  it("leaves out bad takes and fillers of a range, and keeps a range with no speech as it is", () => {
    const all = clean([{ from: 0, to: base.duration, segment: null }], null);
    const words = base.transcript.words.filter((word) => word.text.toLowerCase().startsWith("um"));
    expect(words.length).toBeGreaterThan(0);
    for (const word of words) {
      expect(all.some((range) => range.from < middle(word) && middle(word) < range.to)).toBe(false);
    }
    const tail = base.duration - 0.5;
    expect(clean([{ from: tail, to: base.duration + 5, segment: "silent" }], null)).toEqual([
      { from: tail, to: base.duration, segment: "silent" },
    ]);
  });
});

describe("planCut: the user's picked fragment", () => {
  const base = fixture();
  const segmentById = (id: string) => {
    const segment = base.segments.segments.find((entry) => entry.id === id);
    if (!segment) throw new Error(`no segment ${id}`);
    return segment;
  };

  it("keeps every range inside the pick, records it and stays consistent", () => {
    const first = segmentById("g1");
    const last = segmentById("g3");
    const pick = { start: first.start, end: last.end };
    const cut = plan({}, { mediaRange: pick });
    expect(cut.mediaRange).toEqual(pick);
    expect(cut.ranges.length).toBeGreaterThan(0);
    for (const range of cut.ranges) {
      expect(range.from).toBeGreaterThanOrEqual(pick.start - 1e-9);
      expect(range.to).toBeLessThanOrEqual(pick.end + 1e-9);
    }
    expect(cut.stats.cutDuration).toBeCloseTo(
      cut.ranges.reduce((sum, range) => sum + (range.to - range.from), 0),
      3,
    );
    expect(cut.stats.ranges).toBe(cut.ranges.length);
    // Nothing outside the pick is covered, and no removal is reported outside it (segment drops are reported whole).
    for (const word of base.transcript.words) {
      const time = middle(word);
      if (time >= pick.start && time <= pick.end) continue;
      expect(cut.ranges.some((range) => !range.hook && inside(range, time))).toBe(false);
    }
    for (const entry of cut.removed) {
      if (entry.reason === "segment") continue;
      expect(entry.from).toBeGreaterThanOrEqual(pick.start - 1e-9);
      expect(entry.to).toBeLessThanOrEqual(pick.end + 1e-9);
    }
  });

  it("drops the segments outside the pick with a warning — a must segment too — instead of refusing", () => {
    const only = segmentById("g1");
    const cut = plan({}, { mediaRange: { start: only.start, end: only.end } });
    expect(cut.stats.droppedSegments).toEqual(expect.arrayContaining(["g2", "g3", "g4", "g5"]));
    const warnings = cut.warnings.join(" ");
    expect(warnings).toContain("The user picked");
    expect(warnings).toContain("g2");
    expect(cut.ranges).not.toHaveLength(0);
    expect(cut.ranges.every((range) => range.segment === "g1")).toBe(true);
  });

  it("trims a cleaned piece back to the pick where padding ran past it", () => {
    const g1 = segmentById("g1");
    const lastWord = base.transcript.words
      .filter((word) => middle(word) <= g1.end)
      .sort((a, b) => middle(a) - middle(b))
      .at(-1);
    if (!lastWord) throw new Error("fixture has no words");
    const pick = { start: g1.start, end: middle(lastWord) + 0.03 };
    const cut = plan({}, { mediaRange: pick });
    const last = cut.ranges.filter((range) => !range.hook).at(-1);
    expect(last?.to).toBeCloseTo(pick.end, 3);
    for (const range of cut.ranges) expect(range.to).toBeLessThanOrEqual(pick.end + 1e-9);
  });

  it("keeps the hook inside the pick and says when it had to clip it", () => {
    const g2 = segmentById("g2");
    const g3 = segmentById("g3");
    const pick = { start: g2.start, end: g3.end };
    const cut = plan({ hook: { firstSentence: "s1", lastSentence: "s6" } }, { mediaRange: pick });
    const hookRanges = cut.ranges.filter((range) => range.hook);
    expect(hookRanges.length).toBeGreaterThan(0);
    for (const range of hookRanges) {
      expect(range.from).toBeGreaterThanOrEqual(pick.start - 1e-9);
      expect(range.to).toBeLessThanOrEqual(pick.end + 1e-9);
    }
    expect(cut.warnings.join(" ")).toContain("the hook plays only what is inside it");
  });

  it("refuses with the pick named when nothing inside it can be kept", () => {
    const pick: AssetRange = { start: base.duration - 0.2, end: base.duration };
    const error = refusal(() => plan({}, { mediaRange: pick }));
    expect(error.code).toBe("invalid_request");
    expect(error.message).toContain("The user picked");
    expect(error.message).toContain("no speech");
  });
});
