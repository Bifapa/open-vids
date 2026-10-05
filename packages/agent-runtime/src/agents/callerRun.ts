import { AsyncLocalStorage } from "node:async_hooks";

const callerRun = new AsyncLocalStorage<string>();

/**
 * Runs a host tool call on behalf of one delegated run. Everything the call does — the executors it reaches, the lease
 * and model lookups they make — sees that run through {@link currentRunId}, so two runs of one specialist (or a
 * specialist's run and the Jev call it made) are never mistaken for each other. Without a run id (the Director) the call
 * runs as it is.
 */
export function withCallerRun<T>(runId: string | null, call: () => T): T {
  return runId === null ? call() : callerRun.run(runId, call);
}

/** The delegated run whose host tool call is executing right now, if the call carries one. */
export function currentRunId(): string | undefined {
  return callerRun.getStore();
}
