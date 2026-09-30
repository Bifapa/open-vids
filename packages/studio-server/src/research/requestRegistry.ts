import type { CancelRequestState } from "@hyperframes/agent-protocol";
import { ResearchFailure } from "./errors.js";

/** How long the registry remembers a request that ended, or a cancel that arrived before its request. */
const RETAIN_MS = 10 * 60_000;
const MAX_ENTRIES = 512;

interface Entry {
  readonly controller: AbortController;
  /** A request of this id has started (false: only a cancel that arrived first is remembered). */
  begun: boolean;
  committed: boolean;
  settled: boolean;
  at: number;
}

export function cancelledFailure(): ResearchFailure {
  return new ResearchFailure("cancelled", "The request was cancelled before anything was written");
}

/**
 * One cancellable write request (an import or a Missing Asset resolution).
 *
 * The contract with the runtime is about the turn's checkpoint: no project file may be written after a cancel was
 * answered `cancelled`. The request therefore has exactly one commit point, {@link commit}, which runs synchronously
 * with the cancel check: either the cancel came first and the commit throws `cancelled` (nothing was written), or the
 * commit came first and the request finishes and answers normally — a later cancel is told `committed`.
 */
export class RequestGuard {
  private readonly detach: () => void;

  constructor(
    private readonly entry: Entry,
    client: AbortSignal | undefined,
  ) {
    // A client that went away is a cancel: its answer has nobody to read.
    const onClientGone = () => entry.controller.abort();
    if (client?.aborted) onClientGone();
    else client?.addEventListener("abort", onClientGone, { once: true });
    this.detach = () => client?.removeEventListener("abort", onClientGone);
  }

  /** Aborts when the request is cancelled or its client disconnects; hand it to whatever downloads or converts. */
  get signal(): AbortSignal {
    return this.entry.controller.signal;
  }

  get committed(): boolean {
    return this.entry.committed;
  }

  /** Throws `cancelled` once the request is cancelled and has not committed. */
  assertLive(): void {
    if (!this.entry.committed && this.signal.aborted) throw cancelledFailure();
  }

  /**
   * Starts the commit: from here the request finishes whatever a later cancel says. Call it immediately before the
   * first write that lands in the project, with no `await` between the two. Idempotent once committed.
   */
  commit(): void {
    this.assertLive();
    this.entry.committed = true;
  }

  /** `cancelled` when the request was cancelled before it committed, whatever error it failed with. */
  normalize(error: unknown): unknown {
    return !this.entry.committed && this.signal.aborted ? cancelledFailure() : error;
  }

  /**
   * The work's outcome, but `cancelled` as soon as the request is cancelled before it committed: a wait for the
   * project lock must not outlast a cancel. The work behind it still stops at its first {@link assertLive}.
   */
  race<T>(work: Promise<T>): Promise<T> {
    const { signal } = this;
    return new Promise<T>((resolve, reject) => {
      const onAbort = () => {
        if (!this.entry.committed) reject(cancelledFailure());
      };
      if (signal.aborted) onAbort();
      else signal.addEventListener("abort", onAbort, { once: true });
      work.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
    });
  }

  /** The request is over (answered or failed). */
  settle(at: number): void {
    this.detach();
    this.entry.settled = true;
    this.entry.at = at;
  }
}

/**
 * Requests by id (scoped to a project), so the runtime can cancel one explicitly and learn whether it can still
 * write. Unknown ids are remembered too: a cancel may overtake the request it names.
 */
export class RequestRegistry {
  private readonly entries = new Map<string, Entry>();

  constructor(private readonly now: () => number = Date.now) {}

  /** Registers a request (no id: an anonymous request that only a client disconnect cancels). */
  begin(scope: string, id: string | undefined, client?: AbortSignal): RequestGuard {
    const created: Entry = {
      controller: new AbortController(),
      begun: true,
      committed: false,
      settled: false,
      at: this.now(),
    };
    if (id === undefined) return new RequestGuard(created, client);
    this.prune();
    const key = `${scope}\0${id}`;
    const known = this.entries.get(key);
    if (known?.begun) {
      throw new ResearchFailure("invalid_request", `requestId ${id} is already in use`);
    }
    // A cancel that arrived first left an aborted entry: the request starts cancelled.
    const entry = known ?? created;
    entry.begun = true;
    this.entries.set(key, entry);
    return new RequestGuard(entry, client);
  }

  end(guard: RequestGuard): void {
    guard.settle(this.now());
  }

  /** Cancels a request that has not committed; {@link CancelRequestState} says what each answer guarantees. */
  cancel(scope: string, id: string): CancelRequestState {
    this.prune();
    const key = `${scope}\0${id}`;
    const entry = this.entries.get(key);
    if (!entry) {
      const tombstone: Entry = {
        controller: new AbortController(),
        begun: false,
        committed: false,
        settled: false,
        at: this.now(),
      };
      tombstone.controller.abort();
      this.entries.set(key, tombstone);
      return "cancelled";
    }
    if (entry.settled) return "finished";
    if (entry.committed) return "committed";
    entry.controller.abort();
    return "cancelled";
  }

  private prune(): void {
    const cutoff = this.now() - RETAIN_MS;
    for (const [key, entry] of this.entries) {
      if (entry.at < cutoff && (entry.settled || !entry.begun)) this.entries.delete(key);
    }
    // Insertion order: the oldest go first; a request still running is never dropped.
    for (const [key, entry] of this.entries) {
      if (this.entries.size <= MAX_ENTRIES) break;
      if (entry.settled || !entry.begun) this.entries.delete(key);
    }
  }
}
