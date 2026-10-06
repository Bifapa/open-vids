import {
  isCancelResearchRequestResult,
  isRecord,
  isVoiceErrorCode,
  type CancelRequestState,
  type VoiceScriptIssue,
} from "@hyperframes/agent-protocol";
import { isVoiceScriptIssue } from "./guards.js";
import { VoiceToolError } from "./host.js";

/**
 * The HTTP conversation with Studio's voice service, which answers `{ error: { code, message, params?, issues? } }` and
 * runs cancellable syntheses. Reads are abandoned the moment the caller leaves; a synthesis is cancelled explicitly and
 * awaited (see {@link VoiceTransport.write}) because it writes the project's audio files and takes.
 */

/** After a synthesis is cancelled the host keeps waiting this long for the server's answer. */
export const VOICE_SETTLE_MS = 30_000;
/** How long the cancel request itself may take. */
const CANCEL_TIMEOUT_MS = 10_000;

export type HttpMethod = "GET" | "POST" | "PUT" | "DELETE";

export interface RequestOptions {
  body?: unknown;
  signal: AbortSignal;
  timeoutMs: number;
  /** Shown when the call timed out, so the model knows whether to check what happened. */
  onTimeout: string;
}

export interface WriteOptions extends Omit<RequestOptions, "body"> {
  /** The write's route. */
  url: string;
  /** Sent in the body so the server can cancel exactly this request. */
  requestId: string;
  /** The route that cancels the write with this request id. */
  cancelUrl: string;
  /** Names the write in the `write_unsettled` message. */
  label: string;
}

interface Exchange {
  ok: boolean;
  status: number;
  payload: unknown;
  /** The `Retry-After` header in seconds, when it is a number. */
  retryAfter: number | null;
}

/** The outcome of a request on the wire; never rejects, so a write's answer can be awaited after the caller left. */
type Outcome = { exchange: Exchange } | { error: unknown };

export class VoiceTransport {
  constructor(private readonly settleMs: number = VOICE_SETTLE_MS) {}

  /** A read or a small write: abandoned as soon as the caller's signal aborts or the call times out. */
  async request(
    method: HttpMethod,
    url: string,
    { body, signal, timeoutMs, onTimeout }: RequestOptions,
  ): Promise<unknown> {
    if (signal.aborted) throw aborted();
    const timeout = AbortSignal.timeout(timeoutMs);
    const outcome = await exchange(method, url, body, AbortSignal.any([signal, timeout]));
    if ("error" in outcome) throw transportError(outcome.error, signal, timeout, onTimeout);
    return payloadOf(outcome.exchange);
  }

  /**
   * A synthesis: it writes audio files and the takes file, so stopping it must not end with a write landing after the
   * turn's checkpoint closed. When the caller's signal aborts (the turn was stopped) or the call times out, the host
   * sends an explicit cancel and keeps waiting for the original request's answer instead of dropping the connection:
   * the server answers `cancelled` (nothing more written) or, when a take was already committing, the normal result —
   * which is then returned, because that write happened. When no answer comes within `settleMs`: a `cancelled`
   * acknowledgement means the server promised never to write, so the host gives up safely; otherwise a write may still
   * land and the host fails with `write_unsettled`.
   */
  async write(
    request: object,
    { url, requestId, cancelUrl, label, signal, timeoutMs, onTimeout }: WriteOptions,
  ): Promise<unknown> {
    if (signal.aborted) throw aborted();
    const timeout = AbortSignal.timeout(timeoutMs);
    // The connection stays open after the caller is gone; only the host closes it, once the outcome is settled.
    const wire = new AbortController();
    const answer = exchange("POST", url, { ...request, requestId }, wire.signal);
    const stopped = Promise.withResolvers<"stopped">();
    const onStop = () => stopped.resolve("stopped");
    signal.addEventListener("abort", onStop, { once: true });
    timeout.addEventListener("abort", onStop, { once: true });
    try {
      const first = await Promise.race([answer, stopped.promise]);
      if (first !== "stopped") return answered(first, signal, timeout, onTimeout);

      const state = await cancel(cancelUrl);
      const late = await waitFor(answer, this.settleMs);
      if (late !== "waiting") return answered(late, signal, timeout, onTimeout);
      if (state === "cancelled") throw transportError(null, signal, timeout, onTimeout);
      throw new VoiceToolError(
        "write_unsettled",
        `The ${label} was cancelled but Studio did not say whether it wrote anything` +
          ` (cancel answered ${state ?? "nothing"}); a take may still appear in the project.`,
      );
    } finally {
      signal.removeEventListener("abort", onStop);
      timeout.removeEventListener("abort", onStop);
      wire.abort();
    }
  }
}

