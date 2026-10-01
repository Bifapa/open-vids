import { afterEach, describe, expect, it } from "vitest";
import {
  MAX_CONCURRENT_MEDIA_ELEMENT_LOADS,
  acquireMediaLoad,
  type MediaLoadRelease,
} from "./mediaLoadGate";

// Grants resolve through promise chains only — draining microtasks is enough.
async function flush(): Promise<void> {
  for (let i = 0; i < 5; i++) await Promise.resolve();
}

describe("mediaLoadGate", () => {
  // Every slot a test takes is released afterwards so the module-level gate
  // starts each test empty. Releasing grants still-queued waiters, which then
  // need releasing too, hence the loop.
  const held: MediaLoadRelease[] = [];
  afterEach(async () => {
    do {
      for (const release of held.splice(0)) release();
      await flush();
    } while (held.length > 0);
  });

  function request(signal?: AbortSignal) {
    const state = { granted: false, rejected: false, release: null as MediaLoadRelease | null };
    acquireMediaLoad(signal).then(
      (release) => {
        state.granted = true;
        state.release = release;
        held.push(release);
      },
      () => {
        state.rejected = true;
      },
    );
    return state;
  }

  it("grants at most MAX_CONCURRENT_MEDIA_ELEMENT_LOADS slots at once", async () => {
    const requests = Array.from({ length: MAX_CONCURRENT_MEDIA_ELEMENT_LOADS + 4 }, () =>
      request(),
    );
    await flush();
    expect(requests.filter((r) => r.granted)).toHaveLength(MAX_CONCURRENT_MEDIA_ELEMENT_LOADS);
  });

  it("grants queued waiters in FIFO order as slots free up", async () => {
    const requests = Array.from({ length: MAX_CONCURRENT_MEDIA_ELEMENT_LOADS + 2 }, () =>
      request(),
    );
    await flush();

    requests[1]?.release?.();
    await flush();
    expect(requests[MAX_CONCURRENT_MEDIA_ELEMENT_LOADS]?.granted).toBe(true);
    expect(requests[MAX_CONCURRENT_MEDIA_ELEMENT_LOADS + 1]?.granted).toBe(false);

    requests[0]?.release?.();
    await flush();
    expect(requests[MAX_CONCURRENT_MEDIA_ELEMENT_LOADS + 1]?.granted).toBe(true);
  });

  it("never lets a waiter aborted while queued take a slot", async () => {
    const first = Array.from({ length: MAX_CONCURRENT_MEDIA_ELEMENT_LOADS }, () => request());
    const controller = new AbortController();
    const cancelled = request(controller.signal);
    const next = request();
    await flush();

    controller.abort();
    await flush();
    expect(cancelled.rejected).toBe(true);

    first[0]?.release?.();
    await flush();
    expect(cancelled.granted).toBe(false);
    expect(next.granted).toBe(true);

    // The cancelled waiter left no phantom slot behind: two more free slots
    // let two more waiters through, three in total are never exceeded.
    first[1]?.release?.();
    first[2]?.release?.();
    const late = [request(), request()];
    await flush();
    expect(late.every((r) => r.granted)).toBe(true);
  });

  it("rejects immediately for an already-aborted signal", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(acquireMediaLoad(controller.signal)).rejects.toMatchObject({
      name: "AbortError",
    });
  });

  it("ignores abort once the slot was granted", async () => {
    const controller = new AbortController();
    const granted = request(controller.signal);
    await flush();
    controller.abort();
    await flush();
    expect(granted.granted).toBe(true);
    expect(granted.rejected).toBe(false);
  });

  it("makes release idempotent so a double release frees only one slot", async () => {
    const first = Array.from({ length: MAX_CONCURRENT_MEDIA_ELEMENT_LOADS }, () => request());
    const waiting = Array.from({ length: 3 }, () => request());
    await flush();

    first[0]?.release?.();
    first[0]?.release?.();
    first[0]?.release?.();
    await flush();
    expect(waiting.filter((r) => r.granted)).toHaveLength(1);
  });
});
