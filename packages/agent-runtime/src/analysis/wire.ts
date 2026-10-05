import {
  isRecord,
  type AnalysisJob,
  type AnalysisOverview,
  type CutPlan,
  type CutPlanSummary,
  type FramesResponse,
  type SegmentMap,
  type ShotMap,
  type SilenceMap,
  type TimeRange,
  type TranscriptView,
  type VisionAnalysis,
} from "@hyperframes/agent-protocol";

/**
 * Shape checks for what the analysis service sends back. The service is OpenVids-owned, so these verify the fields the
 * runtime relies on (ids, times, versions, lists) rather than re-validating every value.
 */

const isString = (value: unknown): value is string => typeof value === "string";
const isNumber = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);

function isArrayOf<T>(value: unknown, check: (item: unknown) => item is T): value is T[] {
  return Array.isArray(value) && value.every(check);
}

const isRange = (value: unknown): value is TimeRange =>
  isRecord(value) && isNumber(value.start) && isNumber(value.end);

const JOB_STATUSES = ["running", "completed", "failed", "cancelled"];

export function isAnalysisJob(value: unknown): value is AnalysisJob {
  return (
    isRecord(value) &&
    isString(value.id) &&
    isString(value.source) &&
    JOB_STATUSES.some((status) => status === value.status) &&
    isNumber(value.progress) &&
    Array.isArray(value.results) &&
    value.results.every(
      (result) =>
        isRecord(result) &&
        isString(result.stage) &&
        isString(result.outcome) &&
        isNumber(result.seconds),
    )
  );
}

export function isAnalysisOverview(value: unknown): value is AnalysisOverview {
  return (
    isRecord(value) &&
    isRecord(value.status) &&
    isString(value.status.source) &&
    Array.isArray(value.status.stages) &&
    Array.isArray(value.visionTargets) &&
    Array.isArray(value.cuts)
  );
}

export function isTranscriptView(value: unknown): value is TranscriptView {
  return (
    isRecord(value) &&
    isString(value.version) &&
    isNumber(value.from) &&
    isNumber(value.to) &&
    isNumber(value.totalSentences) &&
    isArrayOf(
      value.sentences,
      (sentence): sentence is TranscriptView["sentences"][number] =>
        isRecord(sentence) &&
        isString(sentence.id) &&
        isNumber(sentence.start) &&
        isNumber(sentence.end) &&
        isString(sentence.text),
    )
  );
}

export function isFramesResponse(value: unknown): value is FramesResponse {
  return (
    isRecord(value) &&
    isArrayOf(
      value.frames,
      (frame): frame is FramesResponse["frames"][number] =>
        isRecord(frame) &&
        isNumber(frame.time) &&
        frame.mimeType === "image/jpeg" &&
        isString(frame.data) &&
        typeof frame.cached === "boolean",
    )
  );
}

export function isCutPlanSummary(value: unknown): value is CutPlanSummary {
  return (
    isRecord(value) &&
    isString(value.id) &&
    isString(value.source) &&
    isString(value.label) &&
    isRecord(value.stats) &&
    isNumber(value.stats.cutDuration) &&
    isNumber(value.stats.sourceDuration)
  );
}

export const isCutPlanSummaryList = (value: unknown): value is CutPlanSummary[] =>
  isArrayOf(value, isCutPlanSummary);

export function isCutPlan(value: unknown): value is CutPlan {
  return (
    isCutPlanSummary(value) &&
    isRecord(value) &&
    isRecord(value.request) &&
    isString(value.transcriptVersion) &&
    isArrayOf(
      value.ranges,
      (range): range is CutPlan["ranges"][number] =>
        isRecord(range) && isNumber(range.from) && isNumber(range.to) && isNumber(range.at),
    ) &&
    Array.isArray(value.removed) &&
    isArrayOf(value.warnings, isString) &&
    (value.outOfDate === undefined || isString(value.outOfDate))
  );
}

export function isSegmentMap(value: unknown): value is SegmentMap {
  return (
    isRecord(value) &&
    (value.origin === "draft" || value.origin === "semantic") &&
    isString(value.transcriptVersion) &&
    Array.isArray(value.segments)
  );
}

export function isVisionAnalysis(value: unknown): value is VisionAnalysis {
  return isRecord(value) && Array.isArray(value.notes) && Array.isArray(value.inspectedFrames);
}

export function isSilenceMap(value: unknown): value is SilenceMap {
  return isRecord(value) && isArrayOf(value.silences, isRange) && isNumber(value.silenceSeconds);
}

export function isShotMap(value: unknown): value is ShotMap {
  return isRecord(value) && isArrayOf(value.shots, isRange) && Array.isArray(value.problems);
}
