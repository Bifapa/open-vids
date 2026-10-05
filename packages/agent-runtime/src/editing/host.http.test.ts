// @vitest-environment node
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import type { TimelineSnapshot } from "@hyperframes/agent-protocol";
import type { ProjectScope } from "../checkpointHost.js";
import { EditingError } from "./host.js";
import { HttpEditingHost } from "./host.http.js";

interface Seen {
  method: string;
  path: string;
  body: unknown;
}

type Route = (request: Seen, response: ServerResponse) => void;

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

const json = (response: ServerResponse, status: number, body: unknown) => {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
};

/** A loopback stand-in for Studio's routes: `routes` is keyed by "METHOD /path-without-query". */
async function studio(routes: Record<string, Route>) {
  const seen: Seen[] = [];
  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    let text = "";
    request.setEncoding("utf8");
    request.on("data", (chunk: string) => (text += chunk));
    request.on("end", () => {
      const url = request.url ?? "";
      const record: Seen = {
        method: request.method ?? "GET",
        path: url,
        body: text ? JSON.parse(text) : null,
      };
      seen.push(record);
      const route = routes[`${record.method} ${url.split("?")[0]}`];
      if (route) route(record, response);
      else json(response, 404, { error: `no route ${record.method} ${url}` });
    });
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
  return { host: new HttpEditingHost(scope), seen };
}

const timeline: TimelineSnapshot = {
  composition: { path: "index.html", width: 1920, height: 1080, duration: 4 },
  version: "v7",
  tracks: [{ index: 0, clipIds: ["c1"] }],
  clips: [
    {
      id: "c1",
      domId: null,
      kind: "video",
      label: "a.mp4",
      start: 0,
      duration: 4,
      end: 4,
      track: 0,
      zIndex: 1,
      src: "assets/a.mp4",
      mediaStart: 0,
      sourceDuration: 10,
      volume: 1,
      muted: false,
      compositionSrc: null,
      locked: false,
      provenance: null,
    },
  ],
};

const sse = (response: ServerResponse) => {
  response.writeHead(200, { "content-type": "text/event-stream" });
  return (data: unknown) => response.write(`event: progress\ndata: ${JSON.stringify(data)}\n\n`);
};

const abortSignal = () => new AbortController().signal;

