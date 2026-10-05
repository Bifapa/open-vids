/**
 * OpenVids long-form analysis: the product-level contract between the Studio server's analysis service
 * (`/api/projects/:id/analysis/*`) and its clients (the agent runtime's analysis tools, later Story Mode).
 *
 * Analysis is durable, per source media file, and independent of any speech/vision provider: artifacts carry
 * OpenVids concepts (words, sentences, speakers, pauses, shots, take issues, segments, visual notes, cut plans) and
 * never an engine's raw output. All times in artifacts are seconds of the SOURCE media, except `CutRange.at`, which is
 * the position on the cut's timeline.
 *
 * Routes (all JSON; errors are `{ error: AnalysisError }`):
 *   GET  …/analysis/sources                         → { sources: SourceAnalysisStatus[] }
 *   POST …/analysis/jobs              AnalyzeRequest → AnalysisJob (an identical request joins the running job of the
 *                                                       source; one it would not satisfy — force, another language,
 *                                                       more stages — is refused with a `conflict` error, HTTP 409)
 *   GET  …/analysis/jobs/:jobId                     → AnalysisJob
 *   POST …/analysis/jobs/:jobId/cancel              → AnalysisJob
 *   GET  …/analysis/overview?source=                → AnalysisOverview
 *   GET  …/analysis/transcript?source=&from=&to=&words=1 → TranscriptView
 *   GET  …/analysis/artifact?source=&stage=         → the stage's artifact (TranscriptArtifact, SpeakerMap, …)
 *   PUT  …/analysis/segments      SaveSegmentsRequest → SegmentMap
 *   POST …/analysis/vision   SaveVisionNotesRequest → VisionAnalysis
 *   POST …/analysis/frames            FramesRequest → FramesResponse
 *   POST …/analysis/cuts            CutPlanRequest → CutPlan
 *   GET  …/analysis/cuts?source=                    → { plans: CutPlanSummary[] }
 *   GET  …/analysis/cuts/:planId                    → CutPlan
 *   POST …/analysis/cuts/:planId/applied  MarkCutAppliedRequest → CutPlan
 */

import type { AssetRange } from "./editing.js";
import type { CodedMessageParams } from "./types.js";
import { isRecord } from "./validate.js";

// ── Stages and cache state ───────────────────────────────────────────────────

/** Every artifact kind kept per source. */
export const ANALYSIS_STAGES = [
  "transcript",
  "speakers",
  "silence",
  "shots",
  "takes",
  "segments",
  "vision",
] as const;
export type AnalysisStage = (typeof ANALYSIS_STAGES)[number];

/** Stages the service computes itself (the `segments` it computes are the draft segmentation). */
export const COMPUTED_STAGES = [
  "transcript",
  "speakers",
  "silence",
  "shots",
  "takes",
  "segments",
] as const satisfies readonly AnalysisStage[];
export type ComputedStage = (typeof COMPUTED_STAGES)[number];

/**
 * - `fresh`: stored and valid for the current source bytes and its inputs.
 * - `stale`: stored, but the source changed (or an input stage changed) since; it is recomputed or dropped on the next run.
 * - `unavailable`: this machine cannot produce it (e.g. no speech recognizer installed); `detail` says why.
 */
export const STAGE_STATUSES = [
  "missing",
  "fresh",
  "stale",
  "running",
  "failed",
  "unavailable",
] as const;
export type StageStatus = (typeof STAGE_STATUSES)[number];

/** Identity of a source file's bytes: a cheap stat check first, a sampled content hash when the stat changed. */
export interface SourceFingerprint {
  /** Project-relative path, `/`-separated. */
  path: string;
  bytes: number;
  mtimeMs: number;
  /** `sha256:<hex>` over the size and sampled chunks (head, middle, tail) of the file. */
  hash: string;
  /**
   * `sha256:<hex>` over many more evenly spaced chunks of a file larger than the head/middle/tail samples cover, so
   * an edit anywhere in a big file changes the fingerprint. Absent for small files (hashed whole) and for
   * fingerprints taken before it existed; it is added the next time the file's stat changes.
   */
  denseHash?: string;
  /** Media duration in seconds, when probed. */
  duration: number | null;
}

