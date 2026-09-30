import { describe, expect, it } from "vitest";
import {
  ANALYSIS_LIMITS,
  isAnalysisError,
  parseAnalyzeRequest,
  parseCutPlanRequest,
  parseFramesRequest,
  parseMarkCutAppliedRequest,
  parseSaveSegmentsRequest,
  parseSaveVisionNotesRequest,
} from "./index.js";

function refused(result: { ok: boolean; error?: unknown }) {
  if (result.ok || !isAnalysisError(result.error))
    throw new Error("expected the request to be refused");
  return result.error;
}

function accepted<T>(result: { ok: true; value: T } | { ok: false; error: unknown }): T {
  if (!result.ok)
    throw new Error(`expected the request to be accepted: ${JSON.stringify(result.error)}`);
  return result.value;
}

describe("parseAnalyzeRequest", () => {
  it("accepts a source with stages, language and force and keeps only what was sent", () => {
    const value = accepted(
      parseAnalyzeRequest({
        source: "media/talk.mp4",
        stages: ["transcript", "silence", "transcript"],
        language: "pt-BR",
        force: true,
      }),
    );
    expect(value).toEqual({
      source: "media/talk.mp4",
      stages: ["transcript", "silence"],
      language: "pt-BR",
      force: true,
    });
    expect(accepted(parseAnalyzeRequest({ source: "a.mp4" }))).toEqual({ source: "a.mp4" });
  });

  it("refuses unknown fields, unknown stages, bad languages and a missing source", () => {
    expect(refused(parseAnalyzeRequest({ source: "a.mp4", extra: 1 })).message).toContain(
      'unknown field "extra"',
    );
    expect(refused(parseAnalyzeRequest({ source: "a.mp4", stages: ["vision"] })).message).toContain(
      "stages[0]",
    );
    expect(refused(parseAnalyzeRequest({ source: "a.mp4", stages: [] })).code).toBe(
      "invalid_request",
    );
    expect(
      refused(parseAnalyzeRequest({ source: "a.mp4", language: "english please" })).message,
    ).toContain("language");
    expect(refused(parseAnalyzeRequest({ source: "  " })).message).toContain("source");
    expect(refused(parseAnalyzeRequest("nope")).message).toContain("JSON object");
    expect(refused(parseAnalyzeRequest({ source: "a.mp4", force: "yes" })).message).toContain(
      "force",
    );
  });

  it("limits the length of the source path", () => {
    expect(
      refused(parseAnalyzeRequest({ source: "a".repeat(ANALYSIS_LIMITS.pathChars + 1) })).message,
    ).toContain(`${ANALYSIS_LIMITS.pathChars}`);
  });
});

const segment = {
  firstSentence: "s1",
  lastSentence: "s4",
  title: "Intro",
  summary: "What the talk is about",
  role: "intro",
  priority: "must",
};

describe("parseSaveSegmentsRequest", () => {
  const request = (patch: Record<string, unknown> = {}) => ({
    source: "a.mp4",
    transcriptVersion: "sha256:abc",
    segments: [segment],
    ...patch,
  });

  it("accepts segments and keeps their fields", () => {
    expect(accepted(parseSaveSegmentsRequest(request()))).toEqual(request());
  });

  it("refuses unknown fields at every level", () => {
    expect(refused(parseSaveSegmentsRequest(request({ extra: 1 }))).message).toContain("extra");
    expect(
      refused(parseSaveSegmentsRequest(request({ segments: [{ ...segment, color: "red" }] })))
        .message,
    ).toContain('segments[0].unknown field "color"');
  });

  it("checks roles, priorities, required text and length limits", () => {
    expect(
      refused(parseSaveSegmentsRequest(request({ segments: [{ ...segment, role: "banter" }] })))
        .message,
    ).toContain("segments[0].role");
    expect(
      refused(parseSaveSegmentsRequest(request({ segments: [{ ...segment, priority: "maybe" }] })))
        .message,
    ).toContain("priority");
    expect(
      refused(parseSaveSegmentsRequest(request({ segments: [{ ...segment, title: "" }] }))).message,
    ).toContain("title");
    expect(
      refused(
        parseSaveSegmentsRequest(
          request({
            segments: [{ ...segment, title: "t".repeat(ANALYSIS_LIMITS.titleChars + 1) }],
          }),
        ),
      ).message,
    ).toContain("exceeds");
    expect(
      refused(
        parseSaveSegmentsRequest(
          request({
            segments: [{ ...segment, summary: "s".repeat(ANALYSIS_LIMITS.summaryChars + 1) }],
          }),
        ),
      ).message,
    ).toContain("summary");
  });

  it("requires between 1 and the limit of segments and the transcript version", () => {
    expect(refused(parseSaveSegmentsRequest(request({ segments: [] }))).message).toContain(
      "non-empty",
    );
    const many = Array.from({ length: ANALYSIS_LIMITS.segments + 1 }, () => segment);
    expect(refused(parseSaveSegmentsRequest(request({ segments: many }))).message).toContain(
      `${ANALYSIS_LIMITS.segments}`,
    );
    const atLimit = Array.from({ length: ANALYSIS_LIMITS.segments }, () => segment);
    expect(
      accepted(parseSaveSegmentsRequest(request({ segments: atLimit }))).segments,
    ).toHaveLength(ANALYSIS_LIMITS.segments);
    expect(
      refused(parseSaveSegmentsRequest(request({ transcriptVersion: undefined }))).message,
    ).toContain("transcriptVersion");
  });
});

