import {
  isVoiceErrorCode,
  type CodedMessageParams,
  type VoiceErrorCode,
} from "@hyperframes/agent-protocol";
import { t, type TranslationKey } from "../i18n";

const MESSAGE_KEYS = {
  invalid_request: "voice.error.invalid_request",
  not_found: "voice.error.not_found",
  not_configured: "voice.error.not_configured",
  invalid_key: "voice.error.invalid_key",
  rate_limited: "voice.error.rate_limited",
  quota_exhausted: "voice.error.quota_exhausted",
  not_audio: "voice.error.not_audio",
  dialect_violation: "voice.error.dialect_violation",
  unsupported: "voice.error.unsupported",
  provider_error: "voice.error.provider_error",
  provider_unreachable: "voice.error.provider_unreachable",
  desktop_only: "voice.error.desktop_only",
  transcription_unavailable: "voice.error.transcription_unavailable",
  cancelled: "voice.error.cancelled",
  conflict: "voice.error.conflict",
} as const satisfies Record<VoiceErrorCode, TranslationKey>;

/** What the service sent back, cut to a line the card can show. */
function excerpt(value: string | number | undefined, max: number): string {
  const text = String(value ?? "")
    .replace(/\s+/g, " ")
    .trim();
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/**
 * Studio's wording for a voice error. The server's `message` is English and concrete; it fills the places where the
 * detail is the useful part (a rejected request, what the provider said) and is the whole answer for a code this
 * Studio does not know.
 */
export function describeVoiceError(
  code: string | null,
  message: string,
  params: CodedMessageParams | undefined,
  retryAfterSeconds?: number,
): string {
  if (code === null || !isVoiceErrorCode(code)) return message;
  if (code === "not_audio") {
    const body = excerpt(params?.body, 200);
    return t(MESSAGE_KEYS[code], {
      contentType: excerpt(params?.contentType, 80) || "?",
      body,
      hasBody: body === "" ? "no" : "yes",
    });
  }
  if (code === "rate_limited") {
    if (params?.daily === 1) return t("voice.error.rate_limited.daily");
    const seconds = params?.retryAfterSeconds ?? retryAfterSeconds;
    if (typeof seconds === "number" && seconds > 0)
      return t("voice.error.rate_limited.retry", { seconds: Math.ceil(seconds) });
  }
  return t(MESSAGE_KEYS[code], { message: excerpt(message, 300) });
}
