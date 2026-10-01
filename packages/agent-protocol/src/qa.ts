/**
 * OpenVids Autonomous Render QA and Execution Quality: the product-level contract between the Studio server's QA
 * service (`/api/projects/:id/qa/*`), the agent runtime's QA loop and Studio's chat UI.
 *
 * QA inspects a RENDERED file, not the timeline alone: deterministic checks (black and frozen picture and audio gaps
 * measured on the render, timeline facts such as flash clips, gaps, clips past their media and missing files, and the
 * layout of text/captions in the composition at sampled times) plus Vision's review of frames of the render. Nothing
 * here names a model provider or a harness: issues are OpenVids concepts with timeline times (seconds of the rendered
 * composition), clip ids and an owning specialist.
 *
 * A turn's QA session is a bounded loop: pass 1 renders and checks, and while fixable issues remain and passes are
 * left, the Director delegates a correction and the next pass re-renders and re-checks. `qaPasses` is the number of
 * render + check passes (0 = autonomous QA off), so a turn makes at most `qaPasses − 1` corrections and every
 * correction is verified by a new render.
 *
 * Reports are durable artifacts in `<project>/.hyperframes/qa/reports/` (outside project history). A report records
 * the project fingerprint it was rendered from; whether it still describes the project is derived from the current
 * fingerprint (`current`), so a reverted correction never leaves a report claiming the corrected state.
 *
 * Routes (all JSON; errors are `{ error: QaError }`):
 *   GET  …/qa/state                        → QaStateResponse
 *   POST …/qa/check        QaCheckRequest  → QaCheckResponse
 *   POST …/qa/frames       QaFramesRequest → { frames: FrameImage[] }
 *   POST …/qa/reports      QaReportInput   → QaReport
 *   GET  …/qa/reports                      → QaReportList
 *   GET  …/qa/reports/:id                  → QaReport
 */

import type { FrameImage } from "./analysis.js";
import { THINKING_EFFORTS, type CodedMessageParams, type ThinkingEffort } from "./types.js";
import { isRecord, readErrorParams, type Parsed } from "./validate.js";

const fail = (message: string): { ok: false; message: string } => ({ ok: false, message });

function finite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

// ── Execution Quality ────────────────────────────────────────────────────────

export const EXECUTION_QUALITY_PRESETS = ["fast", "balanced", "best", "custom"] as const;
export type ExecutionQualityPreset = (typeof EXECUTION_QUALITY_PRESETS)[number];
export type FixedExecutionQualityPreset = Exclude<ExecutionQualityPreset, "custom">;

/**
 * How specialists' thinking follows their configuration for a turn: `economy` caps it at `low`, `configured` uses it
 * as set, `thorough` raises it to at least `high`.
 */
export const SPECIALIST_THINKING_POLICIES = ["economy", "configured", "thorough"] as const;
export type SpecialistThinkingPolicy = (typeof SPECIALIST_THINKING_POLICIES)[number];

/** The orchestration budget of a turn. Every field is enforced by the runtime, not only suggested to a model. */
export interface ExecutionBudget {
  /** Render + check passes of autonomous QA (0 = off). Corrections between passes: at most `qaPasses − 1`. */
  qaPasses: number;
  /** Frames per minute of rendered output Vision looks at in one QA pass (before `qaMaxFrames`). */
  qaFramesPerMinute: number;
  /** Most frames Vision looks at in one QA pass. */
  qaMaxFrames: number;
  /** Critique rounds per QA pass: how many times Vision may request frames (a first look plus closer looks). */
  critiqueRounds: number;
  /** Most frames Vision inspects per source during long-form analysis in one turn. */
  analysisFramesPerSource: number;
  /** Most candidates Research compares per search. */
  researchCandidates: number;
  specialistThinking: SpecialistThinkingPolicy;
}

type NumericBudgetField = Exclude<keyof ExecutionBudget, "specialistThinking">;

export const EXECUTION_BUDGET_RANGES: Readonly<
  Record<NumericBudgetField, { min: number; max: number }>
> = {
  qaPasses: { min: 0, max: 5 },
  qaFramesPerMinute: { min: 2, max: 60 },
  qaMaxFrames: { min: 4, max: 96 },
  critiqueRounds: { min: 1, max: 4 },
  analysisFramesPerSource: { min: 8, max: 120 },
  researchCandidates: { min: 2, max: 24 },
};

