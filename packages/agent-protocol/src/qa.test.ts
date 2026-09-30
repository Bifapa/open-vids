import { describe, expect, it } from "vitest";
import {
  DEFAULT_EXECUTION_QUALITY,
  EXECUTION_BUDGETS,
  applyThinkingPolicy,
  compareQaPass,
  foldChatEvents,
  parseExecutionQuality,
  parseQaCheckRequest,
  parseQaFramesRequest,
  parseQaIssueDraft,
  parseQaReportInput,
  parseUpdateAgentSettings,
  parseUpdateChat,
  qaCounts,
  resolveExecutionBudget,
  type ChatEvent,
  type QaIssue,
  type QaIssueDraft,
  type QaReportInput,
  type TurnQaState,
  type TurnSummary,
} from "./index.js";

const draft = (overrides: Partial<QaIssueDraft> = {}): QaIssueDraft => ({
  kind: "black_frames",
  severity: "error",
  source: "render",
  check: "blackdetect",
  start: 3,
  end: 4,
  clipIds: [],
  subject: null,
  message: "Black picture for 1.0 s",
  fixable: true,
  owner: "editor",
  suggestion: null,
  ...overrides,
});

describe("Execution Quality", () => {
  it("resolves fixed presets to their budgets and clamps a custom one", () => {
    expect(resolveExecutionBudget(DEFAULT_EXECUTION_QUALITY)).toEqual(EXECUTION_BUDGETS.balanced);
    expect(
      resolveExecutionBudget({ preset: "fast", custom: EXECUTION_BUDGETS.best }).qaPasses,
    ).toBe(1);
    const custom = resolveExecutionBudget({
      preset: "custom",
      custom: { ...EXECUTION_BUDGETS.balanced, qaPasses: 9, qaMaxFrames: 1, critiqueRounds: 2.6 },
    });
    expect(custom).toMatchObject({ qaPasses: 5, qaMaxFrames: 4, critiqueRounds: 3 });
  });

  it("scales budgets from Fast to Best", () => {
    const { fast, balanced, best } = EXECUTION_BUDGETS;
    for (const key of [
      "qaPasses",
      "qaFramesPerMinute",
      "qaMaxFrames",
      "critiqueRounds",
      "analysisFramesPerSource",
      "researchCandidates",
    ] as const) {
      expect(fast[key]).toBeLessThanOrEqual(balanced[key]);
      expect(balanced[key]).toBeLessThanOrEqual(best[key]);
    }
    expect(balanced.qaPasses).toBe(2);
  });

  it("applies the specialist thinking policy without touching configured efforts", () => {
    expect(applyThinkingPolicy("high", "economy")).toBe("low");
    expect(applyThinkingPolicy("minimal", "economy")).toBe("minimal");
    expect(applyThinkingPolicy(null, "economy")).toBe("low");
    expect(applyThinkingPolicy("low", "thorough")).toBe("high");
    expect(applyThinkingPolicy("max", "thorough")).toBe("max");
    expect(applyThinkingPolicy("medium", "configured")).toBe("medium");
    expect(applyThinkingPolicy(null, "configured")).toBeNull();
  });

  it("parses the quality on chat and settings updates, rejecting out-of-range budgets", () => {
    expect(parseUpdateChat({ executionQuality: null })).toEqual({
      ok: true,
      value: { executionQuality: null },
    });
    const fast = parseUpdateChat({ executionQuality: { preset: "fast" } });
    expect(fast.ok && fast.value.executionQuality?.custom).toEqual(EXECUTION_BUDGETS.balanced);
    expect(parseExecutionQuality({ preset: "custom" }).ok).toBe(false);
    expect(
      parseUpdateAgentSettings({
        executionQuality: {
          preset: "custom",
          custom: { ...EXECUTION_BUDGETS.best, qaPasses: 6 },
        },
      }),
    ).toEqual({
      ok: false,
      message: "executionQuality.custom.qaPasses must be an integer from 0 to 5",
    });
    expect(
      parseUpdateAgentSettings({
        executionQuality: { preset: "custom", custom: { ...EXECUTION_BUDGETS.fast, qaPasses: 0 } },
      }).ok,
    ).toBe(true);
    expect(parseExecutionQuality({ preset: "ultra" }).ok).toBe(false);
  });
});