export interface StageState {
  stage: AnalysisStage;
  status: StageStatus;
  /** Epoch ms of the stored artifact, when there is one. */
  updatedAt: number | null;
  /** Content version (`sha256:<hex>`) of the stored artifact. */
  version: string | null;
  /** Why a stage is stale, failed or unavailable. */
  detail: string | null;
}

export interface SourceAnalysisStatus {
  source: string;
  kind: "video" | "audio";
  duration: number | null;
  /** Null until the source was fingerprinted by a first analysis. */
  fingerprint: SourceFingerprint | null;
  stages: StageState[];
}

// ── Artifacts ────────────────────────────────────────────────────────────────

export interface TimeRange {
  start: number;
  end: number;
}

export interface TranscriptWord {
  /** Index in the transcript's word list. */
  i: number;
  text: string;
  start: number;
  end: number;
  /** Speaker id from the speaker map (`S1`, `S2`, …), null without one. */
  speaker: string | null;
}

export interface TranscriptSentence {
  /** Stable within one transcript version: `s1`, `s2`, … in time order. */
  id: string;
  start: number;
  end: number;
  /** Word index range, inclusive. */
  firstWord: number;
  lastWord: number;
  text: string;
  speaker: string | null;
}

/** What the transcript stage removed as recognizer hallucination: one sentence looped back to back. */
export interface TranscriptHallucinations {
  /** Runs of a repeated sentence found. */
  runs: number;
  /** Sentences and words removed (the first copy of a run stays unless the run sits in silence). */
  droppedSentences: number;
  droppedWords: number;
  /** Human-readable summary: which sentence, how many copies, where. */
  note: string;
}

export interface TranscriptArtifact {
  source: string;
  /** BCP-47-ish language code when known (`en`, `ru`). */
  language: string | null;
  words: TranscriptWord[];
  sentences: TranscriptSentence[];
  /** Seconds covered by words. */
  speechSeconds: number;
  /** Present only when a hallucination loop was removed from the recognizer's words. */
  hallucinations?: TranscriptHallucinations;
}

export interface SpeakerInfo {
  id: string;
  /** Optional human label set later (e.g. "Host"). */
  label: string | null;
  seconds: number;
  /** Share of the speech time, 0–1. */
  share: number;
}

export interface SpeakerTurn {
  speaker: string;
  start: number;
  end: number;
}

export interface SpeakerMap {
  source: string;
  /** `diarization`: voices were separated; `single`: one speaker assumed (no diarizer on this machine, or one voice). */
  method: "diarization" | "single";
  speakers: SpeakerInfo[];
  turns: SpeakerTurn[];
  /** Why `single` was used when diarization was not possible. */
  note: string | null;
}

export interface SilenceMap {
  source: string;
  /** Level (dBFS) below which audio counts as silence. */
  thresholdDb: number;
  /** Shortest silence recorded, seconds. */
  minSilence: number;
  silences: TimeRange[];
  silenceSeconds: number;
}

export interface Shot {
  /** `k1`, `k2`, … in time order. */
  id: string;
  start: number;
  end: number;
}

export const VISUAL_PROBLEM_KINDS = ["black", "frozen"] as const;
export type VisualProblemKind = (typeof VISUAL_PROBLEM_KINDS)[number];

export interface VisualProblem extends TimeRange {
  kind: VisualProblemKind;
}

export interface ShotMap {
  source: string;
  /** Scene-change score (0–1) above which a hard cut starts a new shot. */
  sceneThreshold: number;
  shots: Shot[];
  /** Deterministically detected picture problems (black frames, frozen picture). */
  problems: VisualProblem[];
}

