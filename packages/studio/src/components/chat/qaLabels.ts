import {
  AGENT_DISPLAY_NAMES,
  type ExecutionBudget,
  type ExecutionQualityPreset,
  type FixedExecutionQualityPreset,
  type QaCheckId,
  type QaCheckStatus,
  type QaCounts,
  type QaIssueKind,
  type QaIssueSource,
  type QaIssueStatus,
  type QaOwner,
  type QaPassPhase,
  type QaSeverity,
  type QaVisionStatus,
  type SpecialistThinkingPolicy,
  type TurnQaStatus,
} from "@hyperframes/agent-protocol";

// ── Execution Quality ────────────────────────────────────────────────────────

export const EXECUTION_PRESET_LABELS: Record<ExecutionQualityPreset, string> = {
  fast: "Fast",
  balanced: "Balanced",
  best: "Best",
  custom: "Custom",
};

/** What choosing a fixed preset is for, short enough to sit beside its name; the numbers come from `describeBudget`. */
export const EXECUTION_PRESET_BLURBS: Record<FixedExecutionQualityPreset, string> = {
  fast: "quickest, a light check",
  balanced: "checks and corrects once",
  best: "most thorough, slowest",
};

export const THINKING_POLICY_LABELS: Record<SpecialistThinkingPolicy, string> = {
  economy: "Economy",
  configured: "As configured",
  thorough: "Thorough",
};

export const THINKING_POLICY_HINTS: Record<SpecialistThinkingPolicy, string> = {
  economy: "Specialists think at most Low.",
  configured: "Specialists think as you configured them.",
  thorough: "Specialists think at least High.",
};

const THINKING_POLICY_PHRASES: Record<SpecialistThinkingPolicy, string> = {
  economy: "light specialist thinking",
  configured: "specialist thinking as configured",
  thorough: "deep specialist thinking",
};

type NumericBudgetField = Exclude<keyof ExecutionBudget, "specialistThinking">;

/** Every numeric budget field in the order the editor shows them, render QA passes first. */
export const BUDGET_FIELDS: readonly { field: NumericBudgetField; label: string; hint: string }[] =
  [
    {
      field: "qaPasses",
      label: "Render QA passes",
      hint: "Renders checked per turn, with a correction between passes. 0 turns QA off.",
    },
    {
      field: "qaFramesPerMinute",
      label: "Vision frames per minute",
      hint: "How densely Vision samples the rendered video.",
    },
    {
      field: "qaMaxFrames",
      label: "Vision frames per pass",
      hint: "The most frames Vision looks at in one pass.",
    },
    {
      field: "critiqueRounds",
      label: "Critique rounds",
      hint: "How often Vision may ask for a closer look in one pass.",
    },
    {
      field: "analysisFramesPerSource",
      label: "Analysis frames per source",
      hint: "Frames Vision inspects per source file when analysing long footage.",
    },
    {
      field: "researchCandidates",
      label: "Research candidates",
      hint: "Candidates Research compares per search.",
    },
  ];

const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;

/** "2 render QA passes · Vision 12 frames/min, max 24 · 2 critique rounds · 8 research candidates · …". */
export function describeBudget(budget: ExecutionBudget): string {
  const parts: string[] = [];
  if (budget.qaPasses === 0) {
    parts.push("Render QA off");
  } else {
    parts.push(plural(budget.qaPasses, "render QA pass", "render QA passes"));
    parts.push(`Vision ${budget.qaFramesPerMinute} frames/min, max ${budget.qaMaxFrames}`);
    parts.push(plural(budget.critiqueRounds, "critique round", "critique rounds"));
  }
  parts.push(plural(budget.researchCandidates, "research candidate", "research candidates"));
  parts.push(THINKING_POLICY_PHRASES[budget.specialistThinking]);
  return parts.join(" · ");
}

// ── Render QA ────────────────────────────────────────────────────────────────

export const TURN_QA_STATUS_LABELS: Record<TurnQaStatus, string> = {
  running: "Checking",
  passed: "Passed",
  issues_remain: "Issues remain",
  skipped: "Skipped",
  failed: "Failed",
  aborted: "Stopped",
};

