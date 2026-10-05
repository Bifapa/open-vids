import type { StreamTimerApi, StreamTimerHandle } from "../turnStream.js";

/** How long the Director's model may stay silent (no event at all) before its prompt is given up. */
export const DEFAULT_PROMPT_STALL_MS = 10 * 60_000;

/**
 * Bounds one Director prompt: every backend event is progress, and while one of the Director's own tool calls is in
 * flight (a render, an analysis job, a wait for delegated runs, a question to the user) the clock is held — those
 * have their own deadlines. When the model itself says nothing for `stallMs`, `onStall` fires once.
 */
export class PromptWatchdog {
  private timer: StreamTimerHandle | null = null;
  private held = 0;
  private armed = false;

  constructor(
    private readonly timers: StreamTimerApi,
    private readonly stallMs: number,
    private readonly onStall: (idleMs: number) => void,
  ) {}

  /** A prompt starts: the countdown begins. */
  arm(): void {
    this.armed = true;
    this.schedule();
  }

  /** A prompt ended (or the Director went idle): nothing is watched. */
  disarm(): void {
    this.armed = false;
    this.clear();
  }

  /** The backend produced something: the countdown restarts. */
  touch(): void {
    if (this.armed) this.schedule();
  }

  /** One of the Director's tool calls started: the model is not the one being waited on. */
  hold(): void {
    this.held += 1;
  }

  /** That tool call ended; a finished call is progress too. */
  release(): void {
    this.held = Math.max(0, this.held - 1);
    this.touch();
  }

  private clear(): void {
    if (this.timer) this.timers.clearTimeout(this.timer);
    this.timer = null;
  }

  private schedule(): void {
    this.clear();
    this.timer = this.timers.setTimeout(() => {
      this.timer = null;
      if (!this.armed) return;
      if (this.held > 0) {
        this.schedule();
        return;
      }
      this.armed = false;
      this.onStall(this.stallMs);
    }, this.stallMs);
  }
}

/** The failure a stalled prompt reports. */
export function stallMessage(idleMs: number): string {
  const minutes = Math.max(1, Math.round(idleMs / 60_000));
  return `The model produced no output for ${minutes} minute${minutes === 1 ? "" : "s"}, so the turn was stopped. Nothing is lost: the changes made so far are kept and can be reverted. Try again, or choose another model.`;
}
