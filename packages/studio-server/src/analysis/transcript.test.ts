// @vitest-environment node
import { describe, expect, it } from "vitest";
import { buildTranscript } from "./transcript.js";
import { speak, transcriptOf } from "./testTranscript.js";

describe("buildTranscript", () => {
  it("drops non-speech tokens, orders words and repairs overlaps and zero-length words", () => {
    const transcript = buildTranscript(
      "a.mp4",
      [
        { text: " world ", start: 1.0, end: 1.4 },
        { text: "[BLANK_AUDIO]", start: 0, end: 0.9 },
        { text: "(music)", start: 0, end: 0.9 },
        { text: "   ", start: 0.1, end: 0.2 },
        { text: "hello", start: 0.5, end: 1.2 },
        { text: "again", start: 1.4, end: 1.4 },
        { text: "x", start: Number.NaN, end: 2 },
      ],
      "en",
      null,
    );
    expect(transcript.words.map((word) => word.text)).toEqual(["hello", "world", "again"]);
    expect(transcript.words.map((word) => word.i)).toEqual([0, 1, 2]);
    for (const [index, word] of transcript.words.entries()) {
      expect(word.end).toBeGreaterThan(word.start);
      const next = transcript.words[index + 1];
      if (next) expect(next.start).toBeGreaterThanOrEqual(word.end);
    }
    // "hello" was cut short where "world" starts.
    expect(transcript.words[0]?.end).toBe(1.0);
  });

  it("attaches bare punctuation to the word before it", () => {
    const transcript = buildTranscript(
      "a.mp4",
      [
        { text: "Done", start: 0, end: 0.4 },
        { text: ".", start: 0.4, end: 0.41 },
        { text: "Next", start: 0.5, end: 0.9 },
      ],
      null,
      null,
    );
    expect(transcript.words.map((word) => word.text)).toEqual(["Done.", "Next"]);
    expect(transcript.sentences.map((sentence) => sentence.text)).toEqual(["Done.", "Next"]);
  });

  it("splits sentences at terminal punctuation, long gaps and after 45 words", () => {
    const punctuation = transcriptOf("Hello there. How are you? Fine! Ok…");
    expect(punctuation.sentences.map((sentence) => sentence.text)).toEqual([
      "Hello there.",
      "How are you?",
      "Fine!",
      "Ok…",
    ]);
    expect(punctuation.sentences.map((sentence) => sentence.id)).toEqual(["s1", "s2", "s3", "s4"]);

    const gap = transcriptOf("no punctuation here |1.2 and then more |1.0 words follow");
    expect(gap.sentences.map((sentence) => sentence.text)).toEqual([
      "no punctuation here",
      "and then more words follow",
    ]);

    const long = transcriptOf(Array.from({ length: 100 }, (_, i) => `w${i}`).join(" "));
    expect(long.sentences.map((sentence) => sentence.lastWord - sentence.firstWord + 1)).toEqual([
      45, 45, 10,
    ]);
  });

  it("does not end a sentence at an abbreviation", () => {
    const transcript = transcriptOf("Ask Dr. Smith about it. Thanks.");
    expect(transcript.sentences.map((sentence) => sentence.text)).toEqual([
      "Ask Dr. Smith about it.",
      "Thanks.",
    ]);
  });

  it("joins CJK text without spaces and splits at 。", () => {
    const transcript = buildTranscript(
      "a.mp4",
      [
        { text: "你好", start: 0, end: 0.4 },
        { text: "世界。", start: 0.4, end: 0.8 },
        { text: "再见。", start: 0.9, end: 1.3 },
      ],
      "zh",
      null,
    );
    expect(transcript.sentences.map((sentence) => sentence.text)).toEqual(["你好世界。", "再见。"]);
  });

  it("gives each word the speaker of the turn it overlaps most and splits sentences at a speaker change", () => {
    const transcript = transcriptOf("So what happened next? I ran home quickly", {
      turns: [
        { speaker: "S1", start: 0, end: 1.4 },
        { speaker: "S2", start: 1.4, end: 4 },
      ],
    });
    const speakers = transcript.words.map((word) => word.speaker);
    expect(speakers.slice(0, 4)).toEqual(["S1", "S1", "S1", "S1"]);
    expect(speakers.slice(4)).toEqual(["S2", "S2", "S2", "S2"]);
    expect(transcript.sentences.map((sentence) => sentence.speaker)).toEqual(["S1", "S2"]);
  });

  it("puts a word that straddles two turns with the turn covering most of it, and gap words with the nearest turn", () => {
    const transcript = buildTranscript(
      "a.mp4",
      [
        { text: "one", start: 0.9, end: 1.3 },
        { text: "two", start: 3, end: 3.3 },
      ],
      null,
      [
        { speaker: "S1", start: 0, end: 1.0 },
        { speaker: "S2", start: 1.0, end: 2 },
      ],
    );
    expect(transcript.words[0]?.speaker).toBe("S2");
    expect(transcript.words[1]?.speaker).toBe("S2");
  });

  it("leaves speakers null without diarization turns", () => {
    const transcript = transcriptOf("just one voice");
    expect(transcript.words.every((word) => word.speaker === null)).toBe(true);
    expect(buildTranscript("a.mp4", speak("x y"), null, []).words[0]?.speaker).toBeNull();
  });

  it("counts speech seconds as the sum of word durations", () => {
    const transcript = transcriptOf("one two three |5 four");
    expect(transcript.speechSeconds).toBeCloseTo(1.2, 5);
  });

  it("does not split a sentence at diarization jitter: the change needs a pause and three words on each side", () => {
    const transcript = transcriptOf("well perfect let's get into it now", {
      turns: [
        { speaker: "S1", start: 0, end: 1.7 },
        { speaker: "S2", start: 1.7, end: 5 },
      ],
    });
    expect(transcript.sentences).toHaveLength(1);
    expect(transcript.sentences[0]?.speaker).toBe("S1");
    expect(transcript.words.every((word) => word.speaker === "S1")).toBe(true);

    const short = transcriptOf("yes |0.4 that is right and correct", {
      turns: [
        { speaker: "S1", start: 0, end: 0.6 },
        { speaker: "S2", start: 0.6, end: 5 },
      ],
    });
    expect(short.sentences).toHaveLength(1);
    expect(short.sentences[0]?.speaker).toBe("S2");
  });

  it("splits at a speaker change that has a pause and enough words on both sides", () => {
    const transcript = transcriptOf(
      "so what do you think about that |0.4 I think it is fine honestly",
      {
        turns: [
          { speaker: "S1", start: 0, end: 2.7 },
          { speaker: "S2", start: 2.7, end: 8 },
        ],
      },
    );
    expect(transcript.sentences.map((sentence) => [sentence.text, sentence.speaker])).toEqual([
      ["so what do you think about that", "S1"],
      ["I think it is fine honestly", "S2"],
    ]);
  });

  it("keeps the word limit from leaving one or two words as a sentence", () => {
    const lengths = (count: number) =>
      transcriptOf(Array.from({ length: count }, (_, i) => `w${i}`).join(" ")).sentences.map(
        (sentence) => sentence.lastWord - sentence.firstWord + 1,
      );
    expect(lengths(47)).toEqual([47]);
    expect(lengths(48)).toEqual([45, 3]);
  });
});
