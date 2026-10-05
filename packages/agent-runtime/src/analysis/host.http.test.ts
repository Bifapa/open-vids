// @vitest-environment node
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import type { AnalysisJob, CutPlan } from "@hyperframes/agent-protocol";
import type { ProjectScope } from "../checkpointHost.js";
import { AnalysisToolError } from "./host.js";
import { HttpAnalysisHost } from "./host.http.js";
import { analyzeAndWait } from "./jobs.js";

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

const PREFIX = "/api/projects/p%201/analysis";

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
  return { host: new HttpAnalysisHost(scope), seen };
}

const abortSignal = () => new AbortController().signal;

const job = (status: AnalysisJob["status"], extra: Partial<AnalysisJob> = {}): AnalysisJob => ({
  id: "job 1",
  source: "assets/a.mp4",
  status,
  stage: status === "running" ? "transcript" : null,
  progress: 10,
  results: [],
  error: null,
  startedAt: 1,
  finishedAt: status === "running" ? null : 2,
  ...extra,
});

const plan: CutPlan = {
  id: "cut-1",
  source: "assets/a.mp4",
  label: "rough cut",
  createdAt: 1,
  basedOn: null,
  stats: {
    sourceDuration: 100,
    cutDuration: 60,
    ranges: 1,
    removedPauseSeconds: 0,
    removedFillers: 0,
    removedTakes: 0,
    droppedSegments: [],
    movedSegments: [],
    hookSeconds: 0,
  },
  applied: null,
  request: { source: "assets/a.mp4" },
  transcriptVersion: "sha256:aa",
  segmentsVersion: "sha256:bb",
  ranges: [{ from: 0, to: 60, at: 0, segment: null, hook: false }],
  removed: [],
  warnings: [],
};

describe("HttpAnalysisHost", () => {
  it("maps a service AnalysisError onto a typed AnalysisToolError with its code", async () => {
    const { host } = await studio({
      [`POST ${PREFIX}/frames`]: (_request, response) =>
        json(response, 404, { error: { code: "unknown_source", message: "no such file" } }),
    });
    const error = await host
      .frames({ source: "x.mp4", times: [1] }, abortSignal())
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(AnalysisToolError);
    expect(error).toMatchObject({ code: "unknown_source", message: "no such file" });
  });

  it("reports a service that fails without an analysis error, or answers nonsense, as unavailable", async () => {
    const { host } = await studio({
      [`GET ${PREFIX}/overview`]: (_request, response) => json(response, 200, { nonsense: true }),
      [`GET ${PREFIX}/cuts/cut-1`]: (_request, response) => json(response, 500, { error: "boom" }),
    });
    await expect(host.overview("a.mp4", abortSignal())).rejects.toMatchObject({
      code: "unavailable",
      message: "Studio returned an invalid analysis overview.",
    });
    await expect(host.getCut("cut-1", abortSignal())).rejects.toMatchObject({
      code: "unavailable",
      message: "boom",
    });
  });

  it("reports an unreachable Studio as unavailable and an aborted call as aborted", async () => {
    const { host } = await studio({});
    const closed = new HttpAnalysisHost({
      projectId: "p",
      projectDir: "/tmp/p",
      studioOrigin: "http://127.0.0.1:1",
    });
    await expect(closed.getJob("j", abortSignal())).rejects.toMatchObject({ code: "unavailable" });

    const controller = new AbortController();
    controller.abort();
    await expect(host.getJob("j", controller.signal)).rejects.toMatchObject({ code: "aborted" });
  });

  it("uses the documented routes, methods, query strings and bodies", async () => {
    const summary = { ...plan, request: undefined, ranges: undefined };
    const { host, seen } = await studio({
      [`POST ${PREFIX}/jobs`]: (_request, response) => json(response, 200, job("running")),
      [`GET ${PREFIX}/transcript`]: (_request, response) =>
        json(response, 200, {
          source: "a b.mp4",
          version: "sha256:aa",
          language: "en",
          from: 5,
          to: 9,
          sentences: [],
          totalSentences: 0,
        }),
      [`GET ${PREFIX}/artifact`]: (_request, response) =>
        json(response, 200, {
          source: "a.mp4",
          thresholdDb: -35,
          minSilence: 0.3,
          silences: [],
          silenceSeconds: 0,
        }),
      [`PUT ${PREFIX}/segments`]: (_request, response) =>
        json(response, 200, {
          source: "a.mp4",
          origin: "semantic",
          transcriptVersion: "v",
          segments: [],
        }),
      [`POST ${PREFIX}/vision`]: (_request, response) =>
        json(response, 200, { source: "a.mp4", notes: [], inspectedFrames: [] }),
      [`POST ${PREFIX}/frames`]: (_request, response) =>
        json(response, 200, {
          source: "a.mp4",
          frames: [{ time: 1, mimeType: "image/jpeg", data: "AAAA", cached: false }],
        }),
      [`POST ${PREFIX}/cuts`]: (_request, response) => json(response, 200, plan),
      [`GET ${PREFIX}/cuts`]: (_request, response) => json(response, 200, { plans: [summary] }),
    });
    const signal = abortSignal();
    await host.startJob({ source: "assets/a b.mp4", language: "en" }, signal);
    await host.transcript("a b.mp4", { from: 5, to: 9, words: true }, signal);
    await host.artifact("a.mp4", "silence", signal);
    await host.saveSegments({ source: "a.mp4", transcriptVersion: "v", segments: [] }, signal);
    await host.saveVisionNotes({ source: "a.mp4", notes: [] }, signal);
    const frames = await host.frames({ source: "a.mp4", times: [1], width: 320 }, signal);
    await host.planCut({ source: "a.mp4", maxPause: 0.5 }, signal);
    await host.listCuts("a.mp4", signal);

    expect(frames.frames[0]?.data).toBe("AAAA");
    expect(seen.map((request) => `${request.method} ${request.path}`)).toEqual([
      `POST ${PREFIX}/jobs`,
      `GET ${PREFIX}/transcript?source=a+b.mp4&from=5&to=9&words=1`,
      `GET ${PREFIX}/artifact?source=a.mp4&stage=silence`,
      `PUT ${PREFIX}/segments`,
      `POST ${PREFIX}/vision`,
      `POST ${PREFIX}/frames`,
      `POST ${PREFIX}/cuts`,
      `GET ${PREFIX}/cuts?source=a.mp4`,
    ]);
    expect(seen[0]?.body).toEqual({ source: "assets/a b.mp4", language: "en" });
    expect(seen[5]?.body).toEqual({ source: "a.mp4", times: [1], width: 320 });
  });
});

