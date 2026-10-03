import {
  ASSET_KINDS,
  CLIP_KINDS,
  PRESET_KINDS,
  isAssetRange,
  isRecord,
  type ApplyEditsResponse,
  type PresetInfo,
  type ProjectAsset,
  type ProjectInventory,
  type TimelineSnapshot,
} from "@hyperframes/agent-protocol";

/**
 * Shape checks for what the editing service sends back. The service is OpenVids-owned, so these verify the fields the
 * runtime relies on (ids, kinds, times, paths) rather than re-validating every value.
 */

const isString = (value: unknown): value is string => typeof value === "string";
const isNumber = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);
const isNullable = <T>(check: (value: unknown) => value is T) => {
  return (value: unknown): value is T | null => value === null || check(value);
};
const isStringOrNull = isNullable(isString);
const isNumberOrNull = isNullable(isNumber);

function isArrayOf<T>(value: unknown, check: (item: unknown) => item is T): value is T[] {
  return Array.isArray(value) && value.every(check);
}

export function isProjectAsset(value: unknown): value is ProjectAsset {
  return (
    isRecord(value) &&
    isString(value.path) &&
    ASSET_KINDS.some((kind) => kind === value.kind) &&
    isNumber(value.bytes) &&
    isNumberOrNull(value.duration) &&
    isNumberOrNull(value.width) &&
    isNumberOrNull(value.height) &&
    (value.range === undefined || value.range === null || isAssetRange(value.range))
  );
}

export function isProjectInventory(value: unknown): value is ProjectInventory {
  return (
    isRecord(value) &&
    isArrayOf(
      value.compositions,
      (item): item is ProjectInventory["compositions"][number] =>
        isRecord(item) &&
        isString(item.path) &&
        isNumber(item.width) &&
        isNumber(item.height) &&
        isNumber(item.duration) &&
        isNumber(item.clipCount),
    ) &&
    isArrayOf(value.assets, isProjectAsset) &&
    isArrayOf(
      value.renders,
      (item): item is ProjectInventory["renders"][number] =>
        isRecord(item) && isString(item.path) && isNumber(item.bytes) && isNumber(item.createdAt),
    )
  );
}

export function isTimelineSnapshot(value: unknown): value is TimelineSnapshot {
  return (
    isRecord(value) &&
    isRecord(value.composition) &&
    isString(value.composition.path) &&
    isNumber(value.composition.width) &&
    isNumber(value.composition.height) &&
    isNumber(value.composition.duration) &&
    isString(value.version) &&
    isArrayOf(
      value.tracks,
      (item): item is TimelineSnapshot["tracks"][number] =>
        isRecord(item) && isNumber(item.index) && isArrayOf(item.clipIds, isString),
    ) &&
    isArrayOf(
      value.clips,
      (item): item is TimelineSnapshot["clips"][number] =>
        isRecord(item) &&
        isString(item.id) &&
        CLIP_KINDS.some((kind) => kind === item.kind) &&
        isString(item.label) &&
        isNumber(item.start) &&
        isNumber(item.duration) &&
        isNumber(item.end) &&
        isNumber(item.track) &&
        isStringOrNull(item.src) &&
        isStringOrNull(item.domId) &&
        isNumberOrNull(item.volume) &&
        typeof item.muted === "boolean" &&
        typeof item.locked === "boolean",
    )
  );
}

export function isApplyEditsResponse(value: unknown): value is ApplyEditsResponse {
  return (
    isRecord(value) &&
    isTimelineSnapshot(value.timeline) &&
    isArrayOf(
      value.results,
      (item): item is ApplyEditsResponse["results"][number] =>
        isRecord(item) &&
        isString(item.op) &&
        isStringOrNull(item.clipId) &&
        isStringOrNull(item.newClipId),
    ) &&
    isArrayOf(value.changedFiles, isString)
  );
}

export function isPresetInfo(value: unknown): value is PresetInfo {
  return (
    isRecord(value) &&
    isString(value.name) &&
    PRESET_KINDS.some((kind) => kind === value.kind) &&
    isString(value.title) &&
    isString(value.description) &&
    isArrayOf(value.tags, isString) &&
    isNumberOrNull(value.duration)
  );
}

export const isPresetList = (value: unknown): value is PresetInfo[] =>
  isArrayOf(value, isPresetInfo);