describe("compareQaPass", () => {
  it("numbers the first pass's issues as new", () => {
    const { issues, resolved } = compareQaPass({
      pass: 1,
      drafts: [draft(), draft({ kind: "audio_gap", start: 8, end: 10 })],
      previous: [],
      fixedEarlier: [],
    });
    expect(issues.map((issue) => [issue.id, issue.status, issue.firstSeenPass])).toEqual([
      ["p1-1", "new", 1],
      ["p1-2", "new", 1],
    ]);
    expect(resolved).toEqual([]);
  });

  it("tells persisting, fixed, new-after-correction and reappeared issues apart", () => {
    const first = compareQaPass({
      pass: 1,
      drafts: [
        draft(),
        draft({ kind: "frozen_frames", subject: "clip-7", start: 12, end: 15 }),
        draft({ kind: "caption_collision", subject: ".caption", start: 1, end: 2 }),
      ],
      previous: [],
      fixedEarlier: [],
    });
    // Pass 2: the black gap moved a little (still the same problem), the frozen clip was fixed, a new gap appeared.
    const second = compareQaPass({
      pass: 2,
      drafts: [
        draft({ start: 3.3, end: 4.1 }),
        draft({ kind: "caption_collision", subject: ".caption", start: 5, end: 6 }),
        draft({ kind: "audio_gap", start: 20, end: 22 }),
      ],
      previous: first.issues,
      fixedEarlier: [],
    });
    expect(second.issues.map((issue) => [issue.id, issue.status])).toEqual([
      ["p1-1", "persisting"],
      ["p1-3", "persisting"],
      ["p2-1", "new"],
    ]);
    expect(second.resolved.map((issue) => [issue.id, issue.status])).toEqual([["p1-2", "fixed"]]);
    // Pass 3: the frozen clip is back.
    const third = compareQaPass({
      pass: 3,
      drafts: [draft({ kind: "frozen_frames", subject: "clip-7", start: 12, end: 15 })],
      previous: second.issues,
      fixedEarlier: second.resolved,
    });
    expect(third.issues.map((issue) => [issue.id, issue.status, issue.firstSeenPass])).toEqual([
      ["p1-2", "reappeared", 1],
    ]);
    expect(third.resolved.map((issue) => issue.id)).toEqual(["p1-1", "p1-3", "p2-1"]);
    const counts = qaCounts(third.issues, third.resolved);
    expect(counts).toMatchObject({ issues: 1, reappeared: 1, fixed: 3, new: 0, fixable: 1 });
  });

  it("keeps issues of one kind apart when their subjects or times differ", () => {
    const first = compareQaPass({
      pass: 1,
      drafts: [draft({ start: 1, end: 2 }), draft({ start: 30, end: 31 })],
      previous: [],
      fixedEarlier: [],
    });
    const second = compareQaPass({
      pass: 2,
      drafts: [draft({ start: 30.2, end: 31 }), draft({ start: 1, end: 2 })],
      previous: first.issues,
      fixedEarlier: [],
    });
    expect(second.issues.map((issue) => issue.id)).toEqual(["p1-2", "p1-1"]);
    const clipA: QaIssue = {
      ...draft({ subject: "clip-a", start: 1, end: 2 }),
      id: "p1-1",
      status: "new",
      firstSeenPass: 1,
    };
    const subjects = compareQaPass({
      pass: 2,
      drafts: [draft({ subject: "clip-b", start: 1, end: 2 })],
      previous: [clipA],
      fixedEarlier: [],
    });
    expect(subjects.issues[0]?.status).toBe("new");
    expect(subjects.resolved).toHaveLength(1);
  });
});

