import { randomUUID } from "node:crypto";
import {
  isCancelResearchRequestResult,
  isRecord,
  isResearchError,
  type CancelRequestState,
} from "@hyperframes/agent-protocol";
import { ResearchToolError } from "./host.js";

/**
 * The HTTP conversation with a Studio service that answers `{ error: ResearchError }` and runs cancellable writes
 * (`RequestGuard` on the server): the research service and the cross-project service share it. Reads are abandoned the
 * moment the caller leaves; a write is cancelled explicitly and awaited (see {@link StudioTransport.write}).
 */

/**
 * After a write is cancelled (the turn was stopped, or the call timed out) the host keeps waiting this long for the
 * server's answer. The server checks the cancel right before it commits, so the answer normally comes at once; the
 * long part of an import (download, conversion) is abandoned as soon as the cancel arrives.
 */
export const WRITE_SETTLE_MS = 30_000;
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
  /** The route that cancels the write with this request id. */
  cancelUrl: (requestId: string) => string;
  /** Names the write in the `write_unsettled` message ("import", "website/file"). */
  label: string;
}

/** What the server answered, before it is read as a success or a failure. */
interface Exchange {
  ok: boolean;
  status: number;
  payload: unknown;
}

/** The outcome of a request on the wire; never rejects, so a write's answer can be awaited after the caller left. */
type Outcome = { exchange: Exchange } | { error: unknown };

export interface StudioTransportOptions {
  /** Names the service in failure messages ("research", "cross-project"). */
  service: string;
  /** Overrides {@link WRITE_SETTLE_MS}. */
  settleMs?: number;
}

export class StudioTransport {
  private readonly service: string;
  private readonly settleMs: number;

  constructor(options: StudioTransportOptions) {
    this.service = options.service;
    this.settleMs = options.settleMs ?? WRITE_SETTLE_MS;
  }

  /** A read: abandoned (the connection closed) as soon as the caller's signal aborts or the call times out. */
  async request(
    method: HttpMethod,
    url: string,
    { body, signal, timeoutMs, onTimeout }: RequestOptions,
  ): Promise<unknown> {
    if (signal.aborted) throw aborted();
    const timeout = AbortSignal.timeout(timeoutMs);
    const outcome = await this.exchange(method, url, body, AbortSignal.any([signal, timeout]));
    if ("error" in outcome) throw this.transportError(outcome.error, signal, timeout, onTimeout);
    return this.payloadOf(outcome.exchange);
  }

  /**
   * A write: an import, a resolution, a saved website read, a full-access download or a page recording. It writes
   * project files, so stopping it must not end with a write landing after the turn's checkpoint closed. The call
   * carries a fresh request id; when the caller's signal aborts (the turn was stopped) or the call times out, the host
   * sends an explicit cancel and keeps waiting for the original request's answer instead of dropping the connection:
   *
   * - the server checks a cancel right before it commits, so it answers `cancelled` (nothing written) or, when the
   *   commit had started, the normal result — which is then returned, because that write happened;
   * - if the answer does not come within `settleMs`: when the cancel was acknowledged as `cancelled` the server has
   *   promised never to write, so the host gives up safely; otherwise a write may still land, and the host fails with
   *   `write_unsettled` so the turn reports it instead of pretending the checkpoint is clean. Waiting longer is not
   *   safer: the commit itself is synchronous on the server, so an answer this late means Studio is stuck *after* its
   *   write, and a stuck Studio must not hold the turn (and the user's Stop) forever.
   */
  async write(
    request: object,
    { url, cancelUrl, label, signal, timeoutMs, onTimeout }: WriteOptions,
  ): Promise<unknown> {
    if (signal.aborted) throw aborted();
    const requestId = randomUUID();
    const timeout = AbortSignal.timeout(timeoutMs);
    // The connection stays open after the caller is gone; only the host closes it, once the outcome is settled.
    const wire = new AbortController();
    const answer = this.exchange("POST", url, { ...request, requestId }, wire.signal);
    const stopped = Promise.withResolvers<"stopped">();
    const onStop = () => stopped.resolve("stopped");
    signal.addEventListener("abort", onStop, { once: true });
    timeout.addEventListener("abort", onStop, { once: true });
    try {
      const first = await Promise.race([answer, stopped.promise]);
      if (first !== "stopped") return this.answered(first, signal, timeout, onTimeout);

      const state = await this.cancel(cancelUrl(requestId));
      const late = await waitFor(answer, this.settleMs);
      if (late !== "waiting") return this.answered(late, signal, timeout, onTimeout);
      if (state === "cancelled") throw this.transportError(null, signal, timeout, onTimeout);
      throw new ResearchToolError(
        "write_unsettled",
        `The ${label} was cancelled but Studio did not say whether it wrote anything` +
          ` (cancel answered ${state ?? "nothing"}); the file may still appear in the project.`,
      );
    } finally {
      signal.removeEventListener("abort", onStop);
      timeout.removeEventListener("abort", onStop);
      wire.abort();
    }
  }

