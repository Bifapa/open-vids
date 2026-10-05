import { describe, expect, it } from "vitest";
import type { StreamTimerApi, StreamTimerHandle } from "../turnStream.js";
import { SpecialistQueue } from "./specialistQueue.js";
import { StallWatchdog } from "./stallWatchdog.js";

/** A manual clock: time only moves when the test says so. */
class ManualTimers implements StreamTimerApi {
  private now = 0;
  private readonly due = new Map<StreamTimerHandle, { at: number; callback: () => void }>();

  setTimeout(callback: () => void, delayMs: number): StreamTimerHandle {
    const handle = globalThis.setTimeout(() => undefined, 2 ** 31 - 1);
    handle.unref();
    this.due.set(handle, { at: this.now + delayMs, callback });
    return handle;
  }

  clearTimeout(timer: StreamTimerHandle): void {
    this.due.delete(timer);
    globalThis.clearTimeout(timer);
  }

  advance(ms: number): void {
    this.now += ms;
    for (const [handle, entry] of [...this.due]) {
      if (entry.at > this.now) continue;
      this.clearTimeout(handle);
      entry.callback();
    }
  }
}

describe("StallWatchdog", () => {
  it("fires after the limit without a sign of life, and every sign of life restarts the clock", () => {
    const timers = new ManualTimers();
    let stalls = 0;
    const watchdog = new StallWatchdog(timers, 1_000, () => (stalls += 1));
    watchdog.start();
    timers.advance(900);
    watchdog.touch();
    timers.advance(900);
    expect(stalls).toBe(0);
    timers.advance(100);
    expect(stalls).toBe(1);
  });

  it("holds the clock while a tool call is in flight and counts its end as progress", () => {
    const timers = new ManualTimers();
    let stalls = 0;
    const watchdog = new StallWatchdog(timers, 1_000, () => (stalls += 1));
    watchdog.start();
    watchdog.toolStarted();
    timers.advance(60_000);
    expect(stalls).toBe(0);
    watchdog.toolFinished();
    timers.advance(999);
    expect(stalls).toBe(0);
    timers.advance(1);
    expect(stalls).toBe(1);
  });

  it("stays quiet once stopped", () => {
    const timers = new ManualTimers();
    let stalls = 0;
    const watchdog = new StallWatchdog(timers, 1_000, () => (stalls += 1));
    watchdog.start();
    watchdog.stop();
    watchdog.touch();
    timers.advance(5_000);
    expect(stalls).toBe(0);
  });
});

describe("SpecialistQueue", () => {
  it("gives the Editor one place and Research two, and hands a freed place to the next in line", async () => {
    const queue = new SpecialistQueue();
    const editor = [queue.enqueue("editor"), queue.enqueue("editor")];
    expect(await editor[0]?.granted).toBe(0);
    expect(queue.isBusy("editor")).toBe(true);
    const research = [
      queue.enqueue("research"),
      queue.enqueue("research"),
      queue.enqueue("research"),
    ];
    expect(await research[0]?.granted).toBe(0);
    expect(await research[1]?.granted).toBe(1);
    queue.release("research", 0);
    expect(await research[2]?.granted).toBe(0);
  });

  it("lets a waiting task leave the line without a place", async () => {
    const queue = new SpecialistQueue();
    queue.enqueue("editor");
    const waiting = queue.enqueue("editor");
    const last = queue.enqueue("editor");
    queue.drop(waiting);
    expect(await waiting.granted).toBeNull();
    queue.release("editor", 0);
    expect(await last.granted).toBe(0);
  });
});