export const EXECUTION_BUDGETS: Readonly<Record<FixedExecutionQualityPreset, ExecutionBudget>> = {
  fast: {
    qaPasses: 1,
    qaFramesPerMinute: 6,
    qaMaxFrames: 12,
    critiqueRounds: 1,
    analysisFramesPerSource: 16,
    researchCandidates: 4,
    specialistThinking: "economy",
  },
  balanced: {
    qaPasses: 2,
    qaFramesPerMinute: 12,
    qaMaxFrames: 24,
    critiqueRounds: 2,
    analysisFramesPerSource: 40,
    researchCandidates: 8,
    specialistThinking: "configured",
  },
  best: {
    qaPasses: 3,
    qaFramesPerMinute: 24,
    qaMaxFrames: 48,
    critiqueRounds: 3,
    analysisFramesPerSource: 80,
    researchCandidates: 16,
    specialistThinking: "thorough",
  },
};

/**
 * A chat's (or the global default's) Execution Quality. `custom` is kept while a fixed preset is selected, so
 * switching back to Custom restores the user's own budget.
 */
export interface ExecutionQuality {
  preset: ExecutionQualityPreset;
  custom: ExecutionBudget;
}

export const DEFAULT_EXECUTION_QUALITY: ExecutionQuality = {
  preset: "balanced",
  custom: { ...EXECUTION_BUDGETS.balanced },
};

export function clampExecutionBudget(budget: ExecutionBudget): ExecutionBudget {
  const clamp = (field: NumericBudgetField) => {
    const { min, max } = EXECUTION_BUDGET_RANGES[field];
    return Math.min(max, Math.max(min, Math.round(budget[field])));
  };
  return {
    qaPasses: clamp("qaPasses"),
    qaFramesPerMinute: clamp("qaFramesPerMinute"),
    qaMaxFrames: clamp("qaMaxFrames"),
    critiqueRounds: clamp("critiqueRounds"),
    analysisFramesPerSource: clamp("analysisFramesPerSource"),
    researchCandidates: clamp("researchCandidates"),
    specialistThinking: budget.specialistThinking,
  };
}

/** The budget a turn runs with. */
export function resolveExecutionBudget(quality: ExecutionQuality): ExecutionBudget {
  if (quality.preset === "custom") return clampExecutionBudget(quality.custom);
  return { ...EXECUTION_BUDGETS[quality.preset] };
}

/** A specialist's thinking effort under the turn's policy (`null` = the model's default, left alone). */
export function applyThinkingPolicy(
  thinking: ThinkingEffort | null,
  policy: SpecialistThinkingPolicy,
): ThinkingEffort | null {
  if (policy === "configured") return thinking;
  const rank = (effort: ThinkingEffort) => THINKING_EFFORTS.indexOf(effort);
  if (policy === "economy") {
    if (thinking === null) return "low";
    return rank(thinking) > rank("low") ? "low" : thinking;
  }
  if (thinking === null) return "high";
  return rank(thinking) < rank("high") ? "high" : thinking;
}

export function parseExecutionBudget(value: unknown, field = "custom"): Parsed<ExecutionBudget> {
  if (!isRecord(value)) return fail(`${field} must be an object`);
  const numbers: Partial<Record<NumericBudgetField, number>> = {};
  for (const key of Object.keys(EXECUTION_BUDGET_RANGES) as NumericBudgetField[]) {
    const raw = value[key];
    const { min, max } = EXECUTION_BUDGET_RANGES[key];
    if (!finite(raw) || !Number.isInteger(raw) || raw < min || raw > max)
      return fail(`${field}.${key} must be an integer from ${min} to ${max}`);
    numbers[key] = raw;
  }
  const policy = SPECIALIST_THINKING_POLICIES.find((known) => known === value.specialistThinking);
  if (!policy)
    return fail(
      `${field}.specialistThinking must be one of: ${SPECIALIST_THINKING_POLICIES.join(", ")}`,
    );
  return {
    ok: true,
    value: {
      qaPasses: numbers.qaPasses ?? 0,
      qaFramesPerMinute: numbers.qaFramesPerMinute ?? 0,
      qaMaxFrames: numbers.qaMaxFrames ?? 0,
      critiqueRounds: numbers.critiqueRounds ?? 0,
      analysisFramesPerSource: numbers.analysisFramesPerSource ?? 0,
      researchCandidates: numbers.researchCandidates ?? 0,
      specialistThinking: policy,
    },
  };
}

/** `{preset, custom?}`; a missing `custom` keeps the Balanced budget as the custom starting point. */
export function parseExecutionQuality(
  value: unknown,
  field = "executionQuality",
): Parsed<ExecutionQuality> {
  if (!isRecord(value)) return fail(`${field} must be an object`);
  const preset = EXECUTION_QUALITY_PRESETS.find((known) => known === value.preset);
  if (!preset)
    return fail(`${field}.preset must be one of: ${EXECUTION_QUALITY_PRESETS.join(", ")}`);
  if (value.custom === undefined) {
    if (preset === "custom") return fail(`${field}.custom is required for the custom preset`);
    return { ok: true, value: { preset, custom: { ...EXECUTION_BUDGETS.balanced } } };
  }
  const custom = parseExecutionBudget(value.custom, `${field}.custom`);
  if (!custom.ok) return custom;
  return { ok: true, value: { preset, custom: custom.value } };
}