describe("parseSaveVisionNotesRequest", () => {
  const note = {
    start: 10,
    end: 14,
    frames: [10.5, 12],
    quality: "poor",
    tags: [" Black ", "SLIDE"],
    finding: "Screen goes dark",
  };
  const request = (patch: Record<string, unknown> = {}) => ({
    source: "a.mp4",
    notes: [note],
    ...patch,
  });

  it("accepts notes and lowercases and trims tags", () => {
    const value = accepted(parseSaveVisionNotesRequest(request()));
    expect(value.notes[0]).toEqual({ ...note, tags: ["black", "slide"] });
  });

  it("requires end after start, times within limits and at most the allowed frames", () => {
    expect(
      refused(parseSaveVisionNotesRequest(request({ notes: [{ ...note, end: 10 }] }))).message,
    ).toContain("end must be after start");
    expect(
      refused(parseSaveVisionNotesRequest(request({ notes: [{ ...note, start: -1 }] }))).message,
    ).toContain("start");
    expect(
      refused(
        parseSaveVisionNotesRequest(
          request({ notes: [{ ...note, end: ANALYSIS_LIMITS.maxTime + 1 }] }),
        ),
      ).message,
    ).toContain("exceeds");
    expect(
      refused(
        parseSaveVisionNotesRequest(
          request({
            notes: [
              {
                ...note,
                frames: Array.from({ length: ANALYSIS_LIMITS.framesPerNote + 1 }, () => 11),
              },
            ],
          }),
        ),
      ).message,
    ).toContain("frames");
    expect(
      accepted(parseSaveVisionNotesRequest(request({ notes: [{ ...note, frames: [] }] }))).notes,
    ).toHaveLength(1);
  });

  it("limits tags and notes and refuses unknown fields and qualities", () => {
    expect(
      refused(
        parseSaveVisionNotesRequest(
          request({
            notes: [{ ...note, tags: Array.from({ length: ANALYSIS_LIMITS.tags + 1 }, () => "x") }],
          }),
        ),
      ).message,
    ).toContain("tags");
    expect(
      refused(parseSaveVisionNotesRequest(request({ notes: [{ ...note, quality: "meh" }] })))
        .message,
    ).toContain("quality");
    expect(
      refused(parseSaveVisionNotesRequest(request({ notes: [{ ...note, id: "v1" }] }))).message,
    ).toContain('unknown field "id"');
    expect(refused(parseSaveVisionNotesRequest(request({ notes: [] }))).message).toContain(
      "non-empty",
    );
    const many = Array.from({ length: ANALYSIS_LIMITS.visionNotes + 1 }, () => note);
    expect(refused(parseSaveVisionNotesRequest(request({ notes: many }))).message).toContain(
      `${ANALYSIS_LIMITS.visionNotes}`,
    );
  });
});

describe("parseFramesRequest", () => {
  it("accepts times and a width in range", () => {
    expect(accepted(parseFramesRequest({ source: "a.mp4", times: [1, 2.5], width: 640 }))).toEqual({
      source: "a.mp4",
      times: [1, 2.5],
      width: 640,
    });
    expect(accepted(parseFramesRequest({ source: "a.mp4", times: [0] }))).toEqual({
      source: "a.mp4",
      times: [0],
    });
  });

  it("refuses no times, too many times, negative times and widths out of range or fractional", () => {
    expect(refused(parseFramesRequest({ source: "a.mp4", times: [] })).message).toContain(
      "at least 1",
    );
    expect(
      refused(
        parseFramesRequest({
          source: "a.mp4",
          times: Array.from({ length: ANALYSIS_LIMITS.framesPerRequest + 1 }, (_, i) => i),
        }),
      ).message,
    ).toContain(`${ANALYSIS_LIMITS.framesPerRequest}`);
    expect(refused(parseFramesRequest({ source: "a.mp4", times: [-1] })).message).toContain(
      "times[0]",
    );
    expect(refused(parseFramesRequest({ source: "a.mp4", times: [Number.NaN] })).message).toContain(
      "times[0]",
    );
    for (const width of [
      ANALYSIS_LIMITS.minFrameWidth - 1,
      ANALYSIS_LIMITS.maxFrameWidth + 1,
      512.5,
    ]) {
      expect(refused(parseFramesRequest({ source: "a.mp4", times: [1], width })).message).toContain(
        "width",
      );
    }
    expect(
      refused(parseFramesRequest({ source: "a.mp4", times: [1], height: 100 })).message,
    ).toContain("height");
  });
});