export const TAKE_ISSUE_KINDS = [
  /** A line said again right after; the earlier attempt is the bad take. */
  "retake",
  /** A sentence abandoned after a few words and restarted. */
  "false_start",
  /** Words that announce a retake ("let me start over", "scratch that"). */
  "restart_cue",
  /** An immediately repeated word or short phrase ("the the"). */
  "stutter",
  /** Filler words ("um", "uh"). */
  "filler",
  /** Picture problems under kept speech. */
  "black",
  "frozen",
] as const;
export type TakeIssueKind = (typeof TAKE_ISSUE_KINDS)[number];

export const TAKE_ACTIONS = ["cut", "review"] as const;
/** `cut`: safe to remove automatically; `review`: needs a decision (by Vision or the Editor). */
export type TakeAction = (typeof TAKE_ACTIONS)[number];

export interface TakeIssue extends TimeRange {
  /** `t1`, `t2`, … */
  id: string;
  kind: TakeIssueKind;
  /** Sentences involved (the bad attempt first). */
  sentences: string[];
  /** 0–1. */
  confidence: number;
  action: TakeAction;
  /** Human-readable evidence ("s41 is re-said as s43"). */
  note: string;
  /** The sentence that replaces the bad take, when there is one. */
  keep: string | null;
}

export interface TakeAnalysis {
  source: string;
  issues: TakeIssue[];
}

export const SEGMENT_ROLES = [
  "hook",
  "intro",
  "main",
  "example",
  "story",
  "interview",
  "tangent",
  "recap",
  "outro",
  "call_to_action",
  "filler",
] as const;
export type SegmentRole = (typeof SEGMENT_ROLES)[number];

/** `must`: the meaning depends on it; `drop`: leave it out of the cut. */
export const SEGMENT_PRIORITIES = ["must", "should", "optional", "drop"] as const;
export type SegmentPriority = (typeof SEGMENT_PRIORITIES)[number];

export interface Segment extends TimeRange {
  /** `g1`, `g2`, … in time order. */
  id: string;
  firstSentence: string;
  lastSentence: string;
  title: string;
  summary: string;
  role: SegmentRole;
  priority: SegmentPriority;
  /** Dominant speaker. */
  speaker: string | null;
}

export interface SegmentMap {
  source: string;
  /** `draft`: computed from pauses, speaker turns and topic shifts; `semantic`: written by an agent that read it. */
  origin: "draft" | "semantic";
  /** Transcript version the segments' sentence ids refer to. */
  transcriptVersion: string;
  segments: Segment[];
}

export const VISION_QUALITIES = ["good", "usable", "poor", "unusable"] as const;
export type VisionQuality = (typeof VISION_QUALITIES)[number];

export interface VisionNote extends TimeRange {
  /** `v1`, `v2`, … */
  id: string;
  /** Source times of the frames the note is based on. */
  frames: number[];
  quality: VisionQuality;
  /** Short lowercase tags: `speaker_on_camera`, `slide`, `black`, `frozen`, `slate`, `b_roll_candidate`, … */
  tags: string[];
  finding: string;
  createdAt: number;
}

export interface VisionAnalysis {
  source: string;
  notes: VisionNote[];
  /** Every source time a frame was extracted for (sorted, unique): what Vision has already looked at. */
  inspectedFrames: number[];
}

/** A range the service suggests Vision should look at, and the frames that would answer it. */
export interface VisionTarget extends TimeRange {
  reason: "visual_problem" | "take_review" | "segment_sample" | "shot_sample";
  /** Issue, segment or shot id. */
  ref: string | null;
  times: number[];
  /** True when every frame of `times` was already inspected. */
  inspected: boolean;
}

// ── Cut plans (edit decisions) ───────────────────────────────────────────────

export interface CutRange {
  /** Source in/out, seconds. */
  from: number;
  to: number;
  /** Position on the cut's timeline. */
  at: number;
  segment: string | null;
  /** Part of the cold-open teaser (a duplicate of material that also plays later). */
  hook: boolean;
}

export const CUT_REMOVAL_REASONS = ["pause", "filler", "take", "segment", "visual"] as const;
export type CutRemovalReason = (typeof CUT_REMOVAL_REASONS)[number];

