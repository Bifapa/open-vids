import {
  VOICE_SCRIPT_ISSUE_CODES,
  isRecord,
  isVoiceDialectId,
  isVoiceProviderId,
  type VoiceCheckResult,
  type VoiceDialect,
  type VoiceEstimate,
  type VoicePreset,
  type VoiceProviderInfo,
  type VoiceScriptIssue,
  type VoiceScriptView,
  type VoiceSynthesisProgress,
  type VoiceSynthesisResult,
  type VoiceTake,
} from "@hyperframes/agent-protocol";

/**
 * Structural checks of what Studio's voice routes answer: the fields the runtime reads are verified, so a server that
 * answers something else is reported as an invalid response instead of crashing a tool call later.
 */

const isString = (value: unknown): value is string => typeof value === "string";
const isNumber = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);
const isStringArray = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every(isString);

export function isVoicePreset(value: unknown): value is VoicePreset {
  return (
    isRecord(value) &&
    isString(value.id) &&
    isString(value.name) &&
    isVoiceProviderId(value.providerId) &&
    isString(value.model) &&
    isRecord(value.voice) &&
    isString(value.voice.id) &&
    isString(value.voice.name) &&
    isString(value.style)
  );
}

export function isVoiceProviderInfo(value: unknown): value is VoiceProviderInfo {
  return (
    isRecord(value) &&
    isVoiceProviderId(value.id) &&
    isString(value.name) &&
    isString(value.model) &&
    isString(value.agentRules) &&
    typeof value.configured === "boolean"
  );
}

export function isVoiceDialect(value: unknown): value is VoiceDialect {
  return (
    isRecord(value) &&
    isVoiceDialectId(value.id) &&
    isString(value.name) &&
    isString(value.style) &&
    isNumber(value.styleMaxChars) &&
    isRecord(value.tags) &&
    isString(value.tags.syntax) &&
    isStringArray(value.tags.allowed) &&
    typeof value.tags.open === "boolean" &&
    isString(value.pauses) &&
    isString(value.emphasis) &&
    isNumber(value.maxChars) &&
    isNumber(value.maxSpeakers) &&
    typeof value.numbersAsWords === "boolean" &&
    isStringArray(value.guidance) &&
    isString(value.checkedAt)
  );
}

export function isVoiceTake(value: unknown): value is VoiceTake {
  return (
    isRecord(value) &&
    isString(value.id) &&
    isString(value.file) &&
    isNumber(value.start) &&
    isNumber(value.end)
  );
}

function isVoiceLineView(value: unknown): boolean {
  return (
    isRecord(value) &&
    isString(value.id) &&
    isString(value.text) &&
    isString(value.speakerText) &&
    isString(value.style) &&
    Array.isArray(value.takes) &&
    value.takes.every(isVoiceTake) &&
    (value.selectedTakeId === null || isString(value.selectedTakeId)) &&
    typeof value.textChanged === "boolean" &&
    (value.durationSeconds === null || isNumber(value.durationSeconds))
  );
}

export function isVoiceScriptView(value: unknown): value is VoiceScriptView {
  return (
    isRecord(value) &&
    (value.language === null || isString(value.language)) &&
    (value.voice === null || isVoicePreset(value.voice)) &&
    (value.dialect === null || isVoiceDialect(value.dialect)) &&
    Array.isArray(value.lines) &&
    value.lines.every(isVoiceLineView)
  );
}

export function isVoiceScriptIssue(value: unknown): value is VoiceScriptIssue {
  return (
    isRecord(value) &&
    (value.lineId === null || isString(value.lineId)) &&
    VOICE_SCRIPT_ISSUE_CODES.some((code) => code === value.code) &&
    (value.severity === "error" || value.severity === "warning") &&
    isString(value.message)
  );
}

function isVoiceEstimate(value: unknown): value is VoiceEstimate {
  return (
    isRecord(value) &&
    isNumber(value.lines) &&
    isNumber(value.cachedLines) &&
    isNumber(value.requests) &&
    isNumber(value.seconds) &&
    (value.usdCost === null || isNumber(value.usdCost))
  );
}

export function isVoiceCheckResult(value: unknown): value is VoiceCheckResult {
  return (
    isRecord(value) &&
    typeof value.ok === "boolean" &&
    Array.isArray(value.issues) &&
    value.issues.every(isVoiceScriptIssue) &&
    isVoiceEstimate(value.estimate) &&
    isVoiceDialect(value.dialect)
  );
}

export function isVoiceSynthesisResult(value: unknown): value is VoiceSynthesisResult {
  return (
    isRecord(value) &&
    Array.isArray(value.lines) &&
    value.lines.every(
      (line) =>
        isRecord(line) &&
        isString(line.lineId) &&
        isVoiceTake(line.take) &&
        typeof line.cached === "boolean",
    ) &&
    isNumber(value.requests) &&
    (value.usdCost === null || isNumber(value.usdCost)) &&
    isStringArray(value.notes)
  );
}

export function isVoiceSynthesisProgress(value: unknown): value is VoiceSynthesisProgress {
  return (
    isRecord(value) &&
    isString(value.requestId) &&
    ["running", "done", "failed", "cancelled"].some((state) => state === value.state) &&
    isNumber(value.done) &&
    isNumber(value.total)
  );
}