describe("HttpEditingHost", () => {
  it("maps a service EditError onto a typed EditingError with its code and failing operation", async () => {
    const { host } = await studio({
      "POST /api/projects/p%201/editing/apply": (_request, response) =>
        json(response, 400, {
          error: { code: "unknown_clip", message: "no clip nope", opIndex: 2 },
        }),
    });
    const error = await host
      .apply({ operations: [{ op: "remove_clip", clip: "nope" }] }, abortSignal())
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(EditingError);
    expect(error).toMatchObject({ code: "unknown_clip", message: "no clip nope", opIndex: 2 });
  });

  it("accepts the fragment the user picked on an inventory asset and rejects a malformed one", async () => {
    const asset = (range: unknown) => ({
      path: "assets/music.mp3",
      kind: "audio",
      bytes: 6_000_000,
      duration: 182,
      width: null,
      height: null,
      hasAudio: null,
      ...(range === undefined ? {} : { range }),
    });
    const inventoryOf = (range: unknown) => ({
      compositions: [],
      assets: [asset(range)],
      renders: [],
    });
    const { host } = await studio({
      "GET /api/projects/p%201/editing/project": (_request, response) =>
        json(response, 200, inventoryOf({ start: 42, end: 75.5 })),
    });
    const inventory = await host.inventory(abortSignal());
    expect(inventory.assets[0]?.range).toEqual({ start: 42, end: 75.5 });

    const garbled = await studio({
      "GET /api/projects/p%201/editing/project": (_request, response) =>
        json(response, 200, inventoryOf({ start: "42", end: 75.5 })),
    });
    await expect(garbled.host.inventory(abortSignal())).rejects.toMatchObject({
      code: "unavailable",
    });
  });

  it("treats an unreachable or garbled service as unavailable, and a conflict as its own code", async () => {
    const { host } = await studio({
      "GET /api/projects/p%201/editing/timeline": (_request, response) =>
        json(response, 200, { nonsense: true }),
      "POST /api/projects/p%201/editing/apply": (_request, response) =>
        json(response, 409, { error: { code: "conflict", message: "stale" } }),
    });
    await expect(host.timeline(undefined, abortSignal())).rejects.toMatchObject({
      code: "unavailable",
    });
    await expect(
      host.apply(
        { baseVersion: "v1", operations: [{ op: "set_composition", duration: 3 }] },
        abortSignal(),
      ),
    ).rejects.toMatchObject({ code: "conflict" });
  });

  it("sends the composition and the batch to the editing routes", async () => {
    const { host, seen } = await studio({
      "GET /api/projects/p%201/editing/timeline": (_request, response) =>
        json(response, 200, timeline),
    });
    await expect(host.timeline("scenes/a.html", abortSignal())).resolves.toMatchObject({
      version: "v7",
    });
    expect(seen[0]?.path).toBe("/api/projects/p%201/editing/timeline?composition=scenes%2Fa.html");
  });

  it("follows render progress to completion and returns the probed output", async () => {
    const progress: number[] = [];
    const { host, seen } = await studio({
      "POST /api/projects/p%201/render": (_request, response) =>
        json(response, 200, { jobId: "job1", status: "rendering" }),
      "GET /api/render/job1/progress": (_request, response) => {
        const send = sse(response);
        send({ progress: 10, status: "rendering", stage: "capture", error: null });
        send({ progress: 100, status: "complete", stage: "done", error: null });
        response.end();
      },
      "GET /api/projects/p%201/renders": (_request, response) =>
        json(response, 200, { renders: [{ id: "job1", filename: "job1.mp4", size: 5 }] }),
      "GET /api/projects/p%201/editing/probe": (_request, response) =>
        json(response, 200, {
          path: "renders/job1.mp4",
          kind: "video",
          bytes: 2_000_000,
          duration: 4.02,
          width: 1920,
          height: 1080,
          hasAudio: true,
        }),
      "GET /api/projects/p%201/media/metadata": (_request, response) =>
        json(response, 200, {
          path: "renders/job1.mp4",
          metadata: { color: { codecName: "h264" } },
        }),
    });
    const output = await host.render({ quality: "draft" }, abortSignal(), (event) =>
      progress.push(event.progress),
    );
    expect(output).toEqual({
      path: "renders/job1.mp4",
      bytes: 2_000_000,
      duration: 4.02,
      width: 1920,
      height: 1080,
      videoCodec: "h264",
      hasAudio: true,
    });
    expect(progress).toEqual([10, 100]);
    expect(seen[0]?.body).toEqual({ quality: "draft", format: "mp4" });
  });

  it("fails a render whose output is missing or has no duration, and one that reports failure", async () => {
    const finish =
      (status: string, error: string | null): Route =>
      (_request, response) => {
        sse(response)({ progress: 100, status, stage: "x", error });
        response.end();
      };
    const base = {
      "POST /api/projects/p%201/render": ((_request, response) =>
        json(response, 200, { jobId: "job1" })) satisfies Route,
    };
    const empty = await studio({
      ...base,
      "GET /api/render/job1/progress": finish("complete", null),
      "GET /api/projects/p%201/renders": (_request, response) =>
        json(response, 200, { renders: [{ id: "job1", filename: "job1.mp4" }] }),
      "GET /api/projects/p%201/editing/probe": (_request, response) =>
        json(response, 200, {
          path: "renders/job1.mp4",
          kind: "video",
          bytes: 0,
          duration: null,
          width: null,
          height: null,
          hasAudio: null,
        }),
    });
    await expect(
      empty.host.render({ quality: "standard" }, abortSignal(), () => {}),
    ).rejects.toMatchObject({
      code: "render_failed",
    });

    const missing = await studio({
      ...base,
      "GET /api/render/job1/progress": finish("complete", null),
      "GET /api/projects/p%201/renders": (_request, response) =>
        json(response, 200, { renders: [] }),
    });
    await expect(
      missing.host.render({ quality: "standard" }, abortSignal(), () => {}),
    ).rejects.toMatchObject({
      code: "render_failed",
    });

    const failed = await studio({
      ...base,
      "GET /api/render/job1/progress": finish("failed", "ffmpeg exploded"),
    });
    await expect(
      failed.host.render({ quality: "standard" }, abortSignal(), () => {}),
    ).rejects.toMatchObject({
      code: "render_failed",
      message: "ffmpeg exploded",
    });
  });

  it("cancels the render on the service when aborted and rejects as aborted", async () => {
    const controller = new AbortController();
    const streaming = Promise.withResolvers<void>();
    const { host, seen } = await studio({
      "POST /api/projects/p%201/render": (_request, response) =>
        json(response, 200, { jobId: "job1" }),
      "GET /api/render/job1/progress": (_request, response) => {
        sse(response)({ progress: 5, status: "rendering", stage: "capture", error: null });
        streaming.resolve();
      },
      "POST /api/render/job1/cancel": (_request, response) =>
        json(response, 200, { status: "cancelled" }),
    });
    const rendering = host.render({ quality: "standard" }, controller.signal, () => {});
    await streaming.promise;
    controller.abort();
    await expect(rendering).rejects.toMatchObject({ code: "aborted" });
    expect(seen.map((request) => `${request.method} ${request.path}`)).toContain(
      "POST /api/render/job1/cancel",
    );
  });

  it("does not send an edit when the turn was already aborted", async () => {
    const { host, seen } = await studio({});
    const controller = new AbortController();
    controller.abort();
    await expect(
      host.apply({ operations: [{ op: "set_composition", duration: 3 }] }, controller.signal),
    ).rejects.toMatchObject({ code: "aborted" });
    expect(seen).toHaveLength(0);
  });

  it("sends the request id and dry run flag with the batch", async () => {
    const { host, seen } = await studio({
      "POST /api/projects/p%201/editing/apply": (_request, response) =>
        json(response, 200, { timeline, results: [], changedFiles: [] }),
    });
    await host.apply(
      { requestId: "ov-abc", dryRun: true, operations: [{ op: "set_composition", duration: 3 }] },
      abortSignal(),
    );
    expect(seen[0]?.body).toMatchObject({ requestId: "ov-abc", dryRun: true });
  });

  it("asks Studio to stop a batch when the turn aborts, and still reports what Studio answers", async () => {
    const reached = Promise.withResolvers<void>();
    const { host, seen } = await studio({
      "POST /api/projects/p%201/editing/apply": (_request, response) => {
        reached.resolve();
        // Studio answers once it was told to stop: nothing was written.
        const wait = setInterval(() => {
          if (seen.some((request) => request.path.endsWith("/editing/cancel"))) {
            clearInterval(wait);
            json(response, 400, {
              error: { code: "aborted", message: "cancelled before writing" },
            });
          }
        }, 5);
      },
      "POST /api/projects/p%201/editing/cancel": (_request, response) =>
        json(response, 200, { cancelled: true }),
    });
    const controller = new AbortController();
    const applying = host.apply(
      { requestId: "ov-1", operations: [{ op: "set_composition", duration: 3 }] },
      controller.signal,
    );
    await reached.promise;
    controller.abort();
    await expect(applying).rejects.toMatchObject({ code: "aborted" });
    expect(seen.find((request) => request.path.endsWith("/editing/cancel"))?.body).toEqual({
      requestId: "ov-1",
    });
  });

  it("reads a page of presets with the total", async () => {
    const { host, seen } = await studio({
      "GET /api/projects/p%201/editing/presets": (_request, response) =>
        json(response, 200, {
          presets: [
            { name: "a", kind: "audio_fx", title: "A", description: "", tags: [], duration: null },
          ],
          total: 9,
        }),
    });
    const page = await host.presets("audio_fx", "voice", abortSignal(), { offset: 2, limit: 1 });
    expect(page.total).toBe(9);
    expect(page.presets).toHaveLength(1);
    expect(seen[0]?.path).toContain("kind=audio_fx");
    expect(seen[0]?.path).toContain("offset=2");
    expect(seen[0]?.path).toContain("limit=1");
  });
});
