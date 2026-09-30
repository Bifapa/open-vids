import {
  isRecord,
  isStoryView,
  type StoryBuildResult,
  type StoryEditResponse,
  type StoryRebuildResult,
} from "@hyperframes/agent-protocol";

export { isStoryView };

/**
 * Shape checks for what the story service sends back. The service is OpenVids-owned, so these verify the fields the
 * runtime relies on rather than re-validating every value.
 */

const isString = (value: unknown): value is string => typeof value === "string";
const isNumber = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);

const isStringList = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every(isString);

const isManualEdit = (value: unknown): boolean =>
  isRecord(value) &&
  isString(value.clip) &&
  isString(value.label) &&
  isString(value.kind) &&
  isString(value.by) &&
  isStringList(value.fields);

const isManualEditList = (value: unknown): boolean =>
  Array.isArray(value) && value.every(isManualEdit);

export function isStoryEditResponse(value: unknown): value is StoryEditResponse {
  return (
    isRecord(value) &&
    isStoryView(value.view) &&
    Array.isArray(value.results) &&
    value.results.every(
      (result) =>
        isRecord(result) && isString(result.op) && (result.id === null || isString(result.id)),
    )
  );
}

export function isStoryBuildResult(value: unknown): value is StoryBuildResult {
  return (
    isRecord(value) &&
    typeof value.dryRun === "boolean" &&
    isString(value.composition) &&
    isString(value.timelineVersion) &&
    isNumber(value.duration) &&
    Array.isArray(value.chapters) &&
    value.chapters.every(
      (chapter) =>
        isRecord(chapter) &&
        isString(chapter.node) &&
        isNumber(chapter.start) &&
        isNumber(chapter.end) &&
        isNumber(chapter.clips),
    ) &&
    Array.isArray(value.materials) &&
    isNumber(value.removedClips) &&
    isNumber(value.keptClips) &&
    Array.isArray(value.warnings) &&
    value.warnings.every(isString) &&
    isManualEditList(value.replacedEdits) &&
    isStringList(value.keptLocked) &&
    isStoryView(value.view)
  );
}

export function isStoryRebuildResult(value: unknown): value is StoryRebuildResult {
  return (
    isRecord(value) &&
    typeof value.dryRun === "boolean" &&
    typeof value.changed === "boolean" &&
    isString(value.composition) &&
    isString(value.timelineVersion) &&
    isNumber(value.duration) &&
    isRecord(value.report) &&
    isStringList(value.rebuilt) &&
    isStringList(value.removed) &&
    isStringList(value.moved) &&
    isManualEditList(value.keptEdits) &&
    isManualEditList(value.replacedEdits) &&
    isStringList(value.keptLocked) &&
    isStringList(value.warnings) &&
    isStoryView(value.view)
  );
}
