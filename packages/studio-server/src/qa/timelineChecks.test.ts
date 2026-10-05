// @vitest-environment node
import type { TimelineClip, TranscriptArtifact } from "@hyperframes/agent-protocol";
import { describe, expect, it } from "vitest";
import { isSpeechSource, timelineIssues } from "./timelineChecks.js";
import type { QaTimeline } from "./timelineModel.js";

interface Case {
  src?: string;
  words: Array<[text: string, start: number, end: number]>;
  /** Source second the clip starts at: the cut under test. */
  cut: number;
  speechSeconds?: number;
  sourceDuration?: number | null;
  silences?: Array<{ start: number; end: number }>;
}

/** The cut-in-word issues of one clip that starts at source second `cut` (its end lands far from any word). */
function cutIssues(options: Case) {
  const src = options.src ?? "assets/talk.mp4";
  const clip: TimelineClip = {
    id: "c1",
    domId: null,
    kind: "video",
    label: "talk",
    start: 0,
    duration: 2,
    end: 2,
    track: 0,
    zIndex: null,
    src,
    mediaStart: options.cut,
    sourceDuration: options.sourceDuration === undefined ? 60 : options.sourceDuration,
    volume: null,
    muted: false,
    compositionSrc: null,
    locked: false,
    provenance: null,
  };
  const transcript: TranscriptArtifact = {
    source: src,
    language: "en",
    words: options.words.map(([text, start, end], i) => ({ i, text, start, end, speaker: null })),
    sentences: [],
    speechSeconds: options.speechSeconds ?? 5,
  };
  const timeline: QaTimeline = {
    snapshot: {
      composition: { path: "index.html", width: 1920, height: 1080, duration: 2 },
      version: "v",
      tracks: [{ index: 0, clipIds: ["c1"] }],
      clips: [clip],
    },
    rates: new Map(),
    missing: new Set(),
    hasAudio: new Map(),
    transcripts: new Map([[src, transcript]]),
    silences: options.silences ? new Map([[src, options.silences]]) : undefined,
    cues: [],
    graph: null,
  };
  return timelineIssues(timeline).filter((issue) => issue.check === "timeline.cut_in_word");
}

describe("isSpeechSource", () => {
  it("rejects music and effects folders and files, whatever the case or separator", () => {
    for (const src of [
      "assets/music/theme.mp4",
      "assets/Music.mp3",
      "assets/bgm_loop.mp3",
      "assets/bgm-loop.mp3",
      "assets/SFX/whoosh.wav",
      "assets/sounds/click.wav",
      "assets/sound.wav",
      "assets/fx.mp3",
      "assets/a/soundtrack.m4a",
      "assets/ambient-room.wav",
      "assets/effects/pop.wav",
      "assets/jingle.mp3",
      "assets/music2.mp3",
    ]) {
      expect(isSpeechSource(src), src).toBe(false);
    }
  });

  it("keeps ordinary footage, and names that only contain such a word", () => {
    for (const src of [
      "assets/talk.mp4",
      "assets/interview-final.mov",
      "assets/musical.mp4",
      "assets/soundcheck.mp4",
      "assets/prefix.mp4",
    ]) {
      expect(isSpeechSource(src), src).toBe(true);
    }
  });
});

describe("cut inside a word", () => {
  it("reports a cut through the middle of a spoken word", () => {
    const issues = cutIssues({ words: [["hello", 1, 1.6]], cut: 1.3 });
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ subject: "c1:in", start: 0, check: "timeline.cut_in_word" });
  });

  it("does not look at music and effects sources", () => {
    for (const src of ["assets/music/theme.mp4", "assets/sfx-whoosh.mp4", "assets/BGM.mp4"]) {
      expect(cutIssues({ src, words: [["hello", 1, 1.6]], cut: 1.3 }), src).toEqual([]);
    }
  });

  it("ignores a transcript with negligible speech", () => {
    const words: Case["words"] = [["hello", 1, 1.6]];
    // Under a second of speech: the recognizer heard words in noise.
    expect(cutIssues({ words, cut: 1.3, speechSeconds: 0.6 })).toEqual([]);
    // A few seconds in a ten-minute source (under 2 %).
    expect(cutIssues({ words, cut: 1.3, speechSeconds: 5, sourceDuration: 600 })).toEqual([]);
    // Enough speech for its length, or a length that is not known.
    expect(cutIssues({ words, cut: 1.3, speechSeconds: 5, sourceDuration: 100 })).toHaveLength(1);
    expect(cutIssues({ words, cut: 1.3, speechSeconds: 5, sourceDuration: null })).toHaveLength(1);
  });

  it("ignores words that are not speech: symbols and bracketed or starred annotations", () => {
    for (const text of [
      "♪",
      "…",
      "[Music]",
      "(applause)",
      "*laughs*",
      "[МУЗЫКА]",
      "[Music].",
      "{noise}",
    ]) {
      expect(cutIssues({ words: [[text, 1, 1.6]], cut: 1.3 }), text).toEqual([]);
    }
    // A real word of the same timing is reported.
    expect(cutIssues({ words: [["music", 1, 1.6]], cut: 1.3 })).toHaveLength(1);
    expect(cutIssues({ words: [["(hello)", 1, 1.6]], cut: 1.3 })).toEqual([]);
    expect(cutIssues({ words: [["don't", 1, 1.6]], cut: 1.3 })).toHaveLength(1);
  });

  it("does not stretch a word over the pause after it, with or without a silence map", () => {
    // "hi" takes about half a second to say; the recognizer's timing runs to 2.5 s over the pause after it.
    const words: Case["words"] = [["hi", 1, 2.5]];
    expect(cutIssues({ words, cut: 1.3 })).toHaveLength(1);
    expect(cutIssues({ words, cut: 1.8 })).toEqual([]);
    expect(cutIssues({ words, cut: 2.3 })).toEqual([]);
    // A long word keeps its own length.
    expect(cutIssues({ words: [["extraordinary", 1, 2.4]], cut: 2.0 })).toHaveLength(1);
  });

  it("leaves 0.1 s at each edge of a word", () => {
    const words: Case["words"] = [["hello", 1, 1.6]];
    for (const cut of [0.95, 1.05, 1.09, 1.52, 1.6, 1.65]) {
      expect(cutIssues({ words, cut }), `${cut}`).toEqual([]);
    }
    for (const cut of [1.12, 1.3, 1.48]) {
      expect(cutIssues({ words, cut }), `${cut}`).toHaveLength(1);
    }
  });

  it("still exempts a cut in a measured silence", () => {
    const words: Case["words"] = [["hello", 1, 1.6]];
    expect(cutIssues({ words, cut: 1.3, silences: [{ start: 1.25, end: 1.6 }] })).toEqual([]);
  });
});
