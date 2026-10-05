// @vitest-environment node
import type { QaIssueDraft } from "@hyperframes/agent-protocol";
import { describe, expect, it } from "vitest";
import { finalizeIssues, mergeSameSubject } from "./issues.js";

function draft(overrides: Partial<QaIssueDraft>): QaIssueDraft {
  return {
    kind: "frozen_frames",
    severity: "warning",
    source: "render",
    check: "freezedetect",
    start: 2,
    end: 5,
    clipIds: ["hf-talk"],
    subject: "hf-talk",
    message: "The picture is frozen.",
    fixable: true,
    owner: "editor",
    suggestion: null,
    ...overrides,
  };
}

describe("mergeSameSubject", () => {
  it("merges the same thing found by two checks at overlapping times", () => {
    const merged = mergeSameSubject([
      draft({ severity: "error", check: "timeline.past_media", start: 2, end: 5 }),
      draft({ start: 2.1, end: 4.9, clipIds: ["hf-talk", "hf-b"] }),
    ]);
    expect(merged).toHaveLength(1);
    expect(merged[0]).toMatchObject({
      severity: "error",
      check: "timeline.past_media",
      start: 2,
      end: 5,
      clipIds: ["hf-talk", "hf-b"],
    });
    expect(merged[0]?.message).toContain("and 1 more like it");
  });

  it("keeps one kind on one subject at moments that do not touch as separate issues", () => {
    const merged = mergeSameSubject([draft({ start: 40, end: 45 }), draft({ start: 2, end: 5 })]);
    const byTime = [...merged].sort((a, b) => a.start - b.start);
    expect(byTime.map((issue) => [issue.start, issue.end])).toEqual([
      [2, 5],
      [40, 45],
    ]);
    for (const issue of merged) expect(issue.message).not.toContain("more like it");
  });

  it("merges neighbours within the match tolerance, chains them, and leaves a farther one apart", () => {
    const merged = mergeSameSubject([
      draft({ start: 0, end: 1 }),
      draft({ start: 1.6, end: 2.5 }),
      draft({ start: 3.2, end: 4 }),
      draft({ start: 10, end: 11 }),
    ]);
    expect(merged.map((issue) => [issue.start, issue.end])).toEqual([
      [0, 4],
      [10, 11],
    ]);
  });

  it("never merges different kinds, different subjects or issues without a subject", () => {
    const merged = mergeSameSubject([
      draft({}),
      draft({ kind: "black_frames" }),
      draft({ subject: "hf-other" }),
      draft({ subject: null }),
      draft({ subject: null }),
    ]);
    expect(merged).toHaveLength(5);
  });
});

describe("finalizeIssues", () => {
  it("keeps two frozen stretches of one clip apart and orders the result by time", () => {
    const issues = finalizeIssues([draft({ start: 40, end: 45 }), draft({ start: 2, end: 5 })]);
    expect(issues.map((issue) => issue.start)).toEqual([2, 40]);
  });
});