// ── Issues ───────────────────────────────────────────────────────────────────

export const QA_ISSUE_KINDS = [
  /** Black picture (render). */
  "black_frames",
  /** Picture stuck on one frame where video should play (render + timeline). */
  "frozen_frames",
  /** Flash clips, micro gaps, cuts inside a word, jarring jumps. */
  "awkward_cut",
  /** A caption overlapping other text or graphics. */
  "caption_collision",
  /** Titles, text or graphics (not captions) overlapping each other. */
  "layout_overlap",
  /** Text, captions or graphics outside the frame or clipped. */
  "out_of_bounds",
  /** What is on screen contradicts what is said or intended. */
  "visual_mismatch",
  /** B-roll that should be there is missing (missing file, unresolved material, empty overlay). */
  "missing_broll",
  /** B-roll that is there but shows the wrong thing. */
  "incorrect_broll",
  /** Suspicious silence or a missing audio stream where the timeline has sound. */
  "audio_gap",
  /** The render itself failed. */
  "render_failed",
  "other",
] as const;
export type QaIssueKind = (typeof QA_ISSUE_KINDS)[number];

export const QA_SEVERITIES = ["error", "warning", "info"] as const;
export type QaSeverity = (typeof QA_SEVERITIES)[number];

/** Which check found an issue: measured on the render, derived from the timeline, the composition's layout, or Vision. */
export const QA_ISSUE_SOURCES = ["render", "timeline", "layout", "vision"] as const;
export type QaIssueSource = (typeof QA_ISSUE_SOURCES)[number];

export function isDeterministicSource(source: QaIssueSource): boolean {
  return source !== "vision";
}

/** The specialist who should correct an issue. */
export const QA_OWNERS = ["editor", "motion", "audio", "research"] as const;
export type QaOwner = (typeof QA_OWNERS)[number];

/**
 * Compared with the previous pass of the same session: `new` (first seen now), `persisting` (seen before, still
 * there), `reappeared` (fixed in an earlier pass, back now), `fixed` (seen before, gone now; only in `resolved`).
 */
export const QA_ISSUE_STATUSES = ["new", "persisting", "reappeared", "fixed"] as const;
export type QaIssueStatus = (typeof QA_ISSUE_STATUSES)[number];

/** An issue as a check reports it, before it is compared with earlier passes. */
export interface QaIssueDraft {
  kind: QaIssueKind;
  severity: QaSeverity;
  source: QaIssueSource;
  /** The check that found it (`blackdetect`, `timeline.flash_clip`, `layout.content_overlap`, `vision`, …). */
  check: string;
  /** Seconds of the rendered composition. */
  start: number;
  end: number;
  /** Timeline clips involved (`data-hf-id`). */
  clipIds: string[];
  /**
   * What the issue is about, stable across passes when the thing itself is (a clip id, a caption selector, an asset
   * path); null when only its time identifies it.
   */
  subject: string | null;
  message: string;
  /** The correction loop should try to fix it. */
  fixable: boolean;
  owner: QaOwner | null;
  suggestion: string | null;
}

export interface QaIssue extends QaIssueDraft {
  /** `p<pass>-<n>` when first seen; kept while the issue persists or reappears. */
  id: string;
  status: QaIssueStatus;
  /** The pass that first saw it. */
  firstSeenPass: number;
}

export const QA_LIMITS = {
  issues: 200,
  messageChars: 600,
  suggestionChars: 400,
  checkChars: 80,
  subjectChars: 300,
  clipIds: 32,
  framesPerRequest: 12,
  samples: 120,
  contextChars: 400,
} as const;

/** Issues farther apart in time than this are different issues, whatever their kind. */
const MATCH_TOLERANCE_SECONDS = 0.75;

function overlaps(a: QaIssueDraft, b: QaIssueDraft): boolean {
  return a.start <= b.end + MATCH_TOLERANCE_SECONDS && b.start <= a.end + MATCH_TOLERANCE_SECONDS;
}

/** The same problem in two passes: same kind, and the same subject when both name one, else overlapping times. */
export function sameQaIssue(a: QaIssueDraft, b: QaIssueDraft): boolean {
  if (a.kind !== b.kind) return false;
  if (a.subject !== null && b.subject !== null) return a.subject === b.subject;
  return overlaps(a, b);
}

/**
 * Compares a pass's findings with the session's history. `previous`: the issues open after the previous pass;
 * `fixedEarlier`: issues fixed in any earlier pass (to recognize reappearing ones). Each previous issue matches at
 * most one finding.
 */
