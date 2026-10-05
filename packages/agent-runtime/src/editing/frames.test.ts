// @vitest-environment node
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import {
  SPECIALIST_IDS,
  type AgentId,
  type CompositionFramesResponse,
  type SpecialistId,
} from "@hyperframes/agent-protocol";
import type { ProjectScope } from "../checkpointHost.js";
import { FAKE_JPEG } from "../testing/analysis.js";
import { FakeFramesHost } from "../testing/frames.js";
import { FramesError } from "./frames.js";
import { TurnFrames } from "./frames.executor.js";
import { HttpFramesHost } from "./frames.http.js";
import { buildFrameTools, framesToolsFor } from "./frames.tools.js";

const signal = () => new AbortController().signal;

describe("inspect_composition availability", () => {
  const every: AgentId[] = ["director", ...SPECIALIST_IDS, "jev"];

  it("is for the Director, Editor, Motion and Vision whatever is enabled", () => {
    const enabledSets: SpecialistId[][] = [
      [],
      [...SPECIALIST_IDS],
      ["editor"],
      ["vision", "audio"],
    ];
    for (const enabled of enabledSets) {
      const withTool = every.filter((agent) => framesToolsFor(agent, enabled).length > 0);
      expect(withTool.sort()).toEqual(["director", "editor", "motion", "vision"]);
    }
  });

  it("describes the call as an activity row with a label code and the frame count", () => {
    const [tool] = buildFrameTools("editor", [], async () => ({ text: "" }));
    expect(tool?.name).toBe("inspect_composition");
    expect(tool?.activity?.({ times: [1, 2, 3] })).toEqual({
      category: "inspect",
      label: "Looking at 3 frames of the composition",
      labelCode: "inspecting_composition",
      labelParams: { count: 3 },
    });
    expect(tool?.activity?.({ times: [1] })?.label).toBe("Looking at 1 frame of the composition");
    expect(tool?.activity?.("garbage")?.labelParams).toEqual({ count: 0 });
  });
});

describe("TurnFrames", () => {
  const run = (frames: TurnFrames, args: unknown) =>
    frames.execute("inspect_composition", args, signal());

  it("returns the frames as images with a text that names each second and the clamped end", async () => {
    const host = new FakeFramesHost();
    const frames = new TurnFrames({ host, turnSignal: signal() });
    const result = await run(frames, { times: [2, 30], composition: "compositions/a.html" });
    expect(result.isError).toBeUndefined();
    expect(host.requests).toEqual([{ composition: "compositions/a.html", times: [2, 30] }]);
    expect(result.images).toEqual([
      { mimeType: "image/jpeg", data: FAKE_JPEG },
      { mimeType: "image/jpeg", data: FAKE_JPEG },
    ]);
    expect(result.text).toContain("2 frames of compositions/a.html (10 s long)");
    expect(result.text).toContain(
      "2. 30 s — the composition ends at 10 s: this is its last readable frame",
    );
  });

  it("ignores null arguments and refuses bad ones with the reason", async () => {
    const host = new FakeFramesHost();
    const frames = new TurnFrames({ host, turnSignal: signal() });
    expect((await run(frames, { times: [1], composition: null })).isError).toBeUndefined();
    for (const args of [
      {},
      { times: [] },
      { times: [-2] },
      { times: Array.from({ length: 13 }, (_, i) => i) },
    ]) {
      const refused = await run(frames, args);
      expect(refused.isError).toBe(true);
      expect(refused.text).toMatch(/^invalid_request:/);
    }
    expect(host.requests).toHaveLength(1);
  });

  it("keeps a per-turn frame budget, gives cached frames back and frees a failed call's frames", async () => {
    const host = new FakeFramesHost();
    const frames = new TurnFrames({ host, turnSignal: signal(), frameBudget: 4 });
    expect((await run(frames, { times: [1, 2, 3] })).isError).toBeUndefined();

    const over = await run(frames, { times: [4, 5] });
    expect(over.isError).toBe(true);
    expect(over.text).toContain("Frame budget reached: 3 of 4 frames");
    expect(over.text).toContain("at most 1 frame;");
    expect(host.requests).toHaveLength(1);

    // The project did not change: the same times are answered from the cache and given back.
    for (const time of [1, 2, 3]) host.cachedTimes.add(time);
    for (const time of [1, 2, 3, 1, 2, 3]) {
      expect((await run(frames, { times: [time] })).isError).toBeUndefined();
    }

    host.nextError = new FramesError("unavailable", "Chrome is not installed");
    const failed = await run(frames, { times: [7] });
    expect(failed).toEqual({ text: "unavailable: Chrome is not installed", isError: true });
    expect((await run(frames, { times: [8] })).isError).toBeUndefined();
    expect((await run(frames, { times: [9] })).isError).toBe(true);
  });

  it("shares the budget between parallel calls and stops a running capture on shutdown", async () => {
    const pending = Promise.withResolvers<CompositionFramesResponse>();
    const started = Promise.withResolvers<AbortSignal>();
    const frames = new TurnFrames({
      host: {
        frames: (_request, callSignal) => {
          started.resolve(callSignal);
          return pending.promise;
        },
      },
      turnSignal: signal(),
      frameBudget: 3,
    });
    const first = run(frames, { times: [1, 2] });
    const second = await run(frames, { times: [3, 4] });
    expect(second.isError).toBe(true);
    expect(second.text).toContain("Frame budget reached");

    const callSignal = await started.promise;
    const closing = frames.shutdown();
    expect(callSignal.aborted).toBe(true);
    pending.reject(new FramesError("aborted", "The operation was cancelled."));
    expect(await first).toEqual({ text: "The operation was cancelled.", isError: true });
    await closing;
    expect((await run(frames, { times: [1] })).text).toContain("finishing");
  });

  it("aborts the host call with the turn", async () => {
    const host = new FakeFramesHost();
    const turn = new AbortController();
    const frames = new TurnFrames({ host, turnSignal: turn.signal });
    await run(frames, { times: [1] });
    turn.abort();
    expect(host.signals[0]?.aborted).toBe(true);
  });
});