export interface CutRemoval {
  from: number;
  to: number;
  reason: CutRemovalReason;
  /** Issue or segment id. */
  ref: string | null;
}

export interface CutPlanStats {
  sourceDuration: number;
  cutDuration: number;
  ranges: number;
  removedPauseSeconds: number;
  removedFillers: number;
  removedTakes: number;
  droppedSegments: string[];
  movedSegments: string[];
  hookSeconds: number;
}

export interface CutPlanRequest {
  source: string;
  /** Short label: "rough cut", "pacing pass". */
  label?: string;
  /** Plan this one refines: every option not given here is taken from it. */
  basedOn?: string;
  /** Segment ids in playing order; omitted = source order. Segments not listed are dropped. */
  order?: string[];
  /** Segments to leave out, in addition to those with priority `drop`. */
  drop?: string[];
  /** `must` segments may only be dropped when also listed here. */
  allowDropMust?: string[];
  /** Cold open: these sentences play first as a teaser (and again at their place). */
  hook?: { firstSentence: string; lastSentence: string } | null;
  /** Take issues to cut; `auto` (default) = every issue whose action is `cut`. */
  removeIssues?: "auto" | string[];
  /** Issues to keep even if `removeIssues` would cut them. */
  keepIssues?: string[];
  /** Remove filler words (default true). */
  removeFillers?: boolean;
  /** Pauses longer than this (seconds) are shortened to `pauseKeep` (defaults 0.7 and 0.3). */
  maxPause?: number;
  pauseKeep?: number;
  /** Target length in seconds; the plan warns when it misses it by more than 10 %. */
  targetDuration?: number;
}

export interface CutPlanSummary {
  /** `cut-1`, `cut-2`, … per project. */
  id: string;
  source: string;
  label: string;
  createdAt: number;
  basedOn: string | null;
  stats: CutPlanStats;
  applied: CutApplication | null;
}

/**
 * Where a plan is on the timeline right now: derived on every read from the clips stamped with the plan's id
 * (`data-ov-cut`), so a reverted or removed rough cut is never reported as applied.
 */
export interface CutApplication {
  composition: string;
  /** Clips of this plan on that composition. */
  clips: number;
}

export interface CutPlan extends CutPlanSummary {
  /** The effective options (base plan merged with this request). */
  request: CutPlanRequest;
  transcriptVersion: string;
  segmentsVersion: string;
  /**
   * The fragment the user had picked of the source when the plan was made (absent/null: the whole file). Every range
   * of the plan stays inside it; once the pick changes the plan is out of date (the service says so on read).
   */
  mediaRange?: AssetRange | null;
  ranges: CutRange[];
  removed: CutRemoval[];
  warnings: string[];
  /**
   * Set on read when the plan no longer fits its source (the media, the transcript or the picked fragment changed
   * since planning): why, in words. Its ranges are source times of the old state, so it must not be built.
   */
  outOfDate?: string;
}

// ── Requests / responses ─────────────────────────────────────────────────────

export interface AnalyzeRequest {
  source: string;
  /** Default: every computed stage. */
  stages?: ComputedStage[];
  /** Spoken language hint (`en`, `ru`); detected when absent. */
  language?: string;
  /** Recompute even fresh stages. */
  force?: boolean;
}

export type StageOutcome = "cached" | "computed" | "unavailable" | "failed" | "skipped";

export interface StageResult {
  stage: ComputedStage;
  outcome: StageOutcome;
  seconds: number;
  detail: string | null;
}

export interface AnalysisJob {
  id: string;
  source: string;
  status: "running" | "completed" | "failed" | "cancelled";
  /** Stage running now. */
  stage: ComputedStage | null;
  /** 0–100 over the whole job. */
  progress: number;
  results: StageResult[];
  error: AnalysisError | null;
  startedAt: number;
  /**
   * When the job last showed a sign of life (ms since the epoch): it started, changed stage, moved its progress,
   * finished a stage, or a recognizer child it waits for is still running. A client that waits for the job treats a
   * job whose stage, progress and this value stand still as stuck.
   */
  updatedAt: number;
  finishedAt: number | null;
  /**
   * Only on the answer to a start request: true when a job of the same source was already running and the request
   * joined it instead of starting one. The job is then shared, so a joiner must not cancel it.
   */
  joined?: boolean;
}

