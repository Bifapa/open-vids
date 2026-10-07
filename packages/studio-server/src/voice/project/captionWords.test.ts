// @vitest-environment node
import type { VoiceLine, VoiceTake } from "@hyperframes/agent-protocol";
import { describe, expect, it } from "vitest";
import { alignSourceWords, takeCaptionWords } from "./captionWords.js";

const heard = (...entries: Array<[string, number, number]>) =>
  entries.map(([text, start, end]) => ({ text, start, end }));

describe("alignSourceWords", () => {
  it("keeps the source words as written, with the time of the heard word", () => {
    const words = alignSourceWords(
      "Hello, there! Don't stop.",
      heard(["hello", 0.2, 0.5], ["there", 0.6, 0.9], ["don’t", 1, 1.3], ["stop", 1.4, 1.8]),
    );
    expect(words).toEqual([
      { text: "Hello,", start: 0.2, end: 0.5 },
      { text: "there!", start: 0.6, end: 0.9 },
      { text: "Don't", start: 1, end: 1.3 },
      { text: "stop.", start: 1.4, end: 1.8 },
    ]);
  });

  it("gives digits the span of the words that were spoken in their place", () => {
    const words = alignSourceWords(
      "In July 2022 we left.",
      heard(
        ["In", 0, 0.2],
        ["July", 0.3, 0.6],
        ["twenty", 0.7, 1],
        ["twenty-two", 1.1, 1.6],
        ["we", 1.7, 1.8],
        ["left", 1.9, 2.2],
      ),
    );
    expect(words.map((word) => word.text)).toEqual(["In", "July", "2022", "we", "left."]);
    expect(words[2]).toEqual({ text: "2022", start: 0.7, end: 1.6 });
    expect(words[3]?.start).toBe(1.7);
  });

  it("shares a gap among several unmatched words by their length", () => {
    const words = alignSourceWords(
      "Call 5G 4KB now",
      heard(
        ["call", 0, 0.4],
        ["five", 0.5, 0.7],
        ["gee", 0.7, 0.9],
        ["four", 1, 1.2],
        ["now", 2, 2.4],
      ),
    );
    // The gap is the span of the three heard words in it, 0.5 to 1.2, shared 2:3.
    expect(words[1]).toEqual({ text: "5G", start: 0.5, end: 0.78 });
    expect(words[2]).toEqual({ text: "4KB", start: 0.78, end: 1.2 });
    expect(words[3]).toEqual({ text: "now", start: 2, end: 2.4 });
  });

  it("times words before the first and after the last match from the heard words around them", () => {
    const words = alignSourceWords(
      "Well, then we go ahead",
      heard(["we", 1, 1.2], ["go", 1.3, 1.5]),
    );
    expect(words.map((word) => word.text)).toEqual(["Well,", "then", "we", "go", "ahead"]);
    // Nothing was heard before "we": the leading words sit at its start, the trailing one at the end of "go".
    expect(words[0]).toEqual({ text: "Well,", start: 1, end: 1 });
    expect(words[1]).toEqual({ text: "then", start: 1, end: 1 });
    expect(words[2]).toEqual({ text: "we", start: 1, end: 1.2 });
    expect(words[4]).toEqual({ text: "ahead", start: 1.5, end: 1.5 });
  });

  it("spreads unmatched words over the whole recording when nothing matches", () => {
    const words = alignSourceWords("alpha beta", heard(["xx", 1, 2], ["yy", 2, 3]));
    expect(words[0]?.start).toBe(1);
    expect(words[1]?.end).toBe(3);
    expect(words[0]?.end).toBe(words[1]?.start);
  });

  it("is empty when nothing was heard or the text has no words", () => {
    expect(alignSourceWords("Hello there", [])).toEqual([]);
    expect(alignSourceWords("   ", heard(["hello", 0, 1]))).toEqual([]);
  });

  it("never lets a word start after it ends or go back in time", () => {
    const words = alignSourceWords(
      "a — b 12 c",
      heard(["a", 0, 0.2], ["b", 0.3, 0.5], ["twelve", 0.6, 1], ["c", 1.1, 1.3]),
    );
    expect(words.map((word) => word.text)).toEqual(["a", "—", "b", "12", "c"]);
    for (const [index, word] of words.entries()) {
      expect(word.end).toBeGreaterThanOrEqual(word.start);
      if (index > 0) expect(word.start).toBeGreaterThanOrEqual(words[index - 1]?.start ?? 0);
    }
  });
});

describe("takeCaptionWords", () => {
  const line: VoiceLine = {
    id: "l1",
    text: "In July 2022",
    speakerText: "In July twenty twenty-two",
    style: "",
    presetId: null,
    takes: [],
    selectedTakeId: null,
  };
  const take: VoiceTake = {
    id: "t1",
    file: "assets/voice/x.wav",
    start: 0,
    end: 2,
    speakerText: line.speakerText,
    style: "",
    presetId: "p",
    model: "m",
    voiceId: "v",
    requestHash: "h",
    scene: null,
    usdCost: null,
    createdAt: 0,
    createdBy: { agent: "user", turnId: null },
  };

  it("is null for a take without words and aligns the line's text otherwise", () => {
    expect(takeCaptionWords(line, take)).toBeNull();
    expect(takeCaptionWords(line, { ...take, words: [] })).toBeNull();
    const words = takeCaptionWords(line, {
      ...take,
      words: heard(
        ["in", 0, 0.2],
        ["july", 0.3, 0.6],
        ["twenty", 0.7, 1],
        ["twenty-two", 1.1, 1.6],
      ),
    });
    expect(words?.map((word) => word.text)).toEqual(["In", "July", "2022"]);
    expect(words?.[2]).toEqual({ text: "2022", start: 0.7, end: 1.6 });
  });
});
