// @vitest-environment node
import type {
  SaveSegmentsRequest,
  SegmentInput,
  SegmentMap,
  SpeakerMap,
  TranscriptArtifact,
} from "@hyperframes/agent-protocol";
import { describe, expect, it } from "vitest";
import { isAnalysisFailure } from "./errors.js";
import { draftSegments, semanticSegments } from "./segmentation.js";
import { transcriptOf } from "./testTranscript.js";

const COOKING = ["tomato", "sauce", "garlic", "basil", "pasta", "boil", "water", "salt"];
const ENGINES = [
  "engine",
  "piston",
  "cylinder",
  "torque",
  "motor",
  "gearbox",
  "clutch",
  "throttle",
];

/** Ten-word sentences (about 3.5 s each) built from one topic's vocabulary, 0.3 s apart. */
function topic(pool: string[], count: number): string {
  return Array.from({ length: count }, (_, i) => {
    const word = (offset: number) => pool[(i + offset) % pool.length];
    return `The ${word(0)} needs ${word(1)} and ${word(2)} for the ${word(3)}. |0.3`;
  }).join(" ");
}

function draft(transcript: TranscriptArtifact, speakers: SpeakerMap | null = null): SegmentMap {
  return draftSegments({ transcript, transcriptVersion: "sha256:t", silence: null, speakers });
}

/** Every sentence belongs to exactly one segment, in order, with no gap. */
function expectCovers(transcript: TranscriptArtifact, map: SegmentMap) {
  const ids = transcript.sentences.map((sentence) => sentence.id);
  let next = 0;
  for (const segment of map.segments) {
    expect(segment.firstSentence).toBe(ids[next]);
    const last = ids.indexOf(segment.lastSentence);
    expect(last).toBeGreaterThanOrEqual(next);
    next = last + 1;
  }
  expect(next).toBe(ids.length);
}

describe("draftSegments", () => {
  it("splits a two-topic transcript at the topic shift", () => {
    const transcript = transcriptOf(`${topic(COOKING, 16)} ${topic(ENGINES, 16)}`);
    const map = draft(transcript);
    expect(map.origin).toBe("draft");
    expect(map.transcriptVersion).toBe("sha256:t");
    expect(map.segments.map((segment) => [segment.firstSentence, segment.lastSentence])).toEqual([
      ["s1", "s16"],
      ["s17", "s32"],
    ]);
    expectCovers(transcript, map);
  });

  it("splits at long pauses and merges pieces shorter than 40 s into a neighbour", () => {
    const chunk = (count: number) => topic(COOKING, count);
    const transcript = transcriptOf(
      `${chunk(16)} |2.5 ${chunk(16)} |2.5 ${chunk(3)} |2.5 ${chunk(3)}`,
    );
    const map = draft(transcript);
    expectCovers(transcript, map);
    // The two 6-second tails are merged into the 60-second segment before them, not left alone.
    expect(map.segments).toHaveLength(2);
    for (const segment of map.segments)
      expect(segment.end - segment.start).toBeGreaterThanOrEqual(40);
    expect(map.segments[0]?.lastSentence).toBe("s16");
  });

  it("splits a very long single-topic block into segments of 40–150 s", () => {
    const transcript = transcriptOf(topic(COOKING, 100));
    const map = draft(transcript);
    expectCovers(transcript, map);
    expect(map.segments.length).toBeGreaterThan(1);
    for (const segment of map.segments) {
      expect(segment.end - segment.start).toBeLessThanOrEqual(150);
      expect(segment.end - segment.start).toBeGreaterThanOrEqual(40);
    }
  });

  it("starts a segment where a long speaker turn begins and where it ends", () => {
    const first = topic(COOKING, 16);
    const second = topic(COOKING, 14);
    const transcript = transcriptOf(`${first} ${second}`, {
      turns: [
        { speaker: "S1", start: 0, end: 55.2 },
        { speaker: "S2", start: 55.2, end: 200 },
      ],
    });
    const speakers: SpeakerMap = {
      source: transcript.source,
      method: "diarization",
      speakers: [],
      turns: [],
      note: null,
    };
    const map = draft(transcript, speakers);
    expectCovers(transcript, map);
    expect(map.segments).toHaveLength(2);
    expect(map.segments.map((segment) => segment.speaker)).toEqual(["S1", "S2"]);
    expect(map.segments[1]?.firstSentence).toBe("s17");
  });

  it("does not split at a short interjection by another speaker", () => {
    const transcript = transcriptOf(`${topic(COOKING, 8)} Mm-hm right. |0.3 ${topic(COOKING, 8)}`, {
      turns: [
        { speaker: "S1", start: 0, end: 31.5 },
        { speaker: "S2", start: 31.5, end: 33.5 },
        { speaker: "S1", start: 33.5, end: 100 },
      ],
    });
    const speakers: SpeakerMap = {
      source: transcript.source,
      method: "diarization",
      speakers: [],
      turns: [],
      note: null,
    };
    expect(draft(transcript, speakers).segments).toHaveLength(1);
  });

  it("names segments by their first eight words, gives roles and the dominant speaker", () => {
    const transcript = transcriptOf(
      [COOKING, ENGINES, COOKING, ENGINES].map((pool) => topic(pool, 14)).join(" |2 "),
      { language: "en" },
    );
    const map = draft(transcript);
    expect(map.segments.length).toBeGreaterThan(3);
    expect(map.segments[0]?.title).toBe("The tomato needs sauce and garlic for the");
    expect(map.segments.map((segment) => segment.role)).toEqual(
      map.segments.map((_, index) =>
        index === 0 ? "intro" : index === map.segments.length - 1 ? "outro" : "main",
      ),
    );
    expect(
      map.segments.every((segment) => segment.priority === "should" && segment.summary === ""),
    ).toBe(true);
    expect(map.segments.map((segment) => segment.id)).toEqual(
      map.segments.map((_, index) => `g${index + 1}`),
    );
  });

  it("uses role main throughout when there are three segments or fewer", () => {
    const transcript = transcriptOf(`${topic(COOKING, 16)} ${topic(ENGINES, 16)}`);
    expect(draft(transcript).segments.map((segment) => segment.role)).toEqual(["main", "main"]);
  });

  it("returns no segments for an empty transcript", () => {
    expect(draft(transcriptOf("")).segments).toEqual([]);
  });
});

