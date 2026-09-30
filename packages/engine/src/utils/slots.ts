import { availableParallelism } from "os";

/**
 * How many per-clip ffmpeg jobs (frame extraction, audio trims) one kind of work runs at a time. A long-form rough cut
 * has hundreds of clips of one source; starting a decoder for each at once starves the machine (load in the hundreds,
 * the Studio server stops answering and the render's own deadlines lapse).
 */
export const MAX_CONCURRENT_MEDIA_JOBS = Math.max(
  2,
  Math.min(8, Math.floor(availableParallelism() / 2)),
);

/**
 * A counting semaphore. A job waits for a slot before it starts its process, so process timeouts start with the
 * process itself and waiting never counts against them. Aborting a waiting job removes it from the queue without it
 * ever holding a slot.
 */
export class Slots {
  private running = 0;
  private readonly waiting: Array<() => void> = [];

  constructor(readonly limit: number) {}

  async run<T>(job: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    await this.acquire(signal);
    try {
      return await job();
    } finally {
      this.release();
    }
  }

  private acquire(signal: AbortSignal | undefined): Promise<void> {
    if (signal?.aborted)
      return Promise.reject(new Error("Cancelled while waiting for a media slot"));
    if (this.running < this.limit) {
      this.running += 1;
      return Promise.resolve();
    }
    // The engine's TypeScript lib predates Promise.withResolvers, hence the executor form.
    return new Promise<void>((resolve, reject) => {
      const onAbort = () => {
        const index = this.waiting.indexOf(grant);
        if (index >= 0) this.waiting.splice(index, 1);
        reject(new Error("Cancelled while waiting for a media slot"));
      };
      // A finishing job hands its slot straight to the next waiter, so the count never dips.
      const grant = () => {
        signal?.removeEventListener("abort", onAbort);
        resolve();
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      this.waiting.push(grant);
    });
  }

  private release(): void {
    const next = this.waiting.shift();
    if (next) next();
    else this.running -= 1;
  }
}