describe("parseCutPlanRequest", () => {
  it("accepts every option", () => {
    const body = {
      source: "a.mp4",
      label: "pacing pass",
      basedOn: "cut-1",
      order: ["g2", "g1"],
      drop: ["g3"],
      allowDropMust: ["g3"],
      hook: { firstSentence: "s4", lastSentence: "s6" },
      removeIssues: ["t1", "t2"],
      keepIssues: ["t3"],
      removeFillers: false,
      maxPause: 0.5,
      pauseKeep: 0.2,
      targetDuration: 600,
    };
    expect(accepted(parseCutPlanRequest(body))).toEqual(body);
    expect(
      accepted(parseCutPlanRequest({ source: "a.mp4", removeIssues: "auto", hook: null })),
    ).toEqual({
      source: "a.mp4",
      removeIssues: "auto",
      hook: null,
    });
  });

  it("refuses unknown fields and malformed ids, hooks and issue selections", () => {
    expect(refused(parseCutPlanRequest({ source: "a.mp4", speed: 2 })).message).toContain("speed");
    expect(refused(parseCutPlanRequest({ source: "a.mp4", order: "g1" })).message).toContain(
      "order",
    );
    expect(refused(parseCutPlanRequest({ source: "a.mp4", order: [""] })).message).toContain(
      "order[0]",
    );
    expect(
      refused(parseCutPlanRequest({ source: "a.mp4", hook: { firstSentence: "s1" } })).message,
    ).toContain("hook.lastSentence");
    expect(
      refused(
        parseCutPlanRequest({
          source: "a.mp4",
          hook: { firstSentence: "s1", lastSentence: "s2", x: 1 },
        }),
      ).message,
    ).toContain("hook.unknown field");
    expect(
      refused(parseCutPlanRequest({ source: "a.mp4", removeIssues: "everything" })).message,
    ).toContain("removeIssues");
    expect(
      refused(parseCutPlanRequest({ source: "a.mp4", removeFillers: "yes" })).message,
    ).toContain("removeFillers");
  });

  it("limits list sizes", () => {
    const tooMany = Array.from({ length: ANALYSIS_LIMITS.orderEntries + 1 }, (_, i) => `g${i}`);
    expect(refused(parseCutPlanRequest({ source: "a.mp4", order: tooMany })).message).toContain(
      `${ANALYSIS_LIMITS.orderEntries}`,
    );
    const manyIssues = Array.from({ length: ANALYSIS_LIMITS.issueIds + 1 }, (_, i) => `t${i}`);
    expect(
      refused(parseCutPlanRequest({ source: "a.mp4", keepIssues: manyIssues })).message,
    ).toContain(`${ANALYSIS_LIMITS.issueIds}`);
  });

  it("checks pause ranges and the target duration", () => {
    expect(refused(parseCutPlanRequest({ source: "a.mp4", maxPause: 0.05 })).message).toContain(
      "at least 0.1",
    );
    expect(
      refused(parseCutPlanRequest({ source: "a.mp4", maxPause: ANALYSIS_LIMITS.maxPause + 1 }))
        .message,
    ).toContain("maxPause");
    expect(refused(parseCutPlanRequest({ source: "a.mp4", pauseKeep: -0.1 })).message).toContain(
      "pauseKeep",
    );
    expect(
      refused(parseCutPlanRequest({ source: "a.mp4", maxPause: 0.3, pauseKeep: 0.4 })).message,
    ).toContain("must not exceed maxPause");
    expect(
      accepted(parseCutPlanRequest({ source: "a.mp4", maxPause: 0.3, pauseKeep: 0.3 })).pauseKeep,
    ).toBe(0.3);
    expect(refused(parseCutPlanRequest({ source: "a.mp4", targetDuration: 0 })).message).toContain(
      "greater than 0",
    );
    expect(
      refused(parseCutPlanRequest({ source: "a.mp4", targetDuration: "10 min" })).message,
    ).toContain("targetDuration");
  });
});

describe("parseMarkCutAppliedRequest", () => {
  it("needs a composition and a version and nothing else", () => {
    expect(
      accepted(parseMarkCutAppliedRequest({ composition: "index.html", version: "sha256:abc" })),
    ).toEqual({ composition: "index.html", version: "sha256:abc" });
    expect(refused(parseMarkCutAppliedRequest({ composition: "index.html" })).message).toContain(
      "version",
    );
    expect(
      refused(parseMarkCutAppliedRequest({ composition: "index.html", version: "v", extra: 1 }))
        .message,
    ).toContain("extra");
  });
});