describe("HttpFramesHost", () => {
  const servers: Server[] = [];
  afterEach(async () => {
    await Promise.all(
      servers.splice(0).map(
        (server) =>
          new Promise<void>((resolve) => {
            server.closeAllConnections();
            server.close(() => resolve());
          }),
      ),
    );
  });

  async function studio(handler: (body: unknown, response: ServerResponse, url: string) => void) {
    const server = createServer((request: IncomingMessage, response: ServerResponse) => {
      let text = "";
      request.setEncoding("utf8");
      request.on("data", (chunk: string) => (text += chunk));
      request.on("end", () => handler(text ? JSON.parse(text) : null, response, request.url ?? ""));
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("no port");
    const scope: ProjectScope = {
      projectId: "p 1",
      projectDir: "/tmp/p",
      studioOrigin: `http://127.0.0.1:${address.port}`,
    };
    return new HttpFramesHost(scope);
  }

  const reply = (response: ServerResponse, status: number, body: unknown) => {
    response.writeHead(status, { "content-type": "application/json" });
    response.end(JSON.stringify(body));
  };

  it("posts the request to the project's frames route and returns the response", async () => {
    const seen: Array<{ body: unknown; url: string }> = [];
    const answer: CompositionFramesResponse = {
      composition: "index.html",
      duration: 4,
      frames: [
        {
          time: 1,
          capturedAt: 1,
          mimeType: "image/jpeg",
          data: FAKE_JPEG,
          width: 640,
          height: 360,
          cached: false,
        },
      ],
    };
    const host = await studio((body, response, url) => {
      seen.push({ body, url });
      reply(response, 200, answer);
    });
    expect(await host.frames({ times: [1], width: 640 }, signal())).toEqual(answer);
    expect(seen).toEqual([
      { body: { times: [1], width: 640 }, url: "/api/projects/p%201/editing/frames" },
    ]);
  });

  it("maps the route's errors to FramesError", async () => {
    const coded = await studio((_body, response) =>
      reply(response, 400, {
        error: { code: "unknown_composition", message: "No composition x.html" },
      }),
    );
    await expect(coded.frames({ times: [1] }, signal())).rejects.toMatchObject({
      code: "unknown_composition",
      message: "No composition x.html",
    });
    const plain = await studio((_body, response) =>
      reply(response, 500, { error: "Capturing frames failed: browser crashed" }),
    );
    await expect(plain.frames({ times: [1] }, signal())).rejects.toMatchObject({
      code: "unavailable",
      message: "Capturing frames failed: browser crashed",
    });
    const garbage = await studio((_body, response) => reply(response, 200, { frames: "no" }));
    await expect(garbage.frames({ times: [1] }, signal())).rejects.toMatchObject({
      code: "unavailable",
    });
  });

  it("aborts the request with the caller's signal", async () => {
    const reached = Promise.withResolvers<void>();
    const host = await studio(() => reached.resolve());
    const abort = new AbortController();
    const pending = host.frames({ times: [1] }, abort.signal);
    const outcome = expect(pending).rejects.toMatchObject({ code: "aborted" });
    await reached.promise;
    abort.abort();
    await outcome;
  });
});
