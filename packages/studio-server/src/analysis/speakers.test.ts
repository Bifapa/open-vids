// @vitest-environment node
import { describe, expect, it } from "vitest";
import { buildSpeakerMap } from "./speakers.js";

describe("buildSpeakerMap", () => {
  it("numbers voices by first appearance, merges close turns of one voice and drops blips", () => {
    const map = buildSpeakerMap(
      "a.mp4",
      {
        producer: "test",
        turns: [
          { speaker: 7, start: 0, end: 4 },
          { speaker: 7, start: 4.3, end: 8 },
          { speaker: 3, start: 8.1, end: 8.3 },
          { speaker: 7, start: 8.4, end: 10 },
          { speaker: 3, start: 12, end: 20 },
        ],
      },
      null,
      20,
    );
    expect(map.method).toBe("diarization");
    expect(map.speakers.map((speaker) => speaker.id)).toEqual(["S1", "S2"]);
    expect(map.turns).toEqual([
      { speaker: "S1", start: 0, end: 10 },
      { speaker: "S2", start: 12, end: 20 },
    ]);
    expect(map.speakers[0]).toMatchObject({ seconds: 10, share: 0.556 });
    expect(map.speakers[1]).toMatchObject({ seconds: 8, share: 0.444 });
    expect(map.note).toBeNull();
  });

  it("keeps turns of one voice apart when the gap is half a second or more", () => {
    const map = buildSpeakerMap(
      "a.mp4",
      {
        producer: "test",
        turns: [
          { speaker: 0, start: 0, end: 3 },
          { speaker: 1, start: 3, end: 6 },
          { speaker: 0, start: 6.5, end: 9 },
        ],
      },
      null,
      9,
    );
    expect(map.turns.map((turn) => turn.speaker)).toEqual(["S1", "S2", "S1"]);
  });

  it("falls back to one speaker with the reason when there is no diarization", () => {
    const map = buildSpeakerMap("a.mp4", null, "no diarizer installed", 30, [
      { start: 1, end: 2 },
      { start: 2.1, end: 3 },
      { start: 10, end: 11 },
    ]);
    expect(map.method).toBe("single");
    expect(map.note).toBe("no diarizer installed");
    expect(map.speakers).toEqual([{ id: "S1", label: null, seconds: 2.9, share: 1 }]);
    expect(map.turns).toEqual([
      { speaker: "S1", start: 1, end: 3 },
      { speaker: "S1", start: 10, end: 11 },
    ]);
  });

  it("covers the whole media when no words are given", () => {
    const map = buildSpeakerMap("a.mp4", null, null, 12);
    expect(map.turns).toEqual([{ speaker: "S1", start: 0, end: 12 }]);
    expect(map.speakers[0]?.seconds).toBe(12);
    expect(map.note).toMatch(/not available/);
  });

  it("is a single speaker when diarization finds one voice, even with a second one that is only noise", () => {
    const map = buildSpeakerMap(
      "a.mp4",
      {
        producer: "test",
        turns: [
          { speaker: 0, start: 0, end: 10 },
          { speaker: 1, start: 4, end: 4.2 },
        ],
      },
      null,
      10,
      [{ start: 0.5, end: 9 }],
    );
    expect(map.method).toBe("single");
    expect(map.speakers).toHaveLength(1);
    expect(map.note).toMatch(/single voice/);
  });

  it("hands the turns of a noise voice to the neighbouring voice and numbers the rest by first appearance", () => {
    const map = buildSpeakerMap(
      "a.mp4",
      {
        producer: "test",
        turns: [
          { speaker: 9, start: 0, end: 2 },
          { speaker: 5, start: 2, end: 60 },
          { speaker: 7, start: 60, end: 100 },
          { speaker: 9, start: 100, end: 103 },
          { speaker: 7, start: 103, end: 200 },
        ],
      },
      null,
      200,
    );
    expect(map.speakers.map((speaker) => speaker.id)).toEqual(["S1", "S2"]);
    expect(map.turns).toEqual([
      { speaker: "S1", start: 0, end: 60 },
      { speaker: "S2", start: 60, end: 200 },
    ]);
    expect(map.speakers[0]).toMatchObject({ seconds: 60, share: 0.3 });
  });

  it("keeps a quiet voice that has under 3 % of the speech but at least 15 s", () => {
    const map = buildSpeakerMap(
      "a.mp4",
      {
        producer: "test",
        turns: [
          { speaker: 0, start: 0, end: 490 },
          { speaker: 1, start: 490, end: 510 },
          { speaker: 0, start: 510, end: 1000 },
        ],
      },
      null,
      1000,
    );
    expect(map.speakers.map((speaker) => speaker.id)).toEqual(["S1", "S2"]);
    expect(map.turns.map((turn) => turn.speaker)).toEqual(["S1", "S2", "S1"]);
  });
});