  /** The server's final answer to a write. A `cancelled` answer means the stop reached it before its commit. */
  private answered(
    outcome: Outcome,
    signal: AbortSignal,
    timeout: AbortSignal,
    onTimeout: string,
  ): unknown {
    if ("error" in outcome) throw this.transportError(outcome.error, signal, timeout, onTimeout);
    try {
      return this.payloadOf(outcome.exchange);
    } catch (error) {
      if (error instanceof ResearchToolError && error.code === "cancelled") {
        throw this.transportError(error, signal, timeout, onTimeout);
      }
      throw error;
    }
  }

  /** Asks Studio to cancel a write; `null` when Studio could not be asked (the write's fate is then unknown). */
  private async cancel(url: string): Promise<CancelRequestState | null> {
    const outcome = await this.exchange(
      "POST",
      url,
      undefined,
      AbortSignal.timeout(CANCEL_TIMEOUT_MS),
    );
    if ("error" in outcome || !outcome.exchange.ok) return null;
    const { payload } = outcome.exchange;
    return isCancelResearchRequestResult(payload) ? payload.state : null;
  }

  private async exchange(
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
      return { exchange: { ok: response.ok, status: response.status, payload } };
    } catch (error) {
      return { error };
    }
  }

  /** The payload of a successful answer; a failure becomes a {@link ResearchToolError} with the service's code. */
  private payloadOf({ ok, status, payload }: Exchange): unknown {
    if (ok) return payload;
    const failure = isRecord(payload) ? payload.error : undefined;
    if (isResearchError(failure))
      throw new ResearchToolError(failure.code, failure.message, failure.params);
    throw new ResearchToolError(
      "studio_unavailable",
      typeof failure === "string"
        ? failure
        : `Studio's ${this.service} service failed the request (${status}).`,
    );
  }

  private transportError(
    error: unknown,
    signal: AbortSignal,
    timeout: AbortSignal,
    onTimeout: string,
  ): ResearchToolError {
    if (signal.aborted) return aborted();
    if (timeout.aborted) return new ResearchToolError("studio_unavailable", onTimeout);
    const reason = error instanceof Error ? error.message : String(error);
    return new ResearchToolError(
      "studio_unavailable",
      `Studio's ${this.service} service is not reachable: ${reason}`,
    );
  }
}

/** `promise`'s outcome, or "waiting" once `ms` have passed. */
async function waitFor<T>(promise: Promise<T>, ms: number): Promise<T | "waiting"> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const elapsed = new Promise<"waiting">((resolve) => {
    timer = setTimeout(() => resolve("waiting"), ms);
  });
  try {
    return await Promise.race([promise, elapsed]);
  } finally {
    clearTimeout(timer);
  }
}

export function aborted(): ResearchToolError {
  return new ResearchToolError("aborted", "The operation was cancelled.");
}

export function invalidResponse(what: string): ResearchToolError {
  return new ResearchToolError("studio_unavailable", `Studio returned an invalid ${what}.`);
}