export interface SegmentInput {
  firstSentence: string;
  lastSentence: string;
  title: string;
  summary: string;
  role: SegmentRole;
  priority: SegmentPriority;
}

export interface SaveSegmentsRequest {
  source: string;
  /** Transcript version the sentence ids were read from; refused when the transcript changed. */
  transcriptVersion: string;
  /** In time order, contiguous: together they cover every sentence exactly once. */
  segments: SegmentInput[];
}

export interface VisionNoteInput extends TimeRange {
  frames: number[];
  quality: VisionQuality;
  tags: string[];
  finding: string;
}

export interface SaveVisionNotesRequest {
  source: string;
  /** Appended; a note with the same start/end as a stored one replaces it. */
  notes: VisionNoteInput[];
}

export interface FramesRequest {
  source: string;
  /** Source times, seconds. */
  times: number[];
  /** Output width in pixels (default 512). */
  width?: number;
}

export interface FrameImage {
  time: number;
  mimeType: "image/jpeg";
  /** Base64 JPEG. */
  data: string;
  /** Served from the analysis cache instead of decoded again. */
  cached: boolean;
}

export interface FramesResponse {
  source: string;
  frames: FrameImage[];
}

export interface TranscriptView {
  source: string;
  version: string;
  language: string | null;
  /** The requested window (whole transcript by default). */
  from: number;
  to: number;
  sentences: TranscriptSentence[];
  /** Only with `words=1`. */
  words?: TranscriptWord[];
  totalSentences: number;
}

/** Everything a planner needs to know about one source, compact. */
export interface AnalysisOverview {
  status: SourceAnalysisStatus;
  transcript: {
    version: string;
    language: string | null;
    words: number;
    sentences: number;
    speechSeconds: number;
  } | null;
  speakers: SpeakerMap | null;
  silence: {
    count: number;
    totalSeconds: number;
    /** Longest silences first, at most 10. */
    longest: TimeRange[];
    /** Silences of at least 1 s. */
    over1s: number;
  } | null;
  shots: { count: number; averageSeconds: number; problems: VisualProblem[] } | null;
  takes: {
    counts: Partial<Record<TakeIssueKind, number>>;
    /** Every issue except fillers and stutters (those are only counted). */
    issues: TakeIssue[];
  } | null;
  segments: SegmentMap | null;
  vision: { notes: VisionNote[]; inspectedFrames: number } | null;
  visionTargets: VisionTarget[];
  cuts: CutPlanSummary[];
}

// ── Errors ───────────────────────────────────────────────────────────────────

export const ANALYSIS_ERROR_CODES = [
  "invalid_request",
  "unknown_source",
  "unknown_plan",
  /** A stage the request needs was never computed. */
  "not_analyzed",
  /** The source or an input stage changed since the artifact was made. */
  "stale",
  /** The request refers to an old transcript/segment version. */
  "conflict",
  /** This machine cannot run the stage (no recognizer, no ffmpeg). */
  "unavailable",
  "cancelled",
  "failed",
] as const;
export type AnalysisErrorCode = (typeof ANALYSIS_ERROR_CODES)[number];

export interface AnalysisError {
  code: AnalysisErrorCode;
  message: string;
  /** Placeholder values for `errors.<code>`, when the message interpolates any. */
  params?: CodedMessageParams;
}

export function isAnalysisError(value: unknown): value is AnalysisError {
  return (
    isRecord(value) &&
    typeof value.message === "string" &&
    ANALYSIS_ERROR_CODES.some((code) => code === value.code)
  );
}

// ── Limits and validation ────────────────────────────────────────────────────