export function compareQaPass(input: {
  pass: number;
  drafts: readonly QaIssueDraft[];
  previous: readonly QaIssue[];
  fixedEarlier: readonly QaIssue[];
}): { issues: QaIssue[]; resolved: QaIssue[] } {
  const unmatched = [...input.previous];
  const revived = [...input.fixedEarlier];
  const issues: QaIssue[] = [];
  let counter = 0;
  for (const draft of input.drafts) {
    const prior = unmatched.findIndex((issue) => sameQaIssue(issue, draft));
    if (prior >= 0) {
      const [match] = unmatched.splice(prior, 1);
      if (match) {
        issues.push({
          ...draft,
          id: match.id,
          status: "persisting",
          firstSeenPass: match.firstSeenPass,
        });
        continue;
      }
    }
    const back = revived.findIndex((issue) => sameQaIssue(issue, draft));
    if (back >= 0) {
      const [match] = revived.splice(back, 1);
      if (match) {
        issues.push({
          ...draft,
          id: match.id,
          status: "reappeared",
          firstSeenPass: match.firstSeenPass,
        });
        continue;
      }
    }
    counter += 1;
    issues.push({
      ...draft,
      id: `p${input.pass}-${counter}`,
      status: "new",
      firstSeenPass: input.pass,
    });
  }
  const resolved = unmatched.map((issue): QaIssue => ({ ...issue, status: "fixed" }));
  return { issues, resolved };
}

export interface QaCounts {
  /** Open issues after the pass. */
  issues: number;
  errors: number;
  warnings: number;
  fixable: number;
  new: number;
  persisting: number;
  reappeared: number;
  /** Issues of the previous pass that are gone. */
  fixed: number;
}

export function qaCounts(issues: readonly QaIssue[], resolved: readonly QaIssue[]): QaCounts {
  const count = (predicate: (issue: QaIssue) => boolean) => issues.filter(predicate).length;
  return {
    issues: issues.length,
    errors: count((issue) => issue.severity === "error"),
    warnings: count((issue) => issue.severity === "warning"),
    fixable: count((issue) => issue.fixable),
    new: count((issue) => issue.status === "new"),
    persisting: count((issue) => issue.status === "persisting"),
    reappeared: count((issue) => issue.status === "reappeared"),
    fixed: resolved.length,
  };
}

function boundedText(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  const text = value.replace(/\s+/g, " ").trim();
  if (!text) return null;
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
}

/**
 * Validates one issue from the wire or from a model (Vision's findings). Texts are trimmed to their limits; times must
 * be finite with `end ≥ start ≥ 0`.
 */
export function parseQaIssueDraft(value: unknown, field = "issue"): Parsed<QaIssueDraft> {
  if (!isRecord(value)) return fail(`${field} must be an object`);
  const kind = QA_ISSUE_KINDS.find((known) => known === value.kind);
  if (!kind) return fail(`${field}.kind must be one of: ${QA_ISSUE_KINDS.join(", ")}`);
  const severity = QA_SEVERITIES.find((known) => known === value.severity);
  if (!severity) return fail(`${field}.severity must be one of: ${QA_SEVERITIES.join(", ")}`);
  const source = QA_ISSUE_SOURCES.find((known) => known === value.source);
  if (!source) return fail(`${field}.source must be one of: ${QA_ISSUE_SOURCES.join(", ")}`);
  const check = boundedText(value.check, QA_LIMITS.checkChars);
  if (!check) return fail(`${field}.check must be a non-empty string`);
  if (!finite(value.start) || !finite(value.end) || value.start < 0 || value.end < value.start)
    return fail(`${field}: start and end must be seconds with end ≥ start ≥ 0`);
  const rawClips = value.clipIds ?? [];
  if (!Array.isArray(rawClips) || !rawClips.every((id) => typeof id === "string"))
    return fail(`${field}.clipIds must be an array of clip ids`);
  const message = boundedText(value.message, QA_LIMITS.messageChars);
  if (!message) return fail(`${field}.message must be a non-empty string`);
  if (typeof value.fixable !== "boolean") return fail(`${field}.fixable must be a boolean`);
  let owner: QaOwner | null = null;
  if (value.owner !== undefined && value.owner !== null) {
    const known = QA_OWNERS.find((candidate) => candidate === value.owner);
    if (!known) return fail(`${field}.owner must be one of: ${QA_OWNERS.join(", ")}, or null`);
    owner = known;
  }
  return {
    ok: true,
    value: {
      kind,
      severity,
      source,
      check,
      start: Math.round(value.start * 1000) / 1000,
      end: Math.round(value.end * 1000) / 1000,
      clipIds: [...new Set(rawClips)].slice(0, QA_LIMITS.clipIds),
      subject: boundedText(value.subject, QA_LIMITS.subjectChars),
      message,
      fixable: value.fixable,
      owner,
      suggestion: boundedText(value.suggestion, QA_LIMITS.suggestionChars),
    },
  };
}

