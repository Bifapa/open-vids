// @vitest-environment node
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { VOICE_DIALECTS } from "@hyperframes/agent-protocol";
import type { ProjectScope } from "../checkpointHost.js";
import { FakeVoiceHost, samplePreset, sampleProvider, sampleTake } from "../testing/voice.js";
import { VoiceToolError } from "./host.js";
import { HttpVoiceHost, type HttpVoiceHostOptions } from "./host.http.js";

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

const json = (
  response: ServerResponse,
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
) => {
  response.writeHead(status, { "content-type": "application/json", ...headers });
  response.end(JSON.stringify(body));
};

const PROJECT = "/api/projects/p%201/voice";
const GLOBAL = "/api/voice";

/** The request id a synthesize body carries. */
function requestIdOf(body: unknown): string {
  return typeof body === "object" && body !== null && "requestId" in body
    ? String(body.requestId)
    : "";
}

/**
 * A loopback stand-in for Studio's voice routes: `routes` is keyed by "METHOD /path-without-query", where a `*`
 * segment matches any one segment (a request id).
 */
async function fakeStudio(routes: Record<string, Route>, options: HttpVoiceHostOptions = {}) {
  const seen: Seen[] = [];
  const patterns = Object.entries(routes).map(
    ([key, route]) => [new RegExp(`^${key.replaceAll("*", "[^/]+")}$`), route] as const,
  );
  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk: string) => (body += chunk));
    request.on("end", () => {
      const url = request.url ?? "";
      const record: Seen = {
        method: request.method ?? "GET",
        path: url,
        body: body ? JSON.parse(body) : null,
      };
      seen.push(record);
      const key = `${record.method} ${url.split("?")[0]}`;
      const route = patterns.find(([pattern]) => pattern.test(key))?.[1];
      if (route) route(record, response);
      else json(response, 404, { error: { code: "not_found", message: `no route ${url}` } });
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
  return { host: new HttpVoiceHost(scope, options), seen };
}

const signal = () => new AbortController().signal;

/** The script view a host answers, built by the fake so it has every field the guard reads. */
async function scriptView() {
  const fake = new FakeVoiceHost();
  await fake.setProjectVoice("preset-1");
  return fake.saveScript({ lines: [{ id: "l1", text: "Hello." }] });
}

describe("HttpVoiceHost: global routes", () => {
  it("lists presets, finds one by id and answers null for an unknown id", async () => {
    const { host, seen } = await fakeStudio({
      [`GET ${GLOBAL}/presets`]: (_request, response) =>
        json(response, 200, { presets: [samplePreset(), samplePreset({ id: "preset-2" })] }),
    });
    expect((await host.presets(signal())).map((preset) => preset.id)).toEqual([
      "preset-1",
      "preset-2",
    ]);
    expect((await host.getPreset("preset-2", signal()))?.id).toBe("preset-2");
    expect(await host.getPreset("ghost", signal())).toBeNull();
    expect(seen.every((request) => request.path === `${GLOBAL}/presets`)).toBe(true);
  });

  it("reads providers with the user's rules and the dialect list", async () => {
    const { host } = await fakeStudio({
      [`GET ${GLOBAL}/providers`]: (_request, response) =>
        json(response, 200, { providers: [sampleProvider({ agentRules: "No tags." })] }),
      [`GET ${GLOBAL}/dialects`]: (_request, response) =>
        json(response, 200, { dialects: Object.values(VOICE_DIALECTS) }),
    });
    expect((await host.providers(signal()))[0]?.agentRules).toBe("No tags.");
    expect((await host.dialects(signal())).map((dialect) => dialect.id)).toContain("gemini-tts");
  });

  it("rejects an answer that is not what the route promises", async () => {
    const { host } = await fakeStudio({
      [`GET ${GLOBAL}/presets`]: (_request, response) =>
        json(response, 200, { presets: [{ id: 1 }] }),
    });
    await expect(host.presets(signal())).rejects.toMatchObject({
      code: "studio_unavailable",
      message: "Studio returned an invalid preset list.",
    });
  });
});

describe("HttpVoiceHost: project routes", () => {
  it("reads and saves the script, sets the voice and checks it, addressing the project by its encoded id", async () => {
    const view = await scriptView();
    const check = await new FakeVoiceHost().check({});
    const { host, seen } = await fakeStudio({
      [`GET ${PROJECT}/script`]: (_request, response) => json(response, 200, view),
      [`PUT ${PROJECT}/script`]: (_request, response) => json(response, 200, view),
      [`PUT ${PROJECT}/voice`]: (_request, response) => json(response, 200, view),
      [`POST ${PROJECT}/check`]: (_request, response) => json(response, 200, check),
    });
    expect((await host.script(signal())).lines).toHaveLength(1);
    await host.saveScript({ lines: [{ id: "l1", text: "Hello." }] }, signal());
    await host.setProjectVoice("preset-1", signal());
    await host.setProjectVoice(null, signal());
    expect((await host.check({ lineIds: ["l1"] }, signal())).ok).toBe(true);
    expect(seen.map((request) => [request.method, request.path, request.body])).toEqual([
      ["GET", `${PROJECT}/script`, null],
      ["PUT", `${PROJECT}/script`, { lines: [{ id: "l1", text: "Hello." }] }],
      ["PUT", `${PROJECT}/voice`, { presetId: "preset-1" }],
      ["PUT", `${PROJECT}/voice`, { presetId: null }],
      ["POST", `${PROJECT}/check`, { lineIds: ["l1"] }],
    ]);
  });
});

describe("HttpVoiceHost: synthesis", () => {
  const take = sampleTake("l1");
  const result = {
    lines: [{ lineId: "l1", take, cached: false }],
    requests: 1,
    usdCost: 0.002,
    notes: [],
  };
  const cancelled = { error: { code: "cancelled", message: "cancelled before commit" } };

  it("sends the request with a request id and returns the takes", async () => {
    const { host, seen } = await fakeStudio({
      [`POST ${PROJECT}/synthesize`]: (_request, response) => json(response, 200, result),
    });
    const answer = await host.synthesize(
      { lineIds: ["l1"], agent: "audio", turnId: "t1" },
      signal(),
    );
    expect(answer.lines[0]?.take.file).toBe(take.file);
    expect(seen[0]?.body).toMatchObject({ lineIds: ["l1"], agent: "audio", turnId: "t1" });
    expect(requestIdOf(seen[0]?.body)).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("reads the server's progress from the request's own route while it runs", async () => {
    const progressSeen = Promise.withResolvers<void>();
    let requestId = "";
    const { host } = await fakeStudio(
      {
        [`POST ${PROJECT}/synthesize`]: (request, response) => {
          requestId = requestIdOf(request.body);
          // The generation ends only once the host has reported progress.
          void progressSeen.promise.then(() => json(response, 200, result));
        },
        [`GET ${PROJECT}/requests/*`]: (request, response) =>
          json(response, 200, {
            requestId: request.path.split("/").pop(),
            state: "running",
            done: 1,
            total: 2,
            lineId: "l1",
          }),
      },
      { progressPollMs: 1 },
    );
    const updates: Array<[string, number, number]> = [];
    const answer = await host.synthesize({ lineIds: ["l1"] }, signal(), (progress) => {
      updates.push([progress.requestId, progress.done, progress.total]);
      progressSeen.resolve();
    });
    expect(answer.requests).toBe(1);
    expect(updates[0]).toEqual([requestId, 1, 2]);
  });

  it("maps the service's errors to codes, parameters and issues", async () => {
    const issue = {
      lineId: "l1",
      code: "digits",
      severity: "error",
      message: "Write numbers as words.",
    };
    const { host } = await fakeStudio({
      [`POST ${PROJECT}/synthesize`]: (request, response) => {
        const lineId =
          typeof request.body === "object" && request.body !== null && "lineIds" in request.body
            ? String(request.body.lineIds)
            : "";
        if (lineId === "key")
          return json(response, 401, { error: { code: "invalid_key", message: "bad key ***" } });
        if (lineId === "rate")
          return json(
            response,
            429,
            { error: { code: "rate_limited", message: "slow down" } },
            { "retry-after": "17" },
          );
        if (lineId === "rate-body")
          return json(
            response,
            429,
            {
              error: {
                code: "rate_limited",
                message: "slow down",
                params: { retryAfterSeconds: 5, daily: 1 },
              },
            },
            { "retry-after": "17" },
          );
        if (lineId === "audio")
          return json(response, 502, {
            error: {
              code: "not_audio",
              message: "html",
              params: { contentType: "text/html", body: "<html>" },
            },
          });
        if (lineId === "dialect")
          return json(response, 422, {
            error: {
              code: "dialect_violation",
              message: "bad script",
              issues: [issue, { junk: 1 }],
            },
          });
        return json(response, 500, { error: "boom" });
      },
    });
    const fail = (lineId: string) =>
      host.synthesize({ lineIds: [lineId] }, signal()).then(
        () => null,
        (error: unknown) => error,
      );

    expect(await fail("key")).toMatchObject({ code: "invalid_key", message: "bad key ***" });
    expect(await fail("rate")).toMatchObject({
      code: "rate_limited",
      params: { retryAfterSeconds: 17 },
    });
    expect(await fail("rate-body")).toMatchObject({
      code: "rate_limited",
      params: { retryAfterSeconds: 5, daily: 1 },
    });
    expect(await fail("audio")).toMatchObject({
      code: "not_audio",
      params: { contentType: "text/html", body: "<html>" },
    });
    const dialect = await fail("dialect");
    expect(dialect).toBeInstanceOf(VoiceToolError);
    expect(dialect).toMatchObject({ code: "dialect_violation", issues: [issue] });
    expect(await fail("other")).toMatchObject({ code: "studio_unavailable", message: "boom" });
  });

  /** A server whose synthesis stays open until the test settles it. */
  async function holding(
    cancelState: "cancelled" | "committed" | null,
    options: HttpVoiceHostOptions = {},
  ) {
    const open = Promise.withResolvers<{
      id: string;
      settle: (status: number, body: unknown) => void;
    }>();
    const cancelSeen = Promise.withResolvers<string>();
    const routes: Record<string, Route> = {
      [`POST ${PROJECT}/synthesize`]: (request, response) =>
        open.resolve({
          id: requestIdOf(request.body),
          settle: (status, body) => json(response, status, body),
        }),
    };
    if (cancelState !== null)
      routes[`POST ${PROJECT}/requests/*/cancel`] = (request, response) => {
        cancelSeen.resolve(request.path);
        json(response, 200, { requestId: request.path.split("/").at(-2), state: cancelState });
      };
    const { host } = await fakeStudio(routes, options);
    return { host, open: open.promise, cancelSeen: cancelSeen.promise };
  }

  it("cancels the request on the server when the caller stops, and reports the stop when the server answers cancelled", async () => {
    const { host, open, cancelSeen } = await holding("cancelled");
    const controller = new AbortController();
    const outcome = host.synthesize({ lineIds: ["l1"] }, controller.signal).then(
      () => null,
      (error: unknown) => error,
    );
    const held = await open;
    controller.abort();
    // The cancel reached the server; the original request then answers cancelled.
    await cancelSeen;
    held.settle(409, cancelled);
    expect(await outcome).toMatchObject({ code: "aborted" });
    expect(await cancelSeen).toBe(`${PROJECT}/requests/${held.id}/cancel`);
  });

  it("returns the takes when the cancel came too late and the server committed them", async () => {
    const { host, open, cancelSeen } = await holding("committed");
    const controller = new AbortController();
    const outcome = host.synthesize({ lineIds: ["l1"] }, controller.signal);
    const held = await open;
    controller.abort();
    await cancelSeen;
    held.settle(200, result);
    await expect(outcome).resolves.toMatchObject({ requests: 1 });
  });

  it("fails write_unsettled when a cancelled generation is never answered and the cancel was not acknowledged", async () => {
    // No cancel route is mounted: the server's answer to the cancel is a 404, so its fate is unknown.
    const { host, open } = await holding(null, { settleMs: 20 });
    const controller = new AbortController();
    const outcome = host.synthesize({ lineIds: ["l1"] }, controller.signal).then(
      () => null,
      (error: unknown) => error,
    );
    await open;
    controller.abort();
    expect(await outcome).toMatchObject({ code: "write_unsettled" });
  });

  it("gives up safely once the server acknowledged the cancel as cancelled, even if it never answers", async () => {
    const { host, open } = await holding("cancelled", { settleMs: 20 });
    const controller = new AbortController();
    const outcome = host.synthesize({ lineIds: ["l1"] }, controller.signal).then(
      () => null,
      (error: unknown) => error,
    );
    await open;
    controller.abort();
    expect(await outcome).toMatchObject({ code: "aborted" });
  });
});
