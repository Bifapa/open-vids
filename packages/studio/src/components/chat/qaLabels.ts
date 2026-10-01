import {
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
import { t, type TranslationKey } from "../../i18n";
import { AGENT_NAME_KEYS } from "./agentLabels";

// ── Execution Quality ────────────────────────────────────────────────────────

export const EXECUTION_PRESET_LABELS: Record<ExecutionQualityPreset, TranslationKey> = {
  fast: "chat.quality.preset.fast",
  balanced: "chat.quality.preset.balanced",
  best: "chat.quality.preset.best",
  custom: "chat.quality.preset.custom",
};

/** What choosing a fixed preset is for, short enough to sit beside its name; the numbers come from `describeBudget`. */
export const EXECUTION_PRESET_BLURBS: Record<FixedExecutionQualityPreset, TranslationKey> = {
  fast: "chat.quality.blurb.fast",
  balanced: "chat.quality.blurb.balanced",
  best: "chat.quality.blurb.best",
};

export const THINKING_POLICY_LABELS: Record<SpecialistThinkingPolicy, TranslationKey> = {
  economy: "chat.quality.thinking.economy",
  configured: "chat.quality.thinking.configured",
  thorough: "chat.quality.thinking.thorough",
};

export const THINKING_POLICY_HINTS: Record<SpecialistThinkingPolicy, TranslationKey> = {
  economy: "chat.quality.thinking.economyHint",
  configured: "chat.quality.thinking.configuredHint",
  thorough: "chat.quality.thinking.thoroughHint",
};

const THINKING_POLICY_PHRASES: Record<SpecialistThinkingPolicy, TranslationKey> = {
  economy: "chat.quality.thinking.economyPhrase",
  configured: "chat.quality.thinking.configuredPhrase",
  thorough: "chat.quality.thinking.thoroughPhrase",
};

type NumericBudgetField = Exclude<keyof ExecutionBudget, "specialistThinking">;

/** Every numeric budget field in the order the editor shows them, render QA passes first. */
export const BUDGET_FIELDS: readonly {
  field: NumericBudgetField;
  label: TranslationKey;
  hint: TranslationKey;
}[] = [
  {
    field: "qaPasses",
    label: "chat.quality.field.qaPasses",
    hint: "chat.quality.field.qaPassesHint",
  },
  {
    field: "qaFramesPerMinute",
    label: "chat.quality.field.framesPerMinute",
    hint: "chat.quality.field.framesPerMinuteHint",
  },
  {
    field: "qaMaxFrames",
    label: "chat.quality.field.framesPerPass",
    hint: "chat.quality.field.framesPerPassHint",
  },
  {
    field: "critiqueRounds",
    label: "chat.quality.field.critiqueRounds",
    hint: "chat.quality.field.critiqueRoundsHint",
  },
  {
    field: "analysisFramesPerSource",
    label: "chat.quality.field.analysisFrames",
    hint: "chat.quality.field.analysisFramesHint",
  },
  {
    field: "researchCandidates",
    label: "chat.quality.field.researchCandidates",
    hint: "chat.quality.field.researchCandidatesHint",
  },
];

/** "2 render QA passes · Vision 12 frames/min, max 24 · 2 critique rounds · 8 research candidates · …". */
export function describeBudget(budget: ExecutionBudget): string {
  const parts: string[] = [];
  if (budget.qaPasses === 0) {
    parts.push(t("chat.quality.summary.qaOff"));
  } else {
    parts.push(t("chat.quality.summary.passes", { count: budget.qaPasses }));
    parts.push(
      t("chat.quality.summary.vision", {
        perMinute: budget.qaFramesPerMinute,
        max: budget.qaMaxFrames,
      }),
    );
    parts.push(t("chat.quality.summary.critique", { count: budget.critiqueRounds }));
  }
  parts.push(t("chat.quality.summary.research", { count: budget.researchCandidates }));
  parts.push(t(THINKING_POLICY_PHRASES[budget.specialistThinking]));
  return parts.join(" · ");
}

// ── Render QA ────────────────────────────────────────────────────────────────

export const TURN_QA_STATUS_LABELS: Record<TurnQaStatus, TranslationKey> = {
  running: "chat.qa.status.running",
  passed: "chat.qa.status.passed",
  issues_remain: "chat.qa.status.issuesRemain",
  skipped: "chat.qa.status.skipped",
  failed: "chat.qa.status.failed",
  aborted: "chat.qa.status.aborted",
};

export const QA_PASS_PHASE_LABELS: Record<QaPassPhase, TranslationKey> = {
  rendering: "chat.qa.phase.rendering",
  checking: "chat.qa.phase.checking",
  reviewing: "chat.qa.phase.reviewing",
  done: "chat.qa.phase.done",
  correcting: "chat.qa.phase.correcting",
  corrected: "chat.qa.phase.corrected",
  failed: "chat.qa.phase.failed",
  aborted: "chat.qa.phase.aborted",
};

/** Phases where something is still happening in the pass. */
export function isLivePassPhase(phase: QaPassPhase): boolean {
  return (
    phase === "rendering" || phase === "checking" || phase === "reviewing" || phase === "correcting"
  );
}

export const QA_VISION_STATUS_LABELS: Record<QaVisionStatus, TranslationKey> = {
  ran: "chat.qa.vision.ran",
  unavailable: "chat.qa.vision.unavailable",
  failed: "chat.qa.vision.failed",
  skipped: "chat.qa.vision.skipped",
};

export const QA_ISSUE_KIND_LABELS: Record<QaIssueKind, TranslationKey> = {
  black_frames: "chat.qa.kind.blackFrames",
  frozen_frames: "chat.qa.kind.frozenFrames",
  awkward_cut: "chat.qa.kind.awkwardCut",
  caption_collision: "chat.qa.kind.captionCollision",
  layout_overlap: "chat.qa.kind.layoutOverlap",
  out_of_bounds: "chat.qa.kind.outOfBounds",
  visual_mismatch: "chat.qa.kind.visualMismatch",
  missing_broll: "chat.qa.kind.missingBroll",
  incorrect_broll: "chat.qa.kind.incorrectBroll",
  audio_gap: "chat.qa.kind.audioGap",
  render_failed: "chat.qa.kind.renderFailed",
  other: "chat.qa.kind.other",
};

export const QA_SEVERITY_LABELS: Record<QaSeverity, TranslationKey> = {
  error: "chat.qa.severity.error",
  warning: "chat.qa.severity.warning",
  info: "chat.qa.severity.info",
};

export const QA_ISSUE_STATUS_LABELS: Record<QaIssueStatus, TranslationKey> = {
  new: "chat.qa.issueStatus.new",
  persisting: "chat.qa.issueStatus.persisting",
  reappeared: "chat.qa.issueStatus.reappeared",
  fixed: "chat.qa.issueStatus.fixed",
};

/** Which check found an issue: the three deterministic ones, or Vision. */
export const QA_SOURCE_LABELS: Record<QaIssueSource, TranslationKey> = {
  render: "chat.qa.source.render",
  timeline: "chat.qa.check.timeline",
  layout: "chat.qa.check.layout",
  vision: "chat.qa.source.vision",
};

export const QA_OWNER_LABELS: Record<QaOwner, TranslationKey> = {
  editor: AGENT_NAME_KEYS.editor,
  motion: AGENT_NAME_KEYS.motion,
  audio: AGENT_NAME_KEYS.audio,
  research: AGENT_NAME_KEYS.research,
};

export const QA_CHECK_LABELS: Record<QaCheckId, TranslationKey> = {
  render: "chat.qa.check.render",
  black_frames: "chat.qa.check.blackFrames",
  frozen_frames: "chat.qa.check.frozenFrames",
  audio: "chat.qa.check.audio",
  timeline: "chat.qa.check.timeline",
  layout: "chat.qa.check.layout",
  vision: "chat.qa.check.vision",
};

export const QA_CHECK_STATUS_LABELS: Record<QaCheckStatus, TranslationKey> = {
  ran: "chat.qa.checkStatus.ran",
  skipped: "chat.qa.checkStatus.skipped",
  unavailable: "chat.qa.checkStatus.unavailable",
  failed: "chat.qa.checkStatus.failed",
};

/** A pass's counts in reading order; zero counts other than open issues are left out. */
export function describeQaCounts(counts: QaCounts): { key: keyof QaCounts; text: string }[] {
  const parts: { key: keyof QaCounts; text: string }[] = [
    { key: "issues", text: t("chat.qa.count.issues", { count: counts.issues }) },
  ];
  const extra: [keyof QaCounts, TranslationKey][] = [
    ["fixed", "chat.qa.count.fixed"],
    ["new", "chat.qa.count.new"],
    ["persisting", "chat.qa.count.persisting"],
    ["reappeared", "chat.qa.count.reappeared"],
  ];
  for (const [key, message] of extra) {
    if (counts[key] > 0) parts.push({ key, text: t(message, { count: counts[key] }) });
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