/** The server's final answer to a write. A `cancelled` answer means the stop reached it before its commit. */
function answered(
  outcome: Outcome,
  signal: AbortSignal,
  timeout: AbortSignal,
  onTimeout: string,
): unknown {
  if ("error" in outcome) throw transportError(outcome.error, signal, timeout, onTimeout);
  try {
    return payloadOf(outcome.exchange);
  } catch (error) {
    if (error instanceof VoiceToolError && error.code === "cancelled") {
      throw transportError(error, signal, timeout, onTimeout);
    }
    throw error;
  }
}

/** Asks Studio to cancel a write; `null` when Studio could not be asked (the write's fate is then unknown). */
async function cancel(url: string): Promise<CancelRequestState | null> {
  const outcome = await exchange("POST", url, undefined, AbortSignal.timeout(CANCEL_TIMEOUT_MS));
  if ("error" in outcome || !outcome.exchange.ok) return null;
  const { payload } = outcome.exchange;
  return isCancelResearchRequestResult(payload) ? payload.state : null;
}

async function exchange(
  method: HttpMethod,
  url: string,
  body: unknown,
  signal: AbortSignal,
): Promise<Outcome> {
  try {
    const response = await fetch(url, {
      method,
      signal,
      ...(body !== undefined && {
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
    });
    let payload: unknown;
    try {
      payload = await response.json();
    } catch (error) {
      // The body may still be streaming when the call is cancelled or times out.
      if (signal.aborted) throw error;
      payload = null;
    }
    const retryAfter = Number(response.headers.get("retry-after"));
    return {
      exchange: {
        ok: response.ok,
        status: response.status,
        payload,
        retryAfter: Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : null,
      },
    };
  } catch (error) {
    return { error };
  }
}

function paramsOf(value: unknown): Record<string, string | number> {
  if (!isRecord(value)) return {};
  const params: Record<string, string | number> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry === "string" || typeof entry === "number") params[key] = entry;
  }
  return params;
}

/** The payload of a successful answer; a failure becomes a {@link VoiceToolError} with the service's code. */
function payloadOf({ ok, status, payload, retryAfter }: Exchange): unknown {
  if (ok) return payload;
  const failure = isRecord(payload) ? payload.error : undefined;
  if (isRecord(failure) && isVoiceErrorCode(failure.code) && typeof failure.message === "string") {
    const params = paramsOf(failure.params);
    // The provider's own hint is in the params; the header carries the same figure when the server relayed one.
    if (
      failure.code === "rate_limited" &&
      retryAfter !== null &&
      params.retryAfterSeconds === undefined
    )
      params.retryAfterSeconds = retryAfter;
    const issues: VoiceScriptIssue[] = Array.isArray(failure.issues)
      ? failure.issues.filter(isVoiceScriptIssue)
      : [];
    throw new VoiceToolError(failure.code, failure.message, params, issues);
  }
  throw new VoiceToolError(
    "studio_unavailable",
    typeof failure === "string"
      ? failure
      : `Studio's voice service failed the request (${status}).`,
  );
}

function transportError(
  error: unknown,
  signal: AbortSignal,
  timeout: AbortSignal,
  onTimeout: string,
): VoiceToolError {
  if (signal.aborted) return aborted();
  if (timeout.aborted) return new VoiceToolError("studio_unavailable", onTimeout);
  const reason = error instanceof Error ? error.message : String(error);
  return new VoiceToolError(
    "studio_unavailable",
    `Studio's voice service is not reachable: ${reason}`,
  );
}

/** `promise`'s outcome, or "waiting" once `ms` have passed. */
async function waitFor<T>(promise: Promise<T>, ms: number): Promise<T | "waiting"> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<"waiting">((resolve) => {
        timer = setTimeout(() => resolve("waiting"), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export function aborted(): VoiceToolError {
  return new VoiceToolError("aborted", "The operation was cancelled.");
}

export function invalidResponse(what: string): VoiceToolError {
  return new VoiceToolError("studio_unavailable", `Studio returned an invalid ${what}.`);
}
