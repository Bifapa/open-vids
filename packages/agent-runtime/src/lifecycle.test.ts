import { afterEach, describe, expect, it, vi } from "vitest";
import { createShutdown, isParentGone, watchParent } from "./lifecycle.js";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("isParentGone", () => {
  it("counts a missing process and a reused pid (another user's process) as gone", () => {
    expect(isParentGone(Object.assign(new Error("x"), { code: "ESRCH" }))).toBe(true);
    expect(isParentGone(Object.assign(new Error("x"), { code: "EPERM" }))).toBe(true);
    expect(isParentGone(Object.assign(new Error("x"), { code: "EINVAL" }))).toBe(false);
    expect(isParentGone("ESRCH")).toBe(false);
  });
});

describe("watchParent", () => {
  it("keeps reporting a gone parent until stopped", () => {
    vi.useFakeTimers();
    vi.spyOn(process, "kill").mockImplementation(() => {
      throw Object.assign(new Error("no such process"), { code: "EPERM" });
    });
    const onGone = vi.fn();
    const stop = watchParent(4242, onGone, 1_000);
    vi.advanceTimersByTime(3_000);
    expect(onGone).toHaveBeenCalledTimes(3);
    stop();
    vi.advanceTimersByTime(3_000);
    expect(onGone).toHaveBeenCalledTimes(3);
  });

  it("stays quiet while the parent lives", () => {
    vi.useFakeTimers();
    vi.spyOn(process, "kill").mockImplementation(() => true);
    const onGone = vi.fn();
    const stop = watchParent(4242, onGone, 1_000);
    vi.advanceTimersByTime(5_000);
    stop();
    expect(onGone).not.toHaveBeenCalled();
  });
});

describe("createShutdown", () => {
  it("runs the graceful stop once for every trigger", async () => {
    vi.useFakeTimers();
    const stop = vi.fn(async () => undefined);
    const shutdown = createShutdown({
      stop,
      deadlineMs: 5_000,
      onDeadline: vi.fn(),
      exit: vi.fn(),
    });
    await Promise.all([shutdown(), shutdown()]);
    expect(stop).toHaveBeenCalledTimes(1);
  });

  it("ends the process when the graceful stop hangs past the deadline", async () => {
    vi.useFakeTimers();
    const exit = vi.fn();
    const onDeadline = vi.fn();
    const shutdown = createShutdown({
      stop: () => new Promise<void>(() => undefined),
      deadlineMs: 5_000,
      onDeadline,
      exit,
    });
    void shutdown();
    await vi.advanceTimersByTimeAsync(4_999);
    expect(exit).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(onDeadline).toHaveBeenCalledWith("stopping");
    expect(exit).toHaveBeenCalledWith(1);
  });

  it("keeps the deadline armed after a clean stop, and ends a process that is still alive with 0", async () => {
    vi.useFakeTimers();
    const exit = vi.fn();
    const onDeadline = vi.fn();
    const shutdown = createShutdown({
      stop: async () => undefined,
      deadlineMs: 5_000,
      onDeadline,
      exit,
    });
    await shutdown();
    await vi.advanceTimersByTimeAsync(4_999);
    expect(exit).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(onDeadline).toHaveBeenCalledWith("stopped");
    expect(exit).toHaveBeenCalledWith(0);
  });

  it("keeps the deadline armed after a failed stop, reports the failure and ends the process with 1", async () => {
    vi.useFakeTimers();
    const exit = vi.fn();
    const onDeadline = vi.fn();
    const shutdown = createShutdown({
      stop: async () => {
        throw new Error("dispose failed");
      },
      deadlineMs: 5_000,
      onDeadline,
      exit,
    });
    await expect(shutdown()).rejects.toThrow("dispose failed");
    await vi.advanceTimersByTimeAsync(5_000);
    expect(onDeadline).toHaveBeenCalledWith("failed");
    expect(exit).toHaveBeenCalledWith(1);
  });

  it("does not delay a clean exit: the deadline timer is unreferenced", async () => {
    const timers = vi.spyOn(globalThis, "setTimeout");
    try {
      const shutdown = createShutdown({
        stop: async () => undefined,
        deadlineMs: 60_000,
        onDeadline: vi.fn(),
        exit: vi.fn(),
      });
      await shutdown();
      const timer = timers.mock.results[0]?.value;
      expect(typeof timer === "object" && timer !== null && "hasRef" in timer).toBe(true);
      if (typeof timer === "object" && timer !== null && "hasRef" in timer) {
        expect(timer.hasRef()).toBe(false);
        clearTimeout(timer);
      }
    } finally {
      timers.mockRestore();
    }
  });
});
