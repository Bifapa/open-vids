import {
  VOICE_KINDS,
  VOICE_SCRIPT_ISSUE_CODES,
  isRecord,
  isVoiceDialectId,
  isVoiceProviderId,
  type DesignVoiceResult,
  type VoiceAudioRef,
  type VoiceCatalogEntry,
  type VoiceCatalogFilter,
  type VoiceCatalogPage,
  type VoiceCheckResult,
  type VoiceControl,
  type VoiceDialect,
  type VoiceEstimate,
  type VoiceKeyCheckResult,
  type VoiceLineView,
  type VoiceModelInfo,
  type VoicePreset,
  type VoicePresetSample,
  type VoicePresetVoice,
  type VoiceProviderControls,
  type VoiceProviderInfo,
  type VoiceSampleResult,
  type VoiceScriptIssue,
  type VoiceScriptView,
  type VoiceSynthesisLineResult,
  type VoiceSynthesisProgress,
  type VoiceSynthesisResult,
  type VoiceTake,
} from "@hyperframes/agent-protocol";

/**
 * Guards for what the voice routes answer. Each one checks exactly what Studio dereferences (lookup keys, arrays it
 * walks, strings it renders), so an answer a newer or damaged server worded differently is dropped with "unexpected
 * answer" instead of crashing a window.
 */

type Guard<T> = (value: unknown) => value is T;

const isString = (value: unknown): value is string => typeof value === "string";
const isNumber = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);
const isBoolean = (value: unknown): value is boolean => typeof value === "boolean";

function arrayOf<T>(guard: Guard<T>): Guard<T[]> {
  return (value): value is T[] => Array.isArray(value) && value.every(guard);
}

function nullable<T>(guard: Guard<T>): Guard<T | null> {
  return (value): value is T | null => value === null || guard(value);
}

const isStringList = arrayOf(isString);

function oneOf<T extends string>(known: readonly T[]): Guard<T> {
  return (value): value is T => typeof value === "string" && known.some((item) => item === value);
}

const isConnector = oneOf(["gemini", "openai_compatible", "elevenlabs"] as const);
const isProviderNote = oneOf(["catalog_needs_google_key", "free_tier_terms"] as const);
const isVoiceKind = oneOf(VOICE_KINDS);
const isSeverity = oneOf(["error", "warning"] as const);

export function isVoiceAudioRef(value: unknown): value is VoiceAudioRef {
  return (
    isRecord(value) &&
    isString(value.url) &&
    isString(value.hash) &&
    isNumber(value.durationSeconds) &&
    (value.mimeType === "audio/wav" || value.mimeType === "audio/mpeg")
  );
}

export function isVoiceProviderInfo(value: unknown): value is VoiceProviderInfo {
  return (
    isRecord(value) &&
    isVoiceProviderId(value.id) &&
    isConnector(value.connector) &&
    isString(value.name) &&
    isString(value.baseUrl) &&
    isString(value.model) &&
    isBoolean(value.hasKey) &&
    isBoolean(value.keyRequired) &&
    isBoolean(value.configured) &&
    isString(value.voice) &&
    isString(value.agentRules) &&
    arrayOf(isProviderNote)(value.notes)
  );
}

function isCatalogFilter(value: unknown): value is VoiceCatalogFilter {
  return isRecord(value) && isString(value.id) && nullable(isStringList)(value.options);
}

function isVoiceControl(value: unknown): value is VoiceControl {
  if (!isRecord(value)) return false;
  switch (value.kind) {
    case "catalog":
      return (
        arrayOf(isCatalogFilter)(value.filters) &&
        (value.preview === "audio_url" || value.preview === "synthesize")
      );
    case "voice_text":
    case "voice_design":
      return isNumber(value.maxChars);
    case "slider":
      return (
        isString(value.id) &&
        isNumber(value.min) &&
        isNumber(value.max) &&
        isNumber(value.step) &&
        isNumber(value.default) &&
        (value.values === undefined || arrayOf(isNumber)(value.values))
      );
    case "toggle":
      return isString(value.id) && isBoolean(value.default);
    case "style":
      return (
        (value.target === "style" || value.target === "instructions") && isNumber(value.maxChars)
      );
    default:
      return false;
  }
}

function isVoiceModelInfo(value: unknown): value is VoiceModelInfo {
  return (
    isRecord(value) &&
    isString(value.id) &&
    isString(value.name) &&
    isVoiceDialectId(value.dialect) &&
    isBoolean(value.dialectApproximate) &&
    nullable(isNumber)(value.usdPerMinute) &&
    (value.maxChars === undefined || isNumber(value.maxChars))
  );
}

