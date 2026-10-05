// @vitest-environment node
import { Hono } from "hono";
import type { CompositionFramesResponse, EditError } from "@hyperframes/agent-protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createTestProject, type TestProject } from "../editing/testProject.js";
import type { StudioApiAdapter } from "../types.js";
import { registerCompositionFrameRoutes } from "./editingFrames.js";

let project: TestProject | undefined;
afterEach(() => {
  project?.cleanup();
  project = undefined;
});

type Capture = NonNullable<StudioApiAdapter["captureFrames"]>;

function setup(capture?: Capture) {
  const made = createTestProject({ adapter: capture ? { captureFrames: capture } : {} });
  project = made;
  const api = new Hono();
  registerCompositionFrameRoutes(api, made.adapter);
  const post = (body: unknown, id = "demo", init: RequestInit = {}) =>
    api.request(`/projects/${id}/editing/frames`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      ...init,
    });
  return { made, post };
}

const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xd9]);

function fakeCapture(calls: number[][]): Capture {
  return async ({ times, width }) => {
    calls.push(times);
    return {
      duration: 10,
      frames: times.map((time) => ({
        time,
        capturedAt: Math.min(time, 9.7),
        data: JPEG,
        width,
        height: Math.round((width * 9) / 16),
      })),
    };
  };
}

describe("POST /editing/frames", () => {
  it("returns the captured frames in request order, with the composition and its length", async () => {
    const calls: number[][] = [];
    const { post } = setup(fakeCapture(calls));
    const response = await post({ times: [3, 1, 12], width: 320 });
    expect(response.status).toBe(200);
    const body: CompositionFramesResponse = await response.json();
    expect(calls).toEqual([[3, 1, 12]]);
    expect(body.composition).toBe("index.html");
    expect(body.duration).toBe(10);
    expect(body.frames.map((frame) => [frame.time, frame.capturedAt, frame.cached])).toEqual([
      [3, 3, false],
      [1, 1, false],
      [12, 9.7, false],
    ]);
    expect(body.frames[0]).toMatchObject({ mimeType: "image/jpeg", width: 320, height: 180 });
    expect(Buffer.from(body.frames[0]!.data, "base64")).toEqual(Buffer.from(JPEG));
  });

  it("serves a repeated frame from the cache until a project file changes", async () => {
    const calls: number[][] = [];
    const { made, post } = setup(fakeCapture(calls));
    await post({ times: [1, 2] });
    const again: CompositionFramesResponse = await (await post({ times: [2, 3] })).json();
    expect(calls).toEqual([[1, 2], [3]]);
    expect(again.frames.map((frame) => frame.cached)).toEqual([true, false]);

    made.write("index.html", `${made.read("index.html")}\n<!-- edited -->\n`);
    const edited: CompositionFramesResponse = await (await post({ times: [2] })).json();
    expect(calls).toHaveLength(3);
    expect(edited.frames[0]?.cached).toBe(false);

    await post({ times: [2], width: 800 });
    expect(calls).toHaveLength(4);
  });

  it("does not cache frames when the project changed while they were captured", async () => {
    const calls: number[][] = [];
    const plain = fakeCapture(calls);
    let editDuringCapture = true;
    const { made, post } = setup(async (opts) => {
      const captured = await plain(opts);
      if (editDuringCapture)
        made.write("index.html", `${made.read("index.html")}\n<!-- raced -->\n`);
      return captured;
    });
    const first: CompositionFramesResponse = await (await post({ times: [1] })).json();
    expect(first.frames[0]?.cached).toBe(false);
    editDuringCapture = false;
    const second: CompositionFramesResponse = await (await post({ times: [1] })).json();
    expect(second.frames[0]?.cached).toBe(false);
    const third: CompositionFramesResponse = await (await post({ times: [1] })).json();
    expect(third.frames[0]?.cached).toBe(true);
    expect(calls).toEqual([[1], [1]]);
  });

  it("starts the capture timeout when the capture starts, not while it waits for the browser", async () => {
    const timeout = vi.spyOn(AbortSignal, "timeout");
    try {
      const release = Promise.withResolvers<void>();
      const started: number[] = [];
      const { post } = setup(async ({ times }) => {
        started.push(times[0] ?? -1);
        if (times[0] === 1) await release.promise;
        return fakeCapture([])({
          project: { dir: "" },
          composition: "",
          times,
          width: 640,
        } as never);
      });
      const slow = post({ times: [1] });
      await vi.waitFor(() => expect(started).toEqual([1]));
      const queued = post({ times: [2] });
      // The second request reaches the browser queue after a few macrotasks of body parsing and nothing signals it,
      // so a short real wait gives it time to queue (the assertion below holds trivially if it has not: it cannot flake).
      const settled = Promise.withResolvers<void>();
      setTimeout(settled.resolve, 20);
      await settled.promise;
      expect(started).toEqual([1]);
      expect(timeout).toHaveBeenCalledTimes(1);
      release.resolve();
      expect((await slow).status).toBe(200);
      expect((await queued).status).toBe(200);
      expect(timeout).toHaveBeenCalledTimes(2);
    } finally {
      timeout.mockRestore();
    }
  });

  it("passes the client's disconnect to the capture", async () => {
    const started = Promise.withResolvers<AbortSignal>();
    const stopped = Promise.withResolvers<void>();
    const { post } = setup(async ({ signal }) => {
      const done = Promise.withResolvers<never>();
      signal.addEventListener(
        "abort",
        () => {
          stopped.resolve();
          done.reject(signal.reason);
        },
        { once: true },
      );
      started.resolve(signal);
      return done.promise;
    });
    const abort = new AbortController();
    const pending = post({ times: [1] }, "demo", { signal: abort.signal }).catch(() => null);
    expect((await started.promise).aborted).toBe(false);
    abort.abort();
    await stopped.promise;
    await pending;
  });

  it("refuses bad requests, unknown compositions and a host without the capability", async () => {
    const calls: number[][] = [];
    const { post } = setup(fakeCapture(calls));
    for (const body of [
      {},
      { times: [] },
      { times: Array.from({ length: 13 }, (_, i) => i) },
      { times: [-1] },
      { times: [1], width: 20 },
      { times: [1], extra: true },
    ]) {
      const response = await post(body);
      expect(response.status).toBe(400);
      const { error }: { error: EditError } = await response.json();
      expect(error.code).toBe("invalid_request");
    }
    const unknown = await post({ times: [1], composition: "compositions/none.html" });
    expect(unknown.status).toBe(400);
    const missing: { error: EditError } = await unknown.json();
    expect(missing.error.code).toBe("unknown_composition");
    expect((await post({ times: [1] }, "ghost")).status).toBe(404);
    expect(calls).toEqual([]);

    const bare = setup();
    const unsupported = await bare.post({ times: [1] });
    expect(unsupported.status).toBe(400);
    const refusal: { error: EditError } = await unsupported.json();
    expect(refusal.error.code).toBe("unsupported");
  });

  it("reports an unavailable browser and a failed capture", async () => {
    const unavailable = setup(async () => ({ unavailable: "Chrome is not installed" }));
    const refused = await unavailable.post({ times: [1] });
    expect(refused.status).toBe(400);
    expect(await refused.json()).toEqual({
      error: { code: "unsupported", message: "Chrome is not installed" },
    });

    const crashing = setup(async () => {
      throw new Error("browser crashed");
    });
    const failed = await crashing.post({ times: [1] });
    expect(failed.status).toBe(500);
    expect(await failed.json()).toEqual({ error: "Capturing frames failed: browser crashed" });
  });
});