export const ANALYSIS_LIMITS = {
  pathChars: 1_024,
  idChars: 64,
  titleChars: 120,
  summaryChars: 600,
  findingChars: 600,
  tagChars: 40,
  tags: 12,
  segments: 200,
  visionNotes: 50,
  framesPerNote: 24,
  framesPerRequest: 12,
  minFrameWidth: 160,
  maxFrameWidth: 1280,
  orderEntries: 200,
  issueIds: 2_000,
  maxTime: 24 * 60 * 60,
  maxPause: 10,
  languageChars: 16,
} as const;

export type ParsedAnalysis<T> = { ok: true; value: T } | { ok: false; error: AnalysisError };

class Invalid extends Error {}

function fail(message: string): never {
  throw new Invalid(message);
}

function onlyKeys(value: Record<string, unknown>, allowed: readonly string[], where: string): void {
  const extra = Object.keys(value).find((key) => !allowed.includes(key));
  if (extra) fail(`${where}unknown field "${extra}"`);
}

function str(value: unknown, field: string, max: number): string {
  if (typeof value !== "string" || value.trim().length === 0)
    fail(`${field} must be a non-empty string`);
  if (value.length > max) fail(`${field} exceeds ${max} characters`);
  return value;
}

function time(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0)
    fail(`${field} must be a number of seconds ≥ 0`);
  if (value > ANALYSIS_LIMITS.maxTime) fail(`${field} exceeds ${ANALYSIS_LIMITS.maxTime} seconds`);
  return value;
}

function bool(value: unknown, field: string): boolean {
  if (typeof value !== "boolean") fail(`${field} must be true or false`);
  return value;
}

function pick<T extends string>(value: unknown, allowed: readonly T[], field: string): T {
  const match = allowed.find((candidate) => candidate === value);
  if (match === undefined) fail(`${field} must be one of ${allowed.join(", ")}`);
  return match;
}

function ids(value: unknown, field: string, max: number): string[] {
  if (!Array.isArray(value)) fail(`${field} must be an array of ids`);
  if (value.length > max) fail(`${field} exceeds ${max} entries`);
  return value.map((entry, index) => str(entry, `${field}[${index}]`, ANALYSIS_LIMITS.idChars));
}

function times(value: unknown, field: string, min: number, max: number): number[] {
  if (!Array.isArray(value) || value.length < min)
    fail(`${field} must be an array of at least ${min} time${min === 1 ? "" : "s"}`);
  if (value.length > max) fail(`${field} exceeds ${max} entries`);
  return value.map((entry, index) => time(entry, `${field}[${index}]`));
}

function range(value: Record<string, unknown>, where: string): TimeRange {
  const start = time(value.start, `${where}start`);
  const end = time(value.end, `${where}end`);
  if (end <= start) fail(`${where}end must be after start`);
  return { start, end };
}

function parse<T>(read: () => T): ParsedAnalysis<T> {
  try {
    return { ok: true, value: read() };
  } catch (error) {
    if (error instanceof Invalid)
      return { ok: false, error: { code: "invalid_request", message: error.message } };
    throw error;
  }
}

function body(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) fail("body must be a JSON object");
  return value;
}

export function parseAnalyzeRequest(raw: unknown): ParsedAnalysis<AnalyzeRequest> {
  return parse(() => {
    const value = body(raw);
    onlyKeys(value, ["source", "stages", "language", "force"], "");
    const request: AnalyzeRequest = {
      source: str(value.source, "source", ANALYSIS_LIMITS.pathChars),
    };
    if (value.stages !== undefined) {
      if (!Array.isArray(value.stages) || value.stages.length === 0)
        fail("stages must be a non-empty array");
      request.stages = [
        ...new Set(
          value.stages.map((stage, index) => pick(stage, COMPUTED_STAGES, `stages[${index}]`)),
        ),
      ];
    }
    if (value.language !== undefined) {
      const language = str(value.language, "language", ANALYSIS_LIMITS.languageChars);
      if (!/^[A-Za-z]{2,3}([-_][A-Za-z0-9]{2,8})?$/.test(language))
        fail("language must be a language code like en or pt-BR");
      request.language = language;
    }
    if (value.force !== undefined) request.force = bool(value.force, "force");
    return request;
  });
}