export function isVoiceDialect(value: unknown): value is VoiceDialect {
  if (!isRecord(value) || !isRecord(value.tags)) return false;
  return (
    isVoiceDialectId(value.id) &&
    isString(value.name) &&
    oneOf(["style", "instructions", "none"] as const)(value.style) &&
    isNumber(value.styleMaxChars) &&
    oneOf(["angle", "square", "none"] as const)(value.tags.syntax) &&
    isStringList(value.tags.allowed) &&
    isBoolean(value.tags.open) &&
    isString(value.pauses) &&
    isString(value.emphasis) &&
    isNumber(value.maxChars) &&
    isNumber(value.maxSpeakers) &&
    isBoolean(value.numbersAsWords) &&
    isStringList(value.guidance) &&
    isString(value.checkedAt) &&
    isStringList(value.sources)
  );
}

export function isVoiceProviderControls(value: unknown): value is VoiceProviderControls {
  return (
    isRecord(value) &&
    isVoiceProviderInfo(value.provider) &&
    arrayOf(isVoiceModelInfo)(value.models) &&
    isString(value.model) &&
    arrayOf(isVoiceControl)(value.controls) &&
    isVoiceDialect(value.dialect)
  );
}

function isCatalogEntry(value: unknown): value is VoiceCatalogEntry {
  return (
    isRecord(value) &&
    isString(value.id) &&
    isString(value.name) &&
    nullable(isString)(value.description) &&
    isRecord(value.labels) &&
    Object.values(value.labels).every(isString) &&
    isStringList(value.languages) &&
    nullable(isString)(value.previewUrl) &&
    isVoiceKind(value.kind)
  );
}

export function isVoiceCatalogPage(value: unknown): value is VoiceCatalogPage {
  return (
    isRecord(value) &&
    arrayOf(isCatalogEntry)(value.voices) &&
    nullable(isString)(value.nextPageToken)
  );
}

export function isDesignVoiceResult(value: unknown): value is DesignVoiceResult {
  return isRecord(value) && isCatalogEntry(value.voice) && nullable(isVoiceAudioRef)(value.sample);
}

function isPresetVoice(value: unknown): value is VoicePresetVoice {
  return (
    isRecord(value) &&
    isString(value.id) &&
    isString(value.name) &&
    isVoiceKind(value.kind) &&
    (value.language === undefined || isString(value.language)) &&
    (value.description === undefined || isString(value.description))
  );
}

function isPresetSample(value: unknown): value is VoicePresetSample {
  return (
    isRecord(value) &&
    isString(value.text) &&
    isVoiceAudioRef(value.audio) &&
    isNumber(value.createdAt)
  );
}

function isSettings(value: unknown): value is Record<string, number | boolean> {
  return (
    isRecord(value) && Object.values(value).every((entry) => isNumber(entry) || isBoolean(entry))
  );
}

export function isVoicePreset(value: unknown): value is VoicePreset {
  return (
    isRecord(value) &&
    isString(value.id) &&
    isString(value.name) &&
    isVoiceProviderId(value.providerId) &&
    isString(value.model) &&
    isPresetVoice(value.voice) &&
    isString(value.style) &&
    isSettings(value.settings) &&
    nullable(isPresetSample)(value.sample) &&
    isNumber(value.createdAt) &&
    isNumber(value.updatedAt)
  );
}

export function isVoiceSampleResult(value: unknown): value is VoiceSampleResult {
  return (
    isRecord(value) &&
    isVoiceAudioRef(value.audio) &&
    isBoolean(value.cached) &&
    nullable(isNumber)(value.usdCost)
  );
}

export function isVoiceKeyCheckResult(value: unknown): value is VoiceKeyCheckResult {
  return isRecord(value) && value.ok === true && nullable(isVoiceAudioRef)(value.sample);
}

function isTake(value: unknown): value is VoiceTake {
  return (
    isRecord(value) &&
    isString(value.id) &&
    isString(value.file) &&
    isNumber(value.start) &&
    isNumber(value.end) &&
    isString(value.speakerText) &&
    isString(value.style) &&
    isString(value.requestHash)
  );
}

function isLineView(value: unknown): value is VoiceLineView {
  return (
    isRecord(value) &&
    isString(value.id) &&
    isString(value.text) &&
    isString(value.speakerText) &&
    isString(value.style) &&
    nullable(isString)(value.presetId) &&
    arrayOf(isTake)(value.takes) &&
    nullable(isString)(value.selectedTakeId) &&
    isBoolean(value.textChanged) &&
    nullable(isNumber)(value.durationSeconds) &&
    isStringList(value.clipIds)
  );
}

