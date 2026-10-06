import { isRecord } from "@hyperframes/agent-protocol";
import { sniffAudio } from "../audio.js";
import { notAudio, scrubSecret, VoiceFailure, type VoiceErrorParams } from "../errors.js";
import type { ConnectorAudio, ConnectorContext } from "../types.js";

/** A synthesis can take a while (a long scene); everything else is a short call. */
export const SYNTHESIS_TIMEOUT_MS = 180_000;
export const SHORT_TIMEOUT_MS = 20_000;
/** The most of an error answer that is read. */
const ERROR_BODY_BYTES = 64 * 1024;
const MESSAGE_CHARS = 500;

export interface ConnectorRequest {
  method?: "GET" | "POST";
  headers?: Record<string, string>;
  /** Sent as JSON. */
  body?: unknown;
  timeoutMs?: number;
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "the voice server";
  }
}

/**
 * One HTTP call. Redirects are never followed (a header carrying a key must not travel to another host), the caller's
 * abort and a timeout end it, and a network failure is a typed error that names the host only.
 */
export async function send(
  ctx: ConnectorContext,
  url: string,
  request: ConnectorRequest = {},
): Promise<Response> {
  const signal = AbortSignal.any([
    ctx.signal,
    AbortSignal.timeout(request.timeoutMs ?? SHORT_TIMEOUT_MS),
  ]);
  const headers: Record<string, string> = { ...request.headers };
  if (request.body !== undefined) headers["content-type"] = "application/json";
  let response: Response;
  try {
    response = await ctx.fetch(url, {
      method: request.method ?? (request.body === undefined ? "GET" : "POST"),
      headers,
      ...(request.body !== undefined && { body: JSON.stringify(request.body) }),
      redirect: "manual",
      signal,
    });
  } catch {
    if (ctx.signal.aborted) throw new VoiceFailure("cancelled", "The request was cancelled.");
    throw new VoiceFailure(
      "provider_unreachable",
      `Could not reach ${hostOf(url)} (no answer or the connection failed).`,
    );
  }
  if (response.status >= 300 && response.status < 400)
    throw new VoiceFailure(
      "provider_error",
      `${hostOf(url)} answered with a redirect (${response.status}); check the server address.`,
      { status: response.status },
    );
  return response;
}

/** A failed answer's body: its text (bounded) and its JSON when it is JSON, whatever the content type says. */
export async function readFailureBody(
  response: Response,
): Promise<{ text: string; json: unknown }> {
  const bytes = new Uint8Array(await response.arrayBuffer().catch(() => new ArrayBuffer(0)));
  const text = new TextDecoder("utf-8", { fatal: false }).decode(
    bytes.subarray(0, ERROR_BODY_BYTES),
  );
  try {
    return { text, json: JSON.parse(text) };
  } catch {
    return { text, json: null };
  }
}

/** A successful JSON answer; anything else is `not_audio`-style trouble reported as a provider error. */
export async function readJson(response: Response): Promise<unknown> {
  const bytes = new Uint8Array(await response.arrayBuffer());
  const text = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
  try {
    return JSON.parse(text);
  } catch {
    throw new VoiceFailure(
      "provider_error",
      "The voice server answered with something that is not JSON.",
      {
        contentType: response.headers.get("content-type") ?? "",
        body: text.slice(0, 200),
      },
    );
  }
}

/** `Retry-After` in seconds (a number of seconds or an HTTP date), when the server sent it. */
export function retryAfterFromHeaders(headers: Headers, now = Date.now()): number | undefined {
  const value = headers.get("retry-after");
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds);
  const date = Date.parse(value);
  if (Number.isFinite(date)) return Math.max(0, Math.ceil((date - now) / 1000));
  return undefined;
}

/** A duration as Google writes it (`"45s"`, `"0.5s"`, `{seconds, nanos}`) or a plain number of seconds. */
export function parseDurationSeconds(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) return Math.ceil(value);
  if (typeof value === "string") {
    const match = /^\s*(\d+(?:\.\d+)?)\s*s?\s*$/.exec(value);
    if (match?.[1]) return Math.ceil(Number(match[1]));
    return undefined;
  }
  if (isRecord(value)) {
    const seconds = Number(value.seconds ?? 0);
    const nanos = Number(value.nanos ?? 0);
    if (Number.isFinite(seconds) && Number.isFinite(nanos)) return Math.ceil(seconds + nanos / 1e9);
  }
  return undefined;
}

export function shorten(message: string): string {
  const flat = message.replace(/\s+/g, " ").trim();
  return flat.length > MESSAGE_CHARS ? `${flat.slice(0, MESSAGE_CHARS)}…` : flat;
}

export interface FailureDetails {
  /** The provider's own words. */
  message: string;
  /** The provider says the quota is spent for good (credits, daily quota), not for a moment. */
  quota?: boolean;
  /** The key is invalid, whatever the status says. */
  invalidKey?: boolean;
  /** A daily rate limit. */
  daily?: boolean;
  retryAfterSeconds?: number | undefined;
}

/** The typed failure for a provider's error answer; `key` is scrubbed out of the provider's words. */
export function failureFor(
  status: number,
  details: FailureDetails,
  key: string | null,
): VoiceFailure {
  const message = shorten(scrubSecret(details.message, key));
  if (details.quota)
    return new VoiceFailure(
      "quota_exhausted",
      message || "The provider's quota or credit is spent.",
    );
  if (details.invalidKey || status === 401)
    return new VoiceFailure("invalid_key", "The provider rejected the API key.");
  if (status === 402)
    return new VoiceFailure(
      "quota_exhausted",
      message || "The provider's quota or credit is spent.",
    );
  if (status === 429) {
    const params: VoiceErrorParams = {};
    if (details.retryAfterSeconds !== undefined)
      params.retryAfterSeconds = details.retryAfterSeconds;
    if (details.daily) params.daily = 1;
    return new VoiceFailure(
      "rate_limited",
      message || "The provider is rate limiting requests.",
      Object.keys(params).length > 0 ? params : undefined,
    );
  }
  return new VoiceFailure("provider_error", message || `The provider answered ${status}.`, {
    status,
  });
}

/**
 * The body of a successful synthesis as audio. A JSON, text or HTML answer is `not_audio` with what the server said;
 * unlabeled bytes are sniffed, and only an expected raw PCM stream may pass unrecognised.
 */
export async function audioFromResponse(
  response: Response,
  expected: ConnectorAudio["format"],
  sampleRate?: number,
): Promise<ConnectorAudio> {
  const contentType = response.headers.get("content-type") ?? "";
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (/json|text\/|html|xml/i.test(contentType)) throw notAudio(contentType, bytes);
  const sniffed = sniffAudio(bytes);
  if (sniffed) return { bytes, format: sniffed, ...(sampleRate && { sampleRate }) };
  if (expected === "pcm" && bytes.length > 0 && /audio|octet-stream/i.test(contentType || "audio/"))
    return { bytes, format: "pcm", ...(sampleRate && { sampleRate }) };
  throw notAudio(contentType, bytes);
}

/** The first non-empty string among the fields, for wire casings the docs leave open (`snake_case` vs `camelCase`). */
export function pickString(source: Record<string, unknown>, ...fields: string[]): string | null {
  for (const field of fields) {
    const value = source[field];
    if (typeof value === "string" && value.length > 0) return value;
  }
  return null;
}