export function parseSaveSegmentsRequest(raw: unknown): ParsedAnalysis<SaveSegmentsRequest> {
  return parse(() => {
    const value = body(raw);
    onlyKeys(value, ["source", "transcriptVersion", "segments"], "");
    if (!Array.isArray(value.segments) || value.segments.length === 0)
      fail("segments must be a non-empty array");
    if (value.segments.length > ANALYSIS_LIMITS.segments)
      fail(`segments exceeds ${ANALYSIS_LIMITS.segments} entries`);
    const segments = value.segments.map((entry: unknown, index: number): SegmentInput => {
      const where = `segments[${index}].`;
      if (!isRecord(entry)) fail(`segments[${index}] must be an object`);
      onlyKeys(
        entry,
        ["firstSentence", "lastSentence", "title", "summary", "role", "priority"],
        where,
      );
      return {
        firstSentence: str(entry.firstSentence, `${where}firstSentence`, ANALYSIS_LIMITS.idChars),
        lastSentence: str(entry.lastSentence, `${where}lastSentence`, ANALYSIS_LIMITS.idChars),
        title: str(entry.title, `${where}title`, ANALYSIS_LIMITS.titleChars),
        summary: str(entry.summary, `${where}summary`, ANALYSIS_LIMITS.summaryChars),
        role: pick(entry.role, SEGMENT_ROLES, `${where}role`),
        priority: pick(entry.priority, SEGMENT_PRIORITIES, `${where}priority`),
      };
    });
    return {
      source: str(value.source, "source", ANALYSIS_LIMITS.pathChars),
      transcriptVersion: str(value.transcriptVersion, "transcriptVersion", 200),
      segments,
    };
  });
}

export function parseSaveVisionNotesRequest(raw: unknown): ParsedAnalysis<SaveVisionNotesRequest> {
  return parse(() => {
    const value = body(raw);
    onlyKeys(value, ["source", "notes"], "");
    if (!Array.isArray(value.notes) || value.notes.length === 0)
      fail("notes must be a non-empty array");
    if (value.notes.length > ANALYSIS_LIMITS.visionNotes)
      fail(`notes exceeds ${ANALYSIS_LIMITS.visionNotes} entries`);
    const notes = value.notes.map((entry: unknown, index: number): VisionNoteInput => {
      const where = `notes[${index}].`;
      if (!isRecord(entry)) fail(`notes[${index}] must be an object`);
      onlyKeys(entry, ["start", "end", "frames", "quality", "tags", "finding"], where);
      if (!Array.isArray(entry.tags)) fail(`${where}tags must be an array of strings`);
      if (entry.tags.length > ANALYSIS_LIMITS.tags)
        fail(`${where}tags exceeds ${ANALYSIS_LIMITS.tags} entries`);
      return {
        ...range(entry, where),
        frames: times(entry.frames, `${where}frames`, 0, ANALYSIS_LIMITS.framesPerNote),
        quality: pick(entry.quality, VISION_QUALITIES, `${where}quality`),
        tags: entry.tags.map((tag: unknown, tagIndex: number) =>
          str(tag, `${where}tags[${tagIndex}]`, ANALYSIS_LIMITS.tagChars).trim().toLowerCase(),
        ),
        finding: str(entry.finding, `${where}finding`, ANALYSIS_LIMITS.findingChars),
      };
    });
    return { source: str(value.source, "source", ANALYSIS_LIMITS.pathChars), notes };
  });
}