describe("analyzeAndWait over HTTP", () => {
  it("polls the job until it has finished", async () => {
    let polls = 0;
    const { host, seen } = await studio({
      [`POST ${PREFIX}/jobs`]: (_request, response) => json(response, 200, job("running")),
      [`GET ${PREFIX}/jobs/job%201`]: (_request, response) => {
        polls += 1;
        json(response, 200, job(polls < 3 ? "running" : "completed"));
      },
    });
    const done = await analyzeAndWait(host, { source: "assets/a.mp4" }, abortSignal(), 1);
    expect(done.status).toBe("completed");
    expect(seen.filter((request) => request.method === "GET")).toHaveLength(3);
  });

  it("cancels the job on the service when the call is aborted, and rejects with aborted", async () => {
    const controller = new AbortController();
    const { host, seen } = await studio({
      [`POST ${PREFIX}/jobs`]: (_request, response) => json(response, 200, job("running")),
      [`GET ${PREFIX}/jobs/job%201`]: (_request, response) => {
        controller.abort();
        json(response, 200, job("running"));
      },
      [`POST ${PREFIX}/jobs/job%201/cancel`]: (_request, response) =>
        json(response, 200, job("cancelled")),
    });
    await expect(
      analyzeAndWait(host, { source: "assets/a.mp4" }, controller.signal, 1),
    ).rejects.toMatchObject({ code: "aborted" });
    expect(seen.map((request) => `${request.method} ${request.path}`)).toContain(
      `POST ${PREFIX}/jobs/job%201/cancel`,
    );
  });

  it("does not cancel a job it only joined when the call is aborted", async () => {
    const controller = new AbortController();
    const { host, seen } = await studio({
      // The service answers with the job the user's Media panel started a minute ago.
      [`POST ${PREFIX}/jobs`]: (_request, response) =>
        json(response, 200, job("running", { joined: true })),
      [`GET ${PREFIX}/jobs/job%201`]: (_request, response) => {
        controller.abort();
        json(response, 200, job("running"));
      },
    });
    await expect(
      analyzeAndWait(host, { source: "assets/a.mp4" }, controller.signal, 1),
    ).rejects.toMatchObject({ code: "aborted" });
    expect(seen.some((request) => request.path.endsWith("/cancel"))).toBe(false);
  });

  it("passes on the service's refusal of a request the running job would not satisfy, with what to do next", async () => {
    const refused = await studio({
      [`POST ${PREFIX}/jobs`]: (_request, response) =>
        json(response, 409, {
          error: {
            code: "conflict",
            message: "assets/a.mp4 is already being analysed without recomputing transcript",
          },
        }),
    });
    await expect(
      analyzeAndWait(refused.host, { source: "assets/a.mp4", force: true }, abortSignal(), 1),
    ).rejects.toMatchObject({
      code: "conflict",
      message: expect.stringMatching(
        /already being analysed.*Nothing was started.*without force or language/s,
      ),
    });
  });

  it("surfaces the error of a job that failed, and of a job someone else cancelled", async () => {
    const failed = await studio({
      [`POST ${PREFIX}/jobs`]: (_request, response) =>
        json(
          response,
          200,
          job("failed", { error: { code: "failed", message: "ffmpeg is missing" } }),
        ),
    });
    await expect(
      analyzeAndWait(failed.host, { source: "assets/a.mp4" }, abortSignal(), 1),
    ).rejects.toMatchObject({ code: "failed", message: "ffmpeg is missing" });

    const cancelled = await studio({
      [`POST ${PREFIX}/jobs`]: (_request, response) => json(response, 200, job("cancelled")),
    });
    await expect(
      analyzeAndWait(cancelled.host, { source: "assets/a.mp4" }, abortSignal(), 1),
    ).rejects.toMatchObject({ code: "cancelled" });
  });

  it("returns a job whose other stages finished when one stage failed", async () => {
    const partial = await studio({
      [`POST ${PREFIX}/jobs`]: (_request, response) =>
        json(
          response,
          200,
          job("failed", {
            error: { code: "failed", message: "speakers: diarizer crashed" },
            results: [
              { stage: "speakers", outcome: "failed", seconds: 1, detail: "diarizer crashed" },
              { stage: "transcript", outcome: "computed", seconds: 30, detail: null },
            ],
          }),
        ),
    });
    const done = await analyzeAndWait(partial.host, { source: "assets/a.mp4" }, abortSignal(), 1);
    expect(done.results.map((result) => result.outcome)).toEqual(["failed", "computed"]);
  });
});