export function isVoiceScriptView(value: unknown): value is VoiceScriptView {
  return (
    isRecord(value) &&
    nullable(isString)(value.language) &&
    nullable(isVoicePreset)(value.voice) &&
    nullable(isVoiceDialect)(value.dialect) &&
    arrayOf(isLineView)(value.lines)
  );
}

function isIssue(value: unknown): value is VoiceScriptIssue {
  return (
    isRecord(value) &&
    nullable(isString)(value.lineId) &&
    oneOf(VOICE_SCRIPT_ISSUE_CODES)(value.code) &&
    isSeverity(value.severity) &&
    isString(value.message)
  );
}

function isEstimate(value: unknown): value is VoiceEstimate {
  return (
    isRecord(value) &&
    isNumber(value.lines) &&
    isNumber(value.cachedLines) &&
    isNumber(value.requests) &&
    isNumber(value.seconds) &&
    nullable(isNumber)(value.usdCost) &&
    isBoolean(value.scene) &&
    isNumber(value.charsPerSecond)
  );
}

export function isVoiceCheckResult(value: unknown): value is VoiceCheckResult {
  return (
    isRecord(value) &&
    isBoolean(value.ok) &&
    arrayOf(isIssue)(value.issues) &&
    isEstimate(value.estimate) &&
    isVoiceDialect(value.dialect)
  );
}

function isSynthesisLine(value: unknown): value is VoiceSynthesisLineResult {
  return (
    isRecord(value) &&
    isString(value.lineId) &&
    isTake(value.take) &&
    isBoolean(value.cached) &&
    isBoolean(value.duplicate)
  );
}

export function isVoiceSynthesisResult(value: unknown): value is VoiceSynthesisResult {
  return (
    isRecord(value) &&
    arrayOf(isSynthesisLine)(value.lines) &&
    isNumber(value.requests) &&
    nullable(isNumber)(value.usdCost) &&
    isStringList(value.notes)
  );
}

export function isVoiceSynthesisProgress(value: unknown): value is VoiceSynthesisProgress {
  return (
    isRecord(value) &&
    isString(value.requestId) &&
    oneOf(["running", "done", "failed", "cancelled"] as const)(value.state) &&
    isNumber(value.done) &&
    isNumber(value.total) &&
    nullable(isString)(value.lineId) &&
    (value.waitingUntil === undefined || isNumber(value.waitingUntil))
  );
}

export const isProvidersAnswer: Guard<{ providers: VoiceProviderInfo[] }> = (
  value,
): value is { providers: VoiceProviderInfo[] } =>
  isRecord(value) && arrayOf(isVoiceProviderInfo)(value.providers);

export const isProviderAnswer: Guard<{ provider: VoiceProviderInfo }> = (
  value,
): value is { provider: VoiceProviderInfo } =>
  isRecord(value) && isVoiceProviderInfo(value.provider);

export const isPresetsAnswer: Guard<{ presets: VoicePreset[] }> = (
  value,
): value is { presets: VoicePreset[] } => isRecord(value) && arrayOf(isVoicePreset)(value.presets);

export const isPresetAnswer: Guard<{ preset: VoicePreset }> = (
  value,
): value is { preset: VoicePreset } => isRecord(value) && isVoicePreset(value.preset);

export const isDialectsAnswer: Guard<{ dialects: VoiceDialect[] }> = (
  value,
): value is { dialects: VoiceDialect[] } =>
  isRecord(value) && arrayOf(isVoiceDialect)(value.dialects);

export const isOkAnswer: Guard<{ ok: true }> = (value): value is { ok: true } =>
  isRecord(value) && value.ok === true;

export const isCancelAnswer: Guard<{ requestId: string; state: string }> = (
  value,
): value is { requestId: string; state: string } =>
  isRecord(value) && isString(value.requestId) && isString(value.state);

/** What `POST /editing/apply` answers for `captions_from_voiceover`: the files written and the batch's warnings. */
export interface CaptionsApplyAnswer {
  changedFiles: string[];
  warnings?: string[];
}

export const isCaptionsApplyAnswer: Guard<CaptionsApplyAnswer> = (
  value,
): value is CaptionsApplyAnswer =>
  isRecord(value) &&
  isStringList(value.changedFiles) &&
  (value.warnings === undefined || isStringList(value.warnings));