function parseQaIssue(value: unknown, field: string): Parsed<QaIssue> {
  const draft = parseQaIssueDraft(value, field);
  if (!draft.ok || !isRecord(value)) return draft.ok ? fail(`${field} must be an object`) : draft;
  const status = QA_ISSUE_STATUSES.find((known) => known === value.status);
  if (!status) return fail(`${field}.status must be one of: ${QA_ISSUE_STATUSES.join(", ")}`);
  if (typeof value.id !== "string" || !/^p\d+-\d+$/.test(value.id))
    return fail(`${field}.id must look like p1-3`);
  if (!finite(value.firstSeenPass) || value.firstSeenPass < 1)
    return fail(`${field}.firstSeenPass must be a pass number`);
  return {
    ok: true,
    value: { ...draft.value, id: value.id, status, firstSeenPass: value.firstSeenPass },
  };
}

// ── Checks and reports ───────────────────────────────────────────────────────

/** The checks of one pass. */
export const QA_CHECK_IDS = [
  "render",
  "black_frames",
  "frozen_frames",
  "audio",
  "timeline",
  "layout",
  "vision",
] as const;
export type QaCheckId = (typeof QA_CHECK_IDS)[number];

/** `unavailable`: this machine cannot run it (reason in `detail`); `skipped`: not applicable to this render. */
export const QA_CHECK_STATUSES = ["ran", "skipped", "unavailable", "failed"] as const;
export type QaCheckStatus = (typeof QA_CHECK_STATUSES)[number];

export interface QaCheckRun {
  id: QaCheckId;
  status: QaCheckStatus;
  detail: string | null;
}

/**
 * Who produced a render QA looked at: `qa` — QA itself rendered it for a pass (an intermediate preview QA may delete
 * when the session ends); `turn` — the Director's own render of the turn, reused by pass 1 (the user's file, never
 * deleted by QA). A report written before this field existed reads as `turn`: when unsure, keep the file.
 */
export const QA_RENDER_ORIGINS = ["qa", "turn"] as const;
export type QaRenderOrigin = (typeof QA_RENDER_ORIGINS)[number];

export interface QaRenderInfo {
  /** Project-relative path of the rendered file. */
  path: string;
  duration: number;
  width: number;
  height: number;
  hasAudio: boolean | null;
  quality: string;
  origin: QaRenderOrigin;
}

/**
 * A frame time Vision should look at, with what the timeline shows there (so Vision can judge fit without reading
 * the timeline itself).
 */
export interface QaSample {
  time: number;
  reason: "cut" | "broll" | "caption" | "graphic" | "suspect" | "coverage";
  /** e.g. `track 1 video assets/city.mp4 (clip c12, story node "Commute": "busy street at dusk"); caption "…"`. */
  context: string;
}

export interface QaCheckRequest {
  /** Project-relative path of the render to check (inside `renders/`). */
  render: string;
  /** The composition that was rendered; the project's main composition when absent. */
  composition?: string;
  /** Vision sample planning (`ExecutionBudget.qaFramesPerMinute` / `qaMaxFrames`). */
  framesPerMinute: number;
  maxFrames: number;
}

export interface QaCheckResponse {
  /** The project fingerprint when the check finished. */
  fingerprint: string;
  composition: string;
  /** Content version of the composition's timeline (`TimelineSnapshot.version`). */
  timelineVersion: string;
  /** Seconds of the render. */
  duration: number;
  checks: QaCheckRun[];
  issues: QaIssueDraft[];
  /** Frame times Vision should review (cuts, B-roll, captions, suspects, then even coverage), within the budget. */
  samples: QaSample[];
}

export interface QaFramesRequest {
  render: string;
  /** Render times, seconds; at most `QA_LIMITS.framesPerRequest`. */
  times: number[];
  /** Output width in pixels (default 640). */
  width?: number;
}

export interface QaFramesResponse {
  frames: FrameImage[];
}

export const QA_VISION_STATUSES = ["ran", "unavailable", "failed", "skipped"] as const;
export type QaVisionStatus = (typeof QA_VISION_STATUSES)[number];

export interface QaVisionRun {
  status: QaVisionStatus;
  /** Why Vision did not (fully) review this pass. */
  reason: string | null;
  /** `qa.reason.<reasonCode>` locale key for `reason`; the UI prefers it when present, `reason` is the fallback. */
  reasonCode?: string;
  /** Placeholder values for `qa.reason.<reasonCode>`. */
  reasonParams?: CodedMessageParams;
  frames: number;
  rounds: number;
  /** `provider/modelId` of the Vision run. */
  model: string | null;
}

