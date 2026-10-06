// @vitest-environment happy-dom

// The machine runs one render at a time: a render asked for while another runs (this project's, another project's, the
// agent's) is answered `queued` and progresses to `rendering` when its turn comes. A queued row is still work in
// progress: it locks the settings, can be cancelled, and the row says where it stands.

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
  private listener: ((event: MessageEvent) => void) | null = null;

  constructor(readonly url: string) {
    FakeEventSource.instances.push(this);
  }

  addEventListener(_type: string, listener: (event: MessageEvent) => void): void {
    this.listener = listener;
  }

  close(): void {
    this.closed = true;
  }

  emit(payload: object): void {
    this.listener?.(new MessageEvent("progress", { data: JSON.stringify(payload) }));
  }
}

const json = (body: unknown) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });

let queue: MountedQueue | null = null;
let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  FakeEventSource.instances = [];
  vi.stubGlobal("EventSource", FakeEventSource);
  fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.includes("/research/export-check")) return json({ warnings: [] });
    if (url.endsWith("/cancel")) return json({ status: "cancelled" });
    if (init?.method === "POST") {
      return json({
        jobId: "j1",
        status: "queued",
        queuePosition: 2,
        queueHolder: { projectName: "Promo" },
      });
    }
    return json({ renders: [] });
  });
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  queue?.unmount();
  queue = null;
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
});

async function startRender(): Promise<void> {
  await act(async () => {
    await queue?.api().startRender({});
  });
}

const lastJob = () => queue?.api().jobs.at(-1);

describe("a render that has to wait for the render slot", () => {
  it("starts as queued with its place and who is rendering, and counts as work in progress", async () => {
    queue = mountRenderQueue(useRenderQueue);
    await startRender();
    expect(lastJob()).toMatchObject({ status: "queued", queuePosition: 2, queueHolder: "Promo" });
    expect(queue.api().isRendering).toBe(true);
  });

  it("follows the queue to its turn and on to the outcome", async () => {
    queue = mountRenderQueue(useRenderQueue);
    await startRender();
    const stream = FakeEventSource.instances[0];
    if (!stream) throw new Error("no progress stream");

    await act(async () =>
      stream.emit({
        status: "queued",
        progress: 0,
        queuePosition: 1,
        queueHolder: { projectName: "Promo" },
      }),
    );
    expect(lastJob()).toMatchObject({ status: "queued", queuePosition: 1, queueHolder: "Promo" });

    await act(async () => stream.emit({ status: "rendering", progress: 12, stage: "capture" }));
    expect(lastJob()).toMatchObject({ status: "rendering", progress: 12, stage: "capture" });
    expect(lastJob()?.queuePosition).toBeUndefined();
    expect(lastJob()?.queueHolder).toBeUndefined();

    await act(async () => stream.emit({ status: "complete", progress: 100 }));
    expect(lastJob()?.status).toBe("complete");
    expect(queue.api().isRendering).toBe(false);
  });

  it("is cancelled in the queue like a running render, and a late event does not revive it", async () => {
    queue = mountRenderQueue(useRenderQueue);
    await startRender();
    const stream = FakeEventSource.instances[0];
    if (!stream) throw new Error("no progress stream");

    await act(async () => {
      await queue?.api().cancelRender("j1");
    });
    expect(lastJob()).toMatchObject({ status: "cancelled" });
    expect(stream.closed).toBe(true);
    expect(fetchMock).toHaveBeenCalledWith("/api/render/j1/cancel", { method: "POST" });

    await act(async () => stream.emit({ status: "rendering", progress: 3 }));
    expect(lastJob()?.status).toBe("cancelled");
    expect(queue.api().isRendering).toBe(false);
  });
});
