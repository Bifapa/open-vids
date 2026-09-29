import type { StreamTimerApi, StreamTimerHandle } from "../turnStream.js";

export const RENEW_MS = 20_000;

/**
 * Timers where the turn heartbeat (RENEW_MS) is fired by hand and every other delay runs for real, so a test can
 * play an hour of heartbeats in milliseconds while text coalescing still flushes.
 */
export class HeartbeatClock implements StreamTimerApi {
  private readonly beats = new Map<StreamTimerHandle, () => void>();

  setTimeout(callback: () => void, delayMs: number): StreamTimerHandle {
    if (delayMs !== RENEW_MS) return globalThis.setTimeout(callback, delayMs);
    const handle = globalThis.setTimeout(() => undefined, 2 ** 31 - 1);
    handle.unref();
    this.beats.set(handle, callback);
    return handle;
  }

  clearTimeout(timer: StreamTimerHandle): void {
    this.beats.delete(timer);
    globalThis.clearTimeout(timer);
  }

  get pending(): number {
    return this.beats.size;
  }

  /**
   * Fires the pending heartbeat and waits (on event-loop turns, not wall-clock time) until the renewal it starts has
   * scheduled the next beat, or until `settled()` holds (a renewal that gives up schedules none), whether it went
   * through an in-memory or a real HTTP host.
   */
  async beat(settled: () => boolean = () => false): Promise<void> {
    const [entry] = this.beats;
    if (!entry) throw new Error("no heartbeat is scheduled");
    const [handle, callback] = entry;
    this.clearTimeout(handle);
    callback();
    for (let turn = 0; turn < 100_000 && this.beats.size === 0 && !settled(); turn += 1) {
      await new Promise((settle) => setImmediate(settle));
    }
  }
}