/** What the runtime sends to store a pass; the service assigns `id` and `createdAt`. */
export interface QaReportInput {
  /** The turn's QA session (the turn id). */
  sessionId: string;
  turnId: string | null;
  chatId: string | null;
  pass: number;
  passLimit: number;
  preset: ExecutionQualityPreset;
  composition: string;
  /** The project fingerprint the render was made from. */
  fingerprint: string;
  timelineVersion: string | null;
  render: QaRenderInfo | null;
  renderError: string | null;
  checks: QaCheckRun[];
  vision: QaVisionRun;
  issues: QaIssue[];
  /** Issues of the previous pass that are gone. */
  resolved: QaIssue[];
  previousReportId: string | null;
}

export interface QaReport extends QaReportInput {
  id: string;
  schemaVersion: 1;
  createdAt: number;
  counts: QaCounts;
  /** Derived when read: the project still has the fingerprint this report was rendered from. */
  current: boolean;
}

export interface QaReportSummary {
  id: string;
  createdAt: number;
  sessionId: string;
  turnId: string | null;
  pass: number;
  passLimit: number;
  composition: string;
  renderPath: string | null;
  renderError: string | null;
  counts: QaCounts;
  current: boolean;
}

export interface QaReportList {
  fingerprint: string;
  /** Newest first. */
  reports: QaReportSummary[];
}

/** Ends one QA session (the turn's QA): the session's intermediate QA renders go, `keep` stays. */
export interface QaFinishRequest {
  /** The render the final report names (the last successfully rendered pass); null when no pass rendered. */
  keep: string | null;
  /**
   * Renders QA made in this session, including one a stopped pass made before its report was stored. The service
   * still refuses to delete any of them that a report records as the turn's own, or that another session ends on.
   */
  produced?: string[];
}

export interface QaFinishResponse {
  /** Project-relative paths of the renders that were deleted. */
  removedRenders: string[];
  /** Reports the retention policy deleted along the way. */
  removedReports: number;
}

export interface QaStateResponse {
  fingerprint: string;
}

export const QA_ERROR_CODES = [
  "invalid_request",
  "not_found",
  "unavailable",
  "cancelled",
  "failed",
] as const;
export type QaErrorCode = (typeof QA_ERROR_CODES)[number];

export interface QaError {
  code: QaErrorCode;
  message: string;
  /** Placeholder values for `errors.<code>`, when the message interpolates any. */
  params?: CodedMessageParams;
}

export function isQaError(value: unknown): value is QaError {
  return (
    isRecord(value) &&
    typeof value.message === "string" &&
    QA_ERROR_CODES.some((code) => code === value.code)
  );
}

const RENDER_PATH = /^renders\/[^/\\]+\.(mp4|mov|webm)$/;

export function isRenderPath(value: unknown): value is string {
  return typeof value === "string" && RENDER_PATH.test(value) && !value.includes("..");
}

export function parseQaCheckRequest(body: unknown): Parsed<QaCheckRequest> {
  if (!isRecord(body)) return fail("body must be an object");
  if (!isRenderPath(body.render)) return fail("render must be a file in renders/");
  if (body.composition !== undefined && typeof body.composition !== "string")
    return fail("composition must be a project-relative path");
  const fpm = body.framesPerMinute;
  const max = body.maxFrames;
  const ranges = EXECUTION_BUDGET_RANGES;
  if (!finite(fpm) || fpm < ranges.qaFramesPerMinute.min || fpm > ranges.qaFramesPerMinute.max)
    return fail(
      `framesPerMinute must be from ${ranges.qaFramesPerMinute.min} to ${ranges.qaFramesPerMinute.max}`,
    );
  if (!finite(max) || max < ranges.qaMaxFrames.min || max > ranges.qaMaxFrames.max)
    return fail(`maxFrames must be from ${ranges.qaMaxFrames.min} to ${ranges.qaMaxFrames.max}`);
  return {
    ok: true,
    value: {
      render: body.render,
      ...(typeof body.composition === "string" &&
        body.composition && { composition: body.composition }),
      framesPerMinute: fpm,
      maxFrames: Math.round(max),
    },
  };
}

export function parseQaFramesRequest(body: unknown): Parsed<QaFramesRequest> {
  if (!isRecord(body)) return fail("body must be an object");
  if (!isRenderPath(body.render)) return fail("render must be a file in renders/");
  const times = body.times;
  if (
    !Array.isArray(times) ||
    times.length === 0 ||
    times.length > QA_LIMITS.framesPerRequest ||
    !times.every((time) => finite(time) && time >= 0)
  )
    return fail(`times must list 1–${QA_LIMITS.framesPerRequest} non-negative seconds`);
  if (body.width !== undefined && (!finite(body.width) || body.width < 64 || body.width > 1920))
    return fail("width must be 64–1920 pixels");
  return {
    ok: true,
    value: {
      render: body.render,
      times: times.filter(finite),
      ...(finite(body.width) && { width: Math.round(body.width) }),
    },
  };
}

