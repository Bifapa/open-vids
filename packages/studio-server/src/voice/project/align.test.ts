import { describe, expect, it } from "vitest";
import { splitScene, tokensOf } from "./align.js";
import { wordsOf } from "./testSupport.js";

describe("tokensOf", () => {
  it("compares words without case, punctuation or typographic apostrophes", () => {
    expect(tokensOf("Don’t stop, ТАК!")).toEqual(["dont", "stop", "так"]);
  });
});

describe("splitScene", () => {
  const lines = [
    { id: "a", spoken: "Hello there my friend." },
    { id: "b", spoken: "Second line is longer than the first." },
  ];
  const heard = wordsOf(lines.map((line) => line.spoken).join("\n"));

  it("cuts each line at its own recognised words, never inside a neighbour", () => {
    const split = splitScene(lines, heard, 6);
    expect(split.ok).toBe(true);
    if (!split.ok) return;
    const [a, b] = split.lines;
    expect(a?.id).toBe("a");
    expect(a?.start).toBeLessThan(0.2);
    expect(a?.start).toBeGreaterThanOrEqual(0);
    expect(a?.words.map((word) => word.text)).toEqual(["Hello", "there", "my", "friend."]);
    expect(b?.start).toBeGreaterThanOrEqual(a?.end ?? 0);
    expect(b?.words).toHaveLength(7);
    // Word times are relative to the line's own start.
    expect(b?.words[0]?.start).toBeGreaterThanOrEqual(0);
    expect(b?.words[0]?.start).toBeLessThan(0.4);
    expect(b?.end).toBeLessThanOrEqual(6);
  });

  it("survives a misheard word and a missing one", () => {
    const damaged = heard
      .filter((word) => word.text !== "my")
      .map((word) => (word.text === "longer" ? { ...word, text: "longor" } : word));
    const split = splitScene(lines, damaged, 6);
    expect(split.ok).toBe(true);
    if (!split.ok) return;
    expect(split.lines[0]?.words).toHaveLength(3);
    expect(split.lines[1]?.words).toHaveLength(7);
  });

  it("refuses when the speech does not match the script", () => {
    const split = splitScene(lines, wordsOf("nothing like it at all"), 6);
    expect(split.ok).toBe(false);
  });

  it("refuses when no speech was recognised", () => {
    expect(splitScene(lines, [], 6)).toEqual({
      ok: false,
      reason: "no speech was recognised in the scene",
    });
  });

  it("refuses a line that has nothing to speak", () => {
    const split = splitScene(
      [
        { id: "a", spoken: "Hello there." },
        { id: "b", spoken: "" },
      ],
      wordsOf("Hello there."),
      3,
    );
    expect(split.ok).toBe(false);
  });
});