describe("QA wire parsers", () => {
  it("validates model-written findings and trims their texts", () => {
    const parsed = parseQaIssueDraft({
      ...draft({ source: "vision", check: "vision", kind: "incorrect_broll" }),
      message: `  ${"x".repeat(900)}  `,
      clipIds: ["a", "a", "b"],
      subject: "",
    });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.message).toHaveLength(600);
    expect(parsed.value.clipIds).toEqual(["a", "b"]);
    expect(parsed.value.subject).toBeNull();
    expect(parseQaIssueDraft({ ...draft(), start: 5, end: 4 }).ok).toBe(false);
    expect(parseQaIssueDraft({ ...draft(), owner: "director" }).ok).toBe(false);
    expect(parseQaIssueDraft({ ...draft(), kind: "loudness" }).ok).toBe(false);
  });

  it("only accepts render files and bounded frame requests", () => {
    expect(
      parseQaCheckRequest({ render: "renders/a.mp4", framesPerMinute: 12, maxFrames: 24 }).ok,
    ).toBe(true);
    expect(
      parseQaCheckRequest({ render: "assets/a.mp4", framesPerMinute: 12, maxFrames: 24 }).ok,
    ).toBe(false);
    expect(
      parseQaCheckRequest({ render: "renders/../a.mp4", framesPerMinute: 12, maxFrames: 24 }).ok,
    ).toBe(false);
    expect(parseQaFramesRequest({ render: "renders/a.mp4", times: [1, 2] }).ok).toBe(true);
    expect(
      parseQaFramesRequest({ render: "renders/a.mp4", times: Array.from({ length: 13 }, () => 1) })
        .ok,
    ).toBe(false);
  });

  it("round-trips a report input and rejects a pass beyond its limit", () => {
    const { issues, resolved } = compareQaPass({
      pass: 1,
      drafts: [draft()],
      previous: [],
      fixedEarlier: [],
    });
    const input: QaReportInput = {
      sessionId: "turn-1",
      turnId: "turn-1",
      chatId: "chat-1",
      pass: 1,
      passLimit: 2,
      preset: "balanced",
      composition: "index.html",
      fingerprint: "abc",
      timelineVersion: "sha256:1",
      render: {
        path: "renders/p_1.mp4",
        duration: 12,
        width: 1920,
        height: 1080,
        hasAudio: true,
        quality: "draft",
      },
      renderError: null,
      checks: [{ id: "black_frames", status: "ran", detail: null }],
      vision: {
        status: "unavailable",
        reason: "Vision is not enabled",
        frames: 0,
        rounds: 0,
        model: null,
      },
      issues,
      resolved,
      previousReportId: null,
    };
    expect(parseQaReportInput(JSON.parse(JSON.stringify(input)))).toEqual({
      ok: true,
      value: input,
    });
    expect(parseQaReportInput({ ...input, pass: 3 }).ok).toBe(false);
    expect(parseQaReportInput({ ...input, passLimit: 0 }).ok).toBe(false);
  });
});

describe("turn QA state in the chat log", () => {
  const turn: TurnSummary = {
    id: "t1",
    chatId: "c1",
    status: "running",
    startedAt: 1,
    promptMessageId: "m1",
    assistantMessageId: "m2",
    model: null,
    thinking: null,
    checkpoint: null,
  };
  const running: TurnQaState = {
    status: "running",
    preset: "balanced",
    passLimit: 2,
    reason: null,
    passes: [
      {
        pass: 1,
        phase: "done",
        reportId: "qa-1",
        renderPath: "renders/a.mp4",
        counts: null,
        vision: "ran",
        error: null,
        startedAt: 2,
      },
      {
        pass: 2,
        phase: "rendering",
        reportId: null,
        renderPath: null,
        counts: null,
        vision: null,
        error: null,
        startedAt: 3,
      },
    ],
  };

  function fold(end: Omit<ChatEvent, "seq" | "chatId" | "ts">) {
    const events: Omit<ChatEvent, "seq" | "chatId" | "ts">[] = [
      {
        type: "chat.created",
        chat: {
          id: "c1",
          projectId: "p",
          title: "Chat",
          createdAt: 1,
          updatedAt: 1,
          status: "idle",
          lastTaskSummary: null,
          activeMode: "normal",
          mainAgentModel: null,
          thinking: null,
          enabledAgents: [],
        },
      },
      {
        type: "turn.started",
        turn,
        promptMessage: {
          id: "m1",
          chatId: "c1",
          turnId: "t1",
          createdAt: 1,
          role: "user",
          steering: false,
          parts: [],
        },
        assistantMessage: {
          id: "m2",
          chatId: "c1",
          turnId: "t1",
          createdAt: 1,
          role: "assistant",
          parts: [],
          status: "streaming",
          model: null,
        },
      },
      { type: "qa.updated", turnId: "t1", qa: running },
      end,
    ];
    return foldChatEvents(
      events.map((event, index) => ({ ...event, seq: index + 1, chatId: "c1", ts: index })),
    );
  }

  it("keeps the QA state through a terminal event that does not repeat it", () => {
    const passed: TurnQaState = { ...running, status: "passed" };
    const state = fold({
      type: "turn.completed",
      turn: { ...turn, status: "completed", qa: passed },
    });
    expect(state?.turns[0]?.qa?.status).toBe("passed");
  });

  it("settles a QA session left running when the turn ends", () => {
    const state = fold({ type: "turn.aborted", turn: { ...turn, status: "interrupted" } });
    const qa = state?.turns[0]?.qa;
    expect(qa?.status).toBe("aborted");
    expect(qa?.passes.map((pass) => pass.phase)).toEqual(["done", "aborted"]);
  });
});
