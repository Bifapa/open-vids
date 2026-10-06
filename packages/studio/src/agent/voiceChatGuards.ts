import {
  isRecord,
  isVoicePilotRequest,
  isVoiceSetupRequest,
  type AnswerVoicePilotResponse,
  type AnswerVoiceSetupResponse,
  type AssistantPart,
  type VoicePilotPart,
  type VoicePilotRequest,
  type VoiceSetupPart,
  type VoiceSetupRequest,
} from "@hyperframes/agent-protocol";

/**
 * A voice-setup request as the card reads it. The card looks `state` up as a key and renders the strings, so a request
 * the runtime worded differently (a newer runtime, a damaged log) is dropped instead of crashing the chat; the
 * optional answer fields must be whole when they are there.
 */
export function isWholeVoiceSetup(value: unknown): value is VoiceSetupRequest {
  return (
    isVoiceSetupRequest(value) &&
    (value.presetId === undefined || typeof value.presetId === "string") &&
    (value.presetName === undefined || typeof value.presetName === "string") &&
    (value.answeredAt === undefined || typeof value.answeredAt === "number")
  );
}

/** A pilot request as the card reads it: the take's range is numbers, the estimate is a number or null. */
export function isWholeVoicePilot(value: unknown): value is VoicePilotRequest {
  return (
    isVoicePilotRequest(value) &&
    Number.isFinite(value.start) &&
    Number.isFinite(value.end) &&
    Number.isFinite(value.remainingLines) &&
    (value.remainingUsdCost === null ||
      (typeof value.remainingUsdCost === "number" && Number.isFinite(value.remainingUsdCost))) &&
    (value.feedback === undefined || typeof value.feedback === "string") &&
    (value.answeredAt === undefined || typeof value.answeredAt === "number")
  );
}

/** A message part that is a well-formed voice-setup card. */
export function isVoiceSetupPart(part: AssistantPart): part is VoiceSetupPart {
  return part.type === "voice-setup" && isWholeVoiceSetup(part.setup);
}

/** A message part that is a well-formed pilot-line card. */
export function isVoicePilotPart(part: AssistantPart): part is VoicePilotPart {
  return part.type === "voice-pilot" && isWholeVoicePilot(part.pilot);
}

export function isAnswerVoiceSetupResponse(value: unknown): value is AnswerVoiceSetupResponse {
  return isRecord(value) && isWholeVoiceSetup(value.setup);
}

export function isAnswerVoicePilotResponse(value: unknown): value is AnswerVoicePilotResponse {
  return isRecord(value) && isWholeVoicePilot(value.pilot);
}