export function parseFramesRequest(raw: unknown): ParsedAnalysis<FramesRequest> {
  return parse(() => {
    const value = body(raw);
    onlyKeys(value, ["source", "times", "width"], "");
    const request: FramesRequest = {
      source: str(value.source, "source", ANALYSIS_LIMITS.pathChars),
      times: times(value.times, "times", 1, ANALYSIS_LIMITS.framesPerRequest),
    };
    if (value.width !== undefined) {
      const { width } = value;
      if (
        typeof width !== "number" ||
        !Number.isInteger(width) ||
        width < ANALYSIS_LIMITS.minFrameWidth ||
        width > ANALYSIS_LIMITS.maxFrameWidth
      )
        fail(
          `width must be an integer from ${ANALYSIS_LIMITS.minFrameWidth} to ${ANALYSIS_LIMITS.maxFrameWidth}`,
        );
      request.width = width;
    }
    return request;
  });
}

const CUT_PLAN_KEYS = [
  "source",
  "label",
  "basedOn",
  "order",
  "drop",
  "allowDropMust",
  "hook",
  "removeIssues",
  "keepIssues",
  "removeFillers",
  "maxPause",
  "pauseKeep",
  "targetDuration",
] as const;

export function parseCutPlanRequest(raw: unknown): ParsedAnalysis<CutPlanRequest> {
  return parse(() => {
    const value = body(raw);
    onlyKeys(value, CUT_PLAN_KEYS, "");
    const request: CutPlanRequest = {
      source: str(value.source, "source", ANALYSIS_LIMITS.pathChars),
    };
    if (value.label !== undefined)
      request.label = str(value.label, "label", ANALYSIS_LIMITS.titleChars);
    if (value.basedOn !== undefined)
      request.basedOn = str(value.basedOn, "basedOn", ANALYSIS_LIMITS.idChars);
    if (value.order !== undefined)
      request.order = ids(value.order, "order", ANALYSIS_LIMITS.orderEntries);
    if (value.drop !== undefined)
      request.drop = ids(value.drop, "drop", ANALYSIS_LIMITS.orderEntries);
    if (value.allowDropMust !== undefined)
      request.allowDropMust = ids(
        value.allowDropMust,
        "allowDropMust",
        ANALYSIS_LIMITS.orderEntries,
      );
    if (value.hook !== undefined) {
      if (value.hook === null) request.hook = null;
      else {
        const hook = value.hook;
        if (!isRecord(hook)) fail("hook must be {firstSentence, lastSentence} or null");
        onlyKeys(hook, ["firstSentence", "lastSentence"], "hook.");
        request.hook = {
          firstSentence: str(hook.firstSentence, "hook.firstSentence", ANALYSIS_LIMITS.idChars),
          lastSentence: str(hook.lastSentence, "hook.lastSentence", ANALYSIS_LIMITS.idChars),
        };
      }
    }
    if (value.removeIssues !== undefined) {
      request.removeIssues =
        value.removeIssues === "auto"
          ? "auto"
          : ids(value.removeIssues, "removeIssues", ANALYSIS_LIMITS.issueIds);
    }
    if (value.keepIssues !== undefined)
      request.keepIssues = ids(value.keepIssues, "keepIssues", ANALYSIS_LIMITS.issueIds);
    if (value.removeFillers !== undefined)
      request.removeFillers = bool(value.removeFillers, "removeFillers");
    for (const key of ["maxPause", "pauseKeep"] as const) {
      const entry = value[key];
      if (entry === undefined) continue;
      const seconds = time(entry, key);
      if (seconds > ANALYSIS_LIMITS.maxPause)
        fail(`${key} exceeds ${ANALYSIS_LIMITS.maxPause} seconds`);
      request[key] = seconds;
    }
    if (request.maxPause !== undefined && request.maxPause < 0.1)
      fail("maxPause must be at least 0.1 seconds");
    if (
      request.maxPause !== undefined &&
      request.pauseKeep !== undefined &&
      request.pauseKeep > request.maxPause
    )
      fail("pauseKeep must not exceed maxPause");
    if (value.targetDuration !== undefined) {
      const target = time(value.targetDuration, "targetDuration");
      if (target === 0) fail("targetDuration must be greater than 0");
      request.targetDuration = target;
    }
    return request;
  });
}
