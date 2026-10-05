// @vitest-environment node
import { describe, expect, it } from "vitest";
import { fitToEstimate, type CleanedAroll } from "./aroll.js";

const chapter = (estimatedDuration: number, userSet = true) => ({
  title: "Talk",
  estimatedDuration,
  userEdited: userSet ? ["estimatedDuration"] : [],
});

const aroll = (lengths: number[]): CleanedAroll => {
  let from = 0;
  const pieces = lengths.map((length) => {
    const piece = { source: "assets/talk.mp4", from, to: from + length, segment: null };
    from += length + 5;
    return piece;
  });
  const total = lengths.reduce((sum, length) => sum + length, 0);
  return { pieces, total, length: total, warnings: [] };
};

describe("fitToEstimate", () => {
  it("keeps short pieces whole, in order, and cuts only the last to reach the length", () => {
    // 40 pieces of 1.5 s (60 s) against 30 s: no piece is dropped for being short.
    const fitted = fitToEstimate(chapter(30), aroll(Array.from({ length: 40 }, () => 1.5)));
    expect(fitted.pieces).toHaveLength(20);
    expect(fitted.total).toBe(30);
    expect(fitted.pieces.every((piece) => piece.to - piece.from === 1.5)).toBe(true);
    expect(fitted.pieces.map((piece) => piece.from)).toEqual(
      [...fitted.pieces.map((piece) => piece.from)].sort((a, b) => a - b),
    );
    expect(fitted.warnings.join(" ")).toContain("the A-roll is now 30 s");
  });

  it("trims the piece that crosses the length and keeps its start", () => {
    const fitted = fitToEstimate(chapter(5), aroll([2, 2, 30]));
    expect(fitted.pieces.map((piece) => [piece.from, piece.to])).toEqual([
      [0, 2],
      [7, 9],
      [14, 15],
    ]);
    expect(fitted.total).toBe(5);
    expect(fitted.length).toBe(5);
  });

  it("never empties a chapter, even when the length is shorter than every piece", () => {
    const fitted = fitToEstimate(chapter(0.1), aroll(Array.from({ length: 30 }, () => 1)));
    expect(fitted.pieces).toHaveLength(1);
    expect(fitted.total).toBe(0.1);
  });

  it("stops before a tail too short to be a clip of its own", () => {
    const fitted = fitToEstimate(chapter(4.1), aroll(Array.from({ length: 30 }, () => 2)));
    expect(fitted.pieces).toHaveLength(2);
    expect(fitted.total).toBe(4);
    expect(fitted.warnings.join(" ")).toContain("the A-roll is now 4 s");
  });

  it("leaves a length the AI estimated and material within the margin alone", () => {
    const material = aroll([20, 20]);
    expect(fitToEstimate(chapter(5, false), material)).toBe(material);
    expect(fitToEstimate(chapter(35), material)).toBe(material);
  });
});