export const QA_PASS_PHASE_LABELS: Record<QaPassPhase, string> = {
  rendering: "Rendering",
  checking: "Running checks",
  reviewing: "Vision review",
  done: "Checked",
  correcting: "Correcting",
  corrected: "Corrected",
  failed: "Failed",
  aborted: "Stopped",
};

/** Phases where something is still happening in the pass. */
export function isLivePassPhase(phase: QaPassPhase): boolean {
  return (
    phase === "rendering" || phase === "checking" || phase === "reviewing" || phase === "correcting"
  );
}

export const QA_VISION_STATUS_LABELS: Record<QaVisionStatus, string> = {
  ran: "Vision reviewed",
  unavailable: "Vision unavailable",
  failed: "Vision failed",
  skipped: "Vision skipped",
};

export const QA_ISSUE_KIND_LABELS: Record<QaIssueKind, string> = {
  black_frames: "Black frames",
  frozen_frames: "Frozen picture",
  awkward_cut: "Awkward cut",
  caption_collision: "Caption collision",
  layout_overlap: "Overlapping layout",
  out_of_bounds: "Out of frame",
  visual_mismatch: "Visual mismatch",
  missing_broll: "Missing B-roll",
  incorrect_broll: "Wrong B-roll",
  audio_gap: "Audio gap",
  render_failed: "Render failed",
  other: "Other",
};

export const QA_SEVERITY_LABELS: Record<QaSeverity, string> = {
  error: "Error",
  warning: "Warning",
  info: "Info",
};

export const QA_ISSUE_STATUS_LABELS: Record<QaIssueStatus, string> = {
  new: "New",
  persisting: "Persisting",
  reappeared: "Reappeared",
  fixed: "Fixed",
};

/** Which check found an issue: the three deterministic ones, or Vision. */
export const QA_SOURCE_LABELS: Record<QaIssueSource, string> = {
  render: "Render check",
  timeline: "Timeline check",
  layout: "Layout check",
  vision: "Vision",
};

export const QA_OWNER_LABELS: Record<QaOwner, string> = {
  editor: AGENT_DISPLAY_NAMES.editor,
  motion: AGENT_DISPLAY_NAMES.motion,
  audio: AGENT_DISPLAY_NAMES.audio,
  research: AGENT_DISPLAY_NAMES.research,
};

export const QA_CHECK_LABELS: Record<QaCheckId, string> = {
  render: "Render",
  black_frames: "Black frames check",
  frozen_frames: "Frozen picture check",
  audio: "Audio check",
  timeline: "Timeline check",
  layout: "Layout check",
  vision: "Vision review",
};

export const QA_CHECK_STATUS_LABELS: Record<QaCheckStatus, string> = {
  ran: "ran",
  skipped: "skipped",
  unavailable: "unavailable",
  failed: "failed",
};

/** A pass's counts in reading order; zero counts other than open issues are left out. */
export function describeQaCounts(counts: QaCounts): { key: keyof QaCounts; text: string }[] {
  const parts: { key: keyof QaCounts; text: string }[] = [
    { key: "issues", text: plural(counts.issues, "open issue", "open issues") },
  ];
  const extra: [keyof QaCounts, string][] = [
    ["fixed", "fixed"],
    ["new", "new"],
    ["persisting", "persisting"],
    ["reappeared", "reappeared"],
  ];
  for (const [key, word] of extra) {
    if (counts[key] > 0) parts.push({ key, text: `${counts[key]} ${word}` });
  }
  return parts;
}

/** `mm:ss.s` of the rendered video. */
export function formatQaTime(seconds: number): string {
  const tenths = Math.round(Math.max(0, seconds) * 10);
  const minutes = Math.floor(tenths / 600);
  const rest = (tenths - minutes * 600) / 10;
  return `${String(minutes).padStart(2, "0")}:${rest.toFixed(1).padStart(4, "0")}`;
}

export function formatQaRange(start: number, end: number): string {
  const from = formatQaTime(start);
  const to = formatQaTime(end);
  return from === to ? from : `${from}–${to}`;
}