describe("semanticSegments", () => {
  const transcript = transcriptOf(
    "One is here. |0.5 Two is here. |0.5 Three is here. |0.5 Four is here. |0.5 Five is here.",
  );
  const input = (first: string, last: string): SegmentInput => ({
    firstSentence: first,
    lastSentence: last,
    title: `${first}-${last}`,
    summary: "about it",
    role: "main",
    priority: "must",
  });
  const request = (segments: SegmentInput[], version = "sha256:t"): SaveSegmentsRequest => ({
    source: transcript.source,
    transcriptVersion: version,
    segments,
  });
  const plan = (body: SaveSegmentsRequest) =>
    semanticSegments({ transcript, transcriptVersion: "sha256:t", request: body, speakers: null });
  function refusal(body: SaveSegmentsRequest) {
    try {
      plan(body);
    } catch (error) {
      if (isAnalysisFailure(error)) return error.error;
      throw error;
    }
    throw new Error("expected a refusal");
  }

  it("builds segments with ids, times, the agent's fields and origin semantic", () => {
    const map = plan(request([input("s1", "s2"), input("s3", "s5")]));
    expect(map.origin).toBe("semantic");
    expect(map.segments).toHaveLength(2);
    expect(map.segments[0]).toMatchObject({
      id: "g1",
      firstSentence: "s1",
      lastSentence: "s2",
      title: "s1-s2",
      summary: "about it",
      priority: "must",
      start: transcript.sentences[0]?.start,
      end: transcript.sentences[1]?.end,
    });
    expect(map.segments[1]?.end).toBe(transcript.sentences[4]?.end);
    expectCovers(transcript, map);
  });

  it("refuses a stale transcript version with a conflict", () => {
    expect(refusal(request([input("s1", "s5")], "sha256:old"))).toMatchObject({ code: "conflict" });
  });

  it("names the sentences that are in no segment", () => {
    expect(refusal(request([input("s1", "s2"), input("s5", "s5")]))).toMatchObject({
      code: "invalid_request",
      message: expect.stringContaining("s3–s4 are not in any segment"),
    });
    expect(refusal(request([input("s2", "s5")])).message).toContain("s1 is not in any segment");
    expect(refusal(request([input("s1", "s3")])).message).toContain("s4–s5 are not in any segment");
  });

  it("names the sentences that two segments share", () => {
    const error = refusal(request([input("s1", "s3"), input("s3", "s5")]));
    expect(error.code).toBe("invalid_request");
    expect(error.message).toContain("Segment 2 overlaps segment 1");
    expect(error.message).toContain("s3 is in both");
  });

  it("refuses segments out of time order", () => {
    expect(refusal(request([input("s3", "s5"), input("s1", "s2")])).message).toMatch(
      /not in any segment/,
    );
    expect(
      refusal(request([input("s1", "s3"), input("s1", "s2"), input("s4", "s5")])).message,
    ).toMatch(/out of time order/);
  });

  it("refuses unknown sentence ids and reversed ranges", () => {
    expect(refusal(request([input("s1", "s9")])).message).toContain("unknown sentence id s9");
    expect(refusal(request([input("s0", "s5")])).message).toContain("unknown sentence id s0");
    expect(refusal(request([input("s4", "s2")])).message).toContain("comes after");
  });
});
