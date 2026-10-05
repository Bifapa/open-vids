import type { StreamTimerApi, StreamTimerHandle } from "../turnStream.js";

/** How long a run may go without any sign of life before it is stopped. */
export const DEFAULT_STALL_MS = 10 * 60_000;

/**
 * Stops a run whose provider or tool stopped answering. Every backend event is a sign of life; while one of the run's
 * tools is executing (a render, an analysis, a question waiting for the user) the clock is paused, because those calls
 * carry their own deadlines and can legitimately be silent for long.
 */
export class StallWatchdog {
  private timer: StreamTimerHandle | null = null;
  private inFlight = 0;
  private stopped = false;

  constructor(
    private readonly timers: StreamTimerApi,
    private readonly limitMs: number,
    private readonly onStall: () => void,
  ) {}

  start(): void {
    this.arm();
  }

  /** A sign of life: the clock restarts. */
  touch(): void {
    this.arm();
  }

  toolStarted(): void {
    this.inFlight += 1;
    this.disarm();
  }

  toolFinished(): void {
    this.inFlight = Math.max(0, this.inFlight - 1);
    this.arm();
  }

  stop(): void {
    this.stopped = true;
    this.disarm();
  }

  private arm(): void {
    this.disarm();
    if (this.stopped || this.inFlight > 0) return;
    this.timer = this.timers.setTimeout(() => {
      this.timer = null;
      if (!this.stopped && this.inFlight === 0) this.onStall();
    }, this.limitMs);
  }

  private disarm(): void {
    if (this.timer === null) return;
    this.timers.clearTimeout(this.timer);
    this.timer = null;
  }
}