/** At most this many renders in `produced`: a session makes one per pass. */
const MAX_PRODUCED_RENDERS = 32;

export function parseQaFinishRequest(body: unknown): Parsed<QaFinishRequest> {
  if (!isRecord(body)) return fail("body must be an object");
  if (body.keep !== null && !isRenderPath(body.keep))
    return fail("keep must be a file in renders/ or null");
  const produced = body.produced;
  if (produced === undefined) return { ok: true, value: { keep: body.keep } };
  if (
    !Array.isArray(produced) ||
    produced.length > MAX_PRODUCED_RENDERS ||
    !produced.every(isRenderPath)
  )
    return fail(`produced must list at most ${MAX_PRODUCED_RENDERS} files in renders/`);
  return { ok: true, value: { keep: body.keep, produced: produced.filter(isRenderPath) } };
}

export function isQaFinishResponse(value: unknown): value is QaFinishResponse {
  return (
    isRecord(value) &&
    finite(value.removedReports) &&
    Array.isArray(value.removedRenders) &&
    value.removedRenders.every((path) => typeof path === "string")
  );
}

function parseCheckRun(value: unknown): QaCheckRun | null {
  if (!isRecord(value)) return null;
  const id = QA_CHECK_IDS.find((known) => known === value.id);
  const status = QA_CHECK_STATUSES.find((known) => known === value.status);
  if (!id || !status) return null;
  return { id, status, detail: boundedText(value.detail, QA_LIMITS.messageChars) };
}

function parseRenderInfo(value: unknown): QaRenderInfo | null {
  if (!isRecord(value) || !isRenderPath(value.path)) return null;
  if (!finite(value.duration) || !finite(value.width) || !finite(value.height)) return null;
  const hasAudio = typeof value.hasAudio === "boolean" ? value.hasAudio : null;
  const quality = typeof value.quality === "string" ? value.quality.slice(0, 20) : "standard";
  const origin = value.origin === "qa" ? "qa" : "turn";
  return {
    path: value.path,
    duration: value.duration,
    width: value.width,
    height: value.height,
    hasAudio,
    quality,
    origin,
  };
}

function parseIssueList(value: unknown, field: string): Parsed<QaIssue[]> {
  if (!Array.isArray(value) || value.length > QA_LIMITS.issues)
    return fail(`${field} must be an array of at most ${QA_LIMITS.issues} issues`);
  const issues: QaIssue[] = [];
  for (const [index, item] of value.entries()) {
    const issue = parseQaIssue(item, `${field}[${index}]`);
    if (!issue.ok) return issue;
    issues.push(issue.value);
  }
  return { ok: true, value: issues };
}

function optionalId(value: unknown): string | null {
  return typeof value === "string" && /^[A-Za-z0-9_.:-]{1,128}$/.test(value) ? value : null;
}

export function parseQaReportInput(body: unknown): Parsed<QaReportInput> {
  if (!isRecord(body)) return fail("body must be an object");
  const sessionId = optionalId(body.sessionId);
  if (!sessionId) return fail("sessionId is required");
  const pass = body.pass;
  const passLimit = body.passLimit;
  const passMax = EXECUTION_BUDGET_RANGES.qaPasses.max;
  if (!finite(passLimit) || !Number.isInteger(passLimit) || passLimit < 1 || passLimit > passMax)
    return fail(`passLimit must be 1–${passMax}`);
  if (!finite(pass) || !Number.isInteger(pass) || pass < 1 || pass > passLimit)
    return fail("pass must be 1–passLimit");
  const preset = EXECUTION_QUALITY_PRESETS.find((known) => known === body.preset);
  if (!preset) return fail(`preset must be one of: ${EXECUTION_QUALITY_PRESETS.join(", ")}`);
  if (typeof body.composition !== "string" || !body.composition)
    return fail("composition is required");
  if (typeof body.fingerprint !== "string" || !body.fingerprint)
    return fail("fingerprint is required");
  const render = body.render === null ? null : parseRenderInfo(body.render);
  if (body.render !== null && !render) return fail("render must be a render description or null");
  if (!Array.isArray(body.checks)) return fail("checks must be an array");
  const checks = body.checks.map(parseCheckRun);
  if (checks.some((check) => check === null)) return fail("checks contain an invalid entry");
  const rawVision = body.vision;
  if (!isRecord(rawVision)) return fail("vision must be an object");
  const visionStatus = QA_VISION_STATUSES.find((known) => known === rawVision.status);
  if (!visionStatus) return fail(`vision.status must be one of: ${QA_VISION_STATUSES.join(", ")}`);
  const issues = parseIssueList(body.issues, "issues");
  if (!issues.ok) return issues;
  const resolved = parseIssueList(body.resolved, "resolved");
  if (!resolved.ok) return resolved;
  return {
    ok: true,
    value: {
      sessionId,
      turnId: optionalId(body.turnId),
      chatId: optionalId(body.chatId),
      pass,
      passLimit,
      preset,
      composition: body.composition,
      fingerprint: body.fingerprint,
      timelineVersion: typeof body.timelineVersion === "string" ? body.timelineVersion : null,
      render,
      renderError: boundedText(body.renderError, QA_LIMITS.messageChars),
      checks: checks.filter((check): check is QaCheckRun => check !== null),
      vision: {
        status: visionStatus,
        reason: boundedText(rawVision.reason, QA_LIMITS.messageChars),
        ...(typeof rawVision.reasonCode === "string" &&
          rawVision.reasonCode.length > 0 && { reasonCode: rawVision.reasonCode.slice(0, 100) }),
        ...(isRecord(rawVision.reasonParams) && {
          reasonParams: readErrorParams(rawVision.reasonParams),
        }),
        frames: finite(rawVision.frames) ? Math.max(0, Math.round(rawVision.frames)) : 0,
        rounds: finite(rawVision.rounds) ? Math.max(0, Math.round(rawVision.rounds)) : 0,
        model: typeof rawVision.model === "string" ? rawVision.model.slice(0, 200) : null,
      },
      issues: issues.value,
      resolved: resolved.value,
      previousReportId: optionalId(body.previousReportId),
    },
  };
}

