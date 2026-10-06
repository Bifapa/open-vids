import type { VoiceErrorBody, VoiceErrorCode, VoiceScriptIssue } from "@hyperframes/agent-protocol";

export type VoiceErrorParams = Record<string, string | number>;

/** HTTP status of a voice error code (the table of the voiceover spec). */
export function voiceStatus(
  code: VoiceErrorCode,
): 400 | 401 | 402 | 403 | 404 | 409 | 422 | 429 | 502 | 504 {
  switch (code) {
    case "invalid_request":
    case "unsupported":
      return 400;
    case "invalid_key":
      return 401;
    case "desktop_only":
      return 403;
    case "quota_exhausted":
      return 402;
    case "not_found":
      return 404;
    case "not_configured":
    case "transcription_unavailable":
    case "cancelled":
    case "conflict":
      return 409;
    case "dialect_violation":
      return 422;
    case "rate_limited":
      return 429;
    case "not_audio":
    case "provider_error":
      return 502;
    case "provider_unreachable":
      return 504;
  }
}

/**
 * A refused or failed voice operation. Carries the wire error the routes answer with; `status` follows
 * {@link voiceStatus} unless the caller names one (a refused origin answers 403 with `invalid_request`).
 */
export class VoiceFailure extends Error {
  readonly code: VoiceErrorCode;
  readonly params?: VoiceErrorParams;
  readonly issues?: VoiceScriptIssue[];
  readonly status: number;

  constructor(
    code: VoiceErrorCode,
    message: string,
    params?: VoiceErrorParams,
    status?: number,
    issues?: VoiceScriptIssue[],
  ) {
    super(message);
    this.name = "VoiceFailure";
    this.code = code;
    if (params) this.params = params;
    if (issues) this.issues = issues;
    this.status = status ?? voiceStatus(code);
  }
}

export function isVoiceFailure(value: unknown): value is VoiceFailure {
  return value instanceof VoiceFailure;
}

export function voiceErrorBody(failure: VoiceFailure): VoiceErrorBody {
  return {
    error: {
      code: failure.code,
      message: failure.message,
      ...(failure.params && { params: failure.params }),
      ...(failure.issues && { issues: failure.issues }),
    },
  };
}

/** The most of an unexpected answer's body kept in a `not_audio` error. */
export const NOT_AUDIO_BODY_BYTES = 2_048;

/** A server answered something that is not audio: keeps its content type and the first 2 KB, as is. */
export function notAudio(contentType: string, bytes: Uint8Array): VoiceFailure {
  const body = new TextDecoder("utf-8", { fatal: false }).decode(
    bytes.subarray(0, NOT_AUDIO_BODY_BYTES),
  );
  return new VoiceFailure("not_audio", "The voice server did not answer with audio.", {
    contentType,
    body,
  });
}

/** Replaces every occurrence of a secret with `***`. */
export function scrubSecret(text: string, secret: string | null): string {
  if (!secret || secret.length === 0) return text;
  return text.split(secret).join("***");
}

/** The same failure with the key removed from its message and its params; the original is returned when clean. */
export function scrubFailure(failure: VoiceFailure, secret: string | null): VoiceFailure {
  if (!secret || secret.length === 0) return failure;
  const message = scrubSecret(failure.message, secret);
  let dirty = message !== failure.message;
  let params: VoiceErrorParams | undefined;
  if (failure.params) {
    params = {};
    for (const [key, value] of Object.entries(failure.params)) {
      const clean = typeof value === "string" ? scrubSecret(value, secret) : value;
      if (clean !== value) dirty = true;
      params[key] = clean;
    }
  }
  if (!dirty) return failure;
  return new VoiceFailure(failure.code, message, params, failure.status, failure.issues);
}
