// @vitest-environment node
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import type { QaReportInput } from "@hyperframes/agent-protocol";
import type { ProjectScope } from "../checkpointHost.js";
import { FAKE_JPEG } from "../testing/analysis.js";
import { FakeQaHost, cleanCheck, qaDraft } from "../testing/qa.js";
import { QaToolError } from "./host.js";
import { HttpQaHost } from "./host.http.js";

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

const PREFIX = "/api/projects/p%201/qa";

/** A loopback stand-in for Studio's QA routes: `routes` is keyed by "METHOD /path". */
async function studio(routes: Record<string, Route>) {
  const seen: Seen[] = [];
  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    let text = "";
    request.setEncoding("utf8");
    request.on("data", (chunk: string) => (text += chunk));
    request.on("end", () => {
      const record: Seen = {
        method: request.method ?? "GET",
        path: request.url ?? "",
        body: text ? JSON.parse(text) : null,
      };
      seen.push(record);
      const route = routes[`${record.method} ${record.path}`];
      if (route) route(record, response);
      else json(response, 404, { error: `no route ${record.method} ${record.path}` });
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
  return { host: new HttpQaHost(scope), seen };
}

const signal = () => new AbortController().signal;

const REPORT_INPUT: QaReportInput = {
  sessionId: "turn-1",
  turnId: "turn-1",
  chatId: "chat-1",
  pass: 1,
  passLimit: 2,
  preset: "balanced",
  composition: "index.html",
  fingerprint: "fp-1",
  timelineVersion: "v1",
  render: {
    path: "renders/final.mp4",
    duration: 12,
    width: 1920,
    height: 1080,
    hasAudio: true,
    quality: "draft",
    origin: "qa",
  },
  renderError: null,
  checks: [{ id: "render", status: "ran", detail: null }],
  vision: { status: "ran", reason: null, frames: 2, rounds: 1, model: "p/m" },
  issues: [{ ...qaDraft(), id: "p1-1", status: "new", firstSeenPass: 1 }],
  resolved: [],
  previousReportId: null,
};

describe("HttpQaHost", () => {
  it("reads the fingerprint, runs a check, extracts frames and stores a report through the project's QA routes", async () => {
    const stored = await new FakeQaHost().saveReport(REPORT_INPUT, signal());
    const check = cleanCheck({ issues: [qaDraft()] });
    const { host, seen } = await studio({
      [`GET ${PREFIX}/state`]: (_request, response) => json(response, 200, { fingerprint: "fp-7" }),
      [`POST ${PREFIX}/check`]: (_request, response) => json(response, 200, check),
      [`POST ${PREFIX}/frames`]: (_request, response) =>
        json(response, 200, {
          frames: [{ time: 2, mimeType: "image/jpeg", data: FAKE_JPEG, cached: false }],
        }),
      [`POST ${PREFIX}/reports`]: (_request, response) => json(response, 200, stored),
    });

    expect(await host.state(signal())).toEqual({ fingerprint: "fp-7" });
    const request = { render: "renders/final.mp4", framesPerMinute: 12, maxFrames: 24 };
    expect(await host.check(request, signal())).toEqual(check);
    expect(await host.frames({ render: "renders/final.mp4", times: [2] }, signal())).toEqual({
      frames: [{ time: 2, mimeType: "image/jpeg", data: FAKE_JPEG, cached: false }],
    });
    expect(await host.saveReport(REPORT_INPUT, signal())).toEqual(stored);

    expect(seen.map((entry) => `${entry.method} ${entry.path}`)).toEqual([
      `GET ${PREFIX}/state`,
      `POST ${PREFIX}/check`,
      `POST ${PREFIX}/frames`,
      `POST ${PREFIX}/reports`,
    ]);
    expect(seen[1]?.body).toEqual(request);
    expect(seen[2]?.body).toEqual({ render: "renders/final.mp4", times: [2] });
    expect(seen[3]?.body).toEqual(REPORT_INPUT);
  });

  it("maps the service's errors: a cancelled request is an abort, other codes keep their code", async () => {
    const { host } = await studio({
      [`POST ${PREFIX}/check`]: (_request, response) =>
        json(response, 409, { error: { code: "cancelled", message: "The check was cancelled." } }),
      [`POST ${PREFIX}/frames`]: (_request, response) =>
        json(response, 404, { error: { code: "not_found", message: "No such render." } }),
      [`GET ${PREFIX}/state`]: (_request, response) => json(response, 500, { error: "boom" }),
      [`POST ${PREFIX}/reports`]: (_request, response) => json(response, 200, { nonsense: true }),
    });
    const request = { render: "renders/final.mp4", framesPerMinute: 12, maxFrames: 24 };
    await expect(host.check(request, signal())).rejects.toMatchObject({
      code: "aborted",
      message: "The check was cancelled.",
    });
    await expect(
      host.frames({ render: "renders/missing.mp4", times: [1] }, signal()),
    ).rejects.toMatchObject({ code: "not_found", message: "No such render." });
    await expect(host.state(signal())).rejects.toMatchObject({
      code: "studio_unavailable",
      message: "boom",
    });
    await expect(host.saveReport(REPORT_INPUT, signal())).rejects.toMatchObject({
      code: "studio_unavailable",
      message: "Studio returned an invalid report.",
    });
  });

  it("ends a session through the session's finish route and rejects a malformed answer", async () => {
    const { host, seen } = await studio({
      [`POST ${PREFIX}/sessions/turn%2F1/finish`]: (_request, response) =>
        json(response, 200, { removedRenders: ["renders/a.mp4"], removedReports: 2 }),
      [`POST ${PREFIX}/sessions/turn-2/finish`]: (_request, response) =>
        json(response, 200, { removedRenders: "all" }),
    });
    const request = { keep: "renders/b.mp4", produced: ["renders/a.mp4", "renders/b.mp4"] };
    expect(await host.finishSession("turn/1", request, signal())).toEqual({
      removedRenders: ["renders/a.mp4"],
      removedReports: 2,
    });
    expect(seen[0]?.body).toEqual(request);
    await expect(host.finishSession("turn-2", { keep: null }, signal())).rejects.toMatchObject({
      code: "studio_unavailable",
      message: "Studio returned an invalid cleanup result.",
    });
  });

  it("rejects a check response that does not have the contract's shape", async () => {
    const { host } = await studio({
      [`POST ${PREFIX}/check`]: (_request, response) =>
        json(response, 200, { fingerprint: "fp", checks: "none" }),
    });
    await expect(
      host.check({ render: "renders/final.mp4", framesPerMinute: 12, maxFrames: 24 }, signal()),
    ).rejects.toMatchObject({
      code: "studio_unavailable",
      message: "Studio returned an invalid check result.",
    });
  });

  it("stops a request whose signal aborts, and reports an unreachable Studio", async () => {
    const hold: Route = () => {};
    const { host } = await studio({ [`POST ${PREFIX}/check`]: hold });
    const controller = new AbortController();
    const pending = host
      .check({ render: "renders/final.mp4", framesPerMinute: 12, maxFrames: 24 }, controller.signal)
      .catch((error: unknown) => error);
    controller.abort();
    const error = await pending;
    expect(error).toBeInstanceOf(QaToolError);
    expect(error).toMatchObject({ code: "aborted" });

    const dead = new HttpQaHost({
      projectId: "p",
      projectDir: "/tmp/p",
      studioOrigin: "http://127.0.0.1:1",
    });
    await expect(dead.state(signal())).rejects.toMatchObject({
      code: "studio_unavailable",
      message: expect.stringContaining("not reachable"),
    });
  });
});
