// @vitest-environment happy-dom

// A render's progress stream can drop while the render itself carries on (the server hiccuped, the machine slept).
// The row used to flip to "failed" on the first error and was never corrected, even after the file finished.

import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mountRenderQueue, type MountedQueue } from "./renderQueueTestHarness";
import type * as FfmpegStatusModule from "./useFfmpegStatus";
import { useRenderQueue } from "./useRenderQueue";

vi.mock("./useFfmpegStatus", async (importOriginal) => ({
  ...(await importOriginal<typeof FfmpegStatusModule>()),
  useFfmpegStatus: () => ({ status: { ok: true }, checking: false, recheck: vi.fn() }),
}));

class FakeEventSource {
  static instances: FakeEventSource[] = [];
  closed = false;
  onerror: (() => void) | null = null;
  private listeners = new Map<string, (event: MessageEvent) => void>();

  constructor(readonly url: string) {
    FakeEventSource.instances.push(this);
  }

  addEventListener(type: string, listener: (event: MessageEvent) => void): void {
    this.listeners.set(type, listener);
  }

  close(): void {
    this.closed = true;
  }

  /** The server sent a progress event. */
  emit(payload: object): void {
    const event = new MessageEvent("progress", { data: JSON.stringify(payload) });
    this.listeners.get("progress")?.(event);
  }

  /** The connection dropped. */
  drop(): void {
    this.onerror?.();
  }
}

interface HistoryEntry {
  id: string;
  filename: string;
  createdAt: number;
  size: number;
  status: "complete" | "failed";
  durationMs?: number;
}

let history: HistoryEntry[];
let nextJob: number;
let queue: MountedQueue | null = null;

const json = (body: unknown) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });

beforeEach(() => {
  vi.useFakeTimers();
  history = [];
  nextJob = 1;
  FakeEventSource.instances = [];
  vi.stubGlobal("EventSource", FakeEventSource);
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/research/export-check")) return json({ warnings: [] });
      if (init?.method === "POST") {
        const jobId = `j${nextJob}`;
        nextJob += 1;
        return json({ jobId, status: "rendering" });
      }
      return json({ renders: history });
    }),
  );
});

afterEach(() => {
  queue?.unmount();
  queue = null;
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

async function startRender(): Promise<void> {
  await act(async () => {
    await queue?.api().startRender({});
  });
}

/** Runs the timers (and the promises they wake) for `ms`. */
async function elapse(ms: number): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

const jobs = () => queue?.api().jobs ?? [];
const source = (index: number): FakeEventSource => {
  const found = FakeEventSource.instances[index];
  if (!found) throw new Error(`no progress stream #${index}`);
  return found;
};

describe("a progress stream that drops", () => {
  it("is reopened, and the render stays what the server says it is", async () => {
    queue = mountRenderQueue(useRenderQueue);
    await startRender();

    await act(async () => source(0).drop());
    expect(jobs().at(-1)?.status).toBe("rendering");
    expect(source(0).closed).toBe(true);

    await elapse(1000);
    expect(FakeEventSource.instances).toHaveLength(2);
    await act(async () => source(1).emit({ status: "rendering", progress: 40, stage: "encode" }));
    expect(jobs().at(-1)).toMatchObject({ status: "rendering", progress: 40, stage: "encode" });

    await act(async () => source(1).emit({ status: "complete", progress: 100 }));
    expect(jobs().at(-1)?.status).toBe("complete");
    expect(source(1).closed).toBe(true);
  });

  it("adopts the server's record of a render it finished once the stream stays down", async () => {
    queue = mountRenderQueue(useRenderQueue);
    await startRender();
    history.push({
      id: "j1",
      filename: "j1.mp4",
      createdAt: 5,
      size: 10,
      status: "complete",
      durationMs: 1234,
    });

    for (const [index, wait] of [1000, 2000, 4000].entries()) {
      await act(async () => source(index).drop());
      await elapse(wait);
    }
    expect(FakeEventSource.instances).toHaveLength(4);
    await act(async () => source(3).drop());
    await elapse(0);

    expect(jobs().at(-1)).toMatchObject({
      id: "j1",
      status: "complete",
      progress: 100,
      durationMs: 1234,
    });
    expect(jobs().at(-1)?.connectionLost).toBeUndefined();
  });

  it("shows a render the server does not know as lost, and a later history load corrects the guess", async () => {
    queue = mountRenderQueue(useRenderQueue);
    await startRender();

    for (const [index, wait] of [1000, 2000, 4000].entries()) {
      await act(async () => source(index).drop());
      await elapse(wait);
    }
    await act(async () => source(3).drop());
    await elapse(0);
    expect(jobs().at(-1)).toMatchObject({ status: "failed", connectionLost: true });

    history.push({ id: "j1", filename: "j1.mp4", createdAt: 5, size: 10, status: "complete" });
    await act(async () => {
      await queue?.api().reloadRenders();
    });
    expect(jobs().filter((job) => job.id === "j1")).toEqual([
      expect.objectContaining({ status: "complete", progress: 100, filename: "j1.mp4" }),
    ]);
  });

  it("leaves a newer render's stream alone", async () => {
    queue = mountRenderQueue(useRenderQueue);
    await startRender();
    await startRender();
    expect(FakeEventSource.instances.map((stream) => stream.url)).toEqual([
      "/api/render/j1/progress",
      "/api/render/j2/progress",
    ]);

    await act(async () => source(0).drop());
    expect(source(1).closed).toBe(false);
    await act(async () => source(1).emit({ status: "rendering", progress: 25 }));
    expect(jobs().find((job) => job.id === "j2")).toMatchObject({
      status: "rendering",
      progress: 25,
    });

    await elapse(1000);
    expect(FakeEventSource.instances.map((stream) => stream.url)).toEqual([
      "/api/render/j1/progress",
      "/api/render/j2/progress",
      "/api/render/j1/progress",
    ]);
  });

  it("is not reopened once the render was cancelled", async () => {
    queue = mountRenderQueue(useRenderQueue);
    await startRender();
    await act(async () => source(0).drop());

    await act(async () => {
      await queue?.api().cancelRender("j1");
    });
    await elapse(5000);

    expect(FakeEventSource.instances).toHaveLength(1);
    expect(jobs().at(-1)?.status).toBe("cancelled");
  });
});