// ── Turn QA state (chat events) ──────────────────────────────────────────────

/** Where one pass is: rendering → checking → reviewing (Vision) → done; `correcting` while its correction runs. */
export const QA_PASS_PHASES = [
  "rendering",
  "checking",
  "reviewing",
  "done",
  "correcting",
  "corrected",
  "failed",
  "aborted",
] as const;
export type QaPassPhase = (typeof QA_PASS_PHASES)[number];

export interface QaPassState {
  pass: number;
  phase: QaPassPhase;
  reportId: string | null;
  renderPath: string | null;
  /** Counts once the pass is checked. */
  counts: QaCounts | null;
  vision: QaVisionStatus | null;
  /** Render failure or why the pass stopped. */
  error: string | null;
  startedAt: number;
  endedAt?: number;
}

/**
 * `running`; `passed` — the last pass found no open issue; `issues_remain` — open issues after the last pass (the
 * pass limit was reached, nothing fixable was left, or a correction changed nothing); `skipped` — QA did not run
 * (reason says why: off, nothing changed, too long to render unasked, …); `failed` — QA could not complete (the
 * render or the checks failed on the last pass); `aborted` — the turn was stopped during QA.
 */
export const TURN_QA_STATUSES = [
  "running",
  "passed",
  "issues_remain",
  "skipped",
  "failed",
  "aborted",
] as const;
export type TurnQaStatus = (typeof TURN_QA_STATUSES)[number];

export interface TurnQaState {
  status: TurnQaStatus;
  preset: ExecutionQualityPreset;
  passLimit: number;
  passes: QaPassState[];
  reason: string | null;
  /** `qa.reason.<reasonCode>` locale key for `reason`; the UI prefers it when present, `reason` is the fallback. */
  reasonCode?: string;
  /** Placeholder values for `qa.reason.<reasonCode>`. */
  reasonParams?: CodedMessageParams;
}

// ── Wire guards ──────────────────────────────────────────────────────────────

function isCounts(value: unknown): value is QaCounts {
  return (
    isRecord(value) &&
    ["issues", "errors", "warnings", "fixable", "new", "persisting", "reappeared", "fixed"].every(
      (key) => finite(value[key]),
    )
  );
}

export function isQaReport(value: unknown): value is QaReport {
  if (!isRecord(value)) return false;
  if (typeof value.id !== "string" || value.schemaVersion !== 1 || !finite(value.createdAt))
    return false;
  if (!isCounts(value.counts) || typeof value.current !== "boolean") return false;
  return parseQaReportInput(value).ok;
}

export function isQaCheckResponse(value: unknown): value is QaCheckResponse {
  if (!isRecord(value)) return false;
  if (
    typeof value.fingerprint !== "string" ||
    typeof value.composition !== "string" ||
    typeof value.timelineVersion !== "string" ||
    !finite(value.duration)
  )
    return false;
  if (!Array.isArray(value.checks) || !value.checks.every((check) => parseCheckRun(check) !== null))
    return false;
  if (!Array.isArray(value.issues) || !value.issues.every((issue) => parseQaIssueDraft(issue).ok))
    return false;
  return (
    Array.isArray(value.samples) &&
    value.samples.every(
      (sample) =>
        isRecord(sample) &&
        finite(sample.time) &&
        typeof sample.reason === "string" &&
        typeof sample.context === "string",
    )
  );
}
