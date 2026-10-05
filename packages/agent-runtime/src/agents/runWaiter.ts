import type { StreamTimerApi, StreamTimerHandle } from "../turnStream.js";
import type { RunRecord } from "./runRecord.js";

export type WaitOutcome = "ready" | "steered" | "timeout" | "aborted";

/** Lets tool calls wait for runs to change state, and wakes them when one does or the user steers. */
export class RunWaiter {
  private readonly wakers = new Set<() => void>();
  private steerCount = 0;

  constructor(private readonly timers: StreamTimerApi) {}

  /** The user steered the Director: pending waits return so the Director can react. */
  steered(): void {
    this.steerCount += 1;
    this.wake();
  }

  /** A run changed state. */
  wake(): void {
    for (const waker of [...this.wakers]) waker();
  }

  /**
   * Resolves when `ready()` holds, the signal aborts, the optional timeout passes, or (with `stopOnSteer`) the user
   * steers; says which.
   */
  until(
    ready: () => boolean,
    signal: AbortSignal,
    options: { stopOnSteer: boolean; timeoutMs?: number },
  ): Promise<WaitOutcome> {
    const steerMark = this.steerCount;
    const { promise, resolve } = Promise.withResolvers<WaitOutcome>();
    let timer: StreamTimerHandle | null = null;
    let timedOut = false;
    const check = () => {
      const steered = options.stopOnSteer && this.steerCount !== steerMark;
      if (!ready() && !steered && !signal.aborted && !timedOut) return;
      this.wakers.delete(check);
      signal.removeEventListener("abort", check);
      if (timer !== null) this.timers.clearTimeout(timer);
      resolve(ready() ? "ready" : steered ? "steered" : signal.aborted ? "aborted" : "timeout");
    };
    this.wakers.add(check);
    signal.addEventListener("abort", check, { once: true });
    if (options.timeoutMs !== undefined) {
      timer = this.timers.setTimeout(() => {
        timedOut = true;
        check();
      }, options.timeoutMs);
    }
    check();
    return promise;
  }

  /** Whether every run's work has settled within `ms`. */
  async settleWithin(records: readonly RunRecord[], ms: number): Promise<boolean> {
    const timeout = Promise.withResolvers<boolean>();
    const timer: StreamTimerHandle = this.timers.setTimeout(() => timeout.resolve(false), ms);
    const settled = Promise.all(records.map((record) => record.done.catch(() => undefined))).then(
      () => true,
    );
    const result = await Promise.race([settled, timeout.promise]);
    this.timers.clearTimeout(timer);
    return result;
  }
}
