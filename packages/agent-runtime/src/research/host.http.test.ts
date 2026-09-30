// @vitest-environment node
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { setImmediate as tick } from "node:timers/promises";
import { isRecord } from "@hyperframes/agent-protocol";
import { afterEach, describe, expect, it } from "vitest";
import type { ProjectScope } from "../checkpointHost.js";
import {
  researchPolicy,
  sampleCandidate,
  sampleProvenance,
  sampleSearchResult,
  sampleSourcesView,
} from "../testing/research.js";
import { ResearchToolError } from "./host.js";
import { TurnResearch } from "./executor.js";
import { HttpResearchHost, type HttpResearchHostOptions } from "./host.http.js";

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

const PROJECT = "/api/projects/p%201/research";

/** A loopback stand-in for Studio's research routes: `routes` is keyed by "METHOD /path-without-query". */
async function studio(routes: Record<string, Route>, options: HttpResearchHostOptions = {}) {
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
      const route =
        routes[
          `${record.method} ${url.split("?")[0]?.replace(/\/requests\/[^/]+\/cancel$/, "/requests/:id/cancel")}`
        ];
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
  const close = () =>
    new Promise<void>((resolve) => {
      server.closeAllConnections();
      server.close(() => resolve());
    });
  return { host: new HttpResearchHost(scope, options), seen, close };
}

const signal = () => new AbortController().signal;

describe("HttpResearchHost", () => {
  it("uses the documented routes, methods and bodies, with the policy on the global route", async () => {
    const candidate = sampleCandidate("cand-1");
    const { host, seen } = await studio({
      "GET /api/research/policy": (_request, response) => json(response, 200, researchPolicy()),
      [`POST ${PROJECT}/search`]: (request, response) =>
        json(
          response,
          200,
          sampleSearchResult({ query: "waves", mediaKind: "video" }, [candidate]),
        ),
      [`POST ${PROJECT}/inspect`]: (request, response) =>
        json(response, 200, {
          url: "https://example.com/p",
          finalUrl: "https://example.com/p",
          title: null,
          source: candidate.source,
          author: null,
          license: candidate.license,
          candidates: [candidate],
          notes: [],
        }),
      [`POST ${PROJECT}/import`]: (_request, response) =>
        json(response, 200, {
          asset: "assets/research/ocean-waves.mp4",
          provenance: sampleProvenance(),
          fetch: "network",
          duplicate: null,
          resolved: null,
          resolveError: null,
          warnings: [],
        }),
      [`POST ${PROJECT}/resolve`]: (_request, response) =>
        json(response, 200, { missing: "m1", node: "v9", asset: "a.mp4", view: { graph: null } }),
      [`GET ${PROJECT}/sources`]: (_request, response) => json(response, 200, sampleSourcesView()),
      [`GET ${PROJECT}/export-check`]: (_request, response) =>
        json(response, 200, {
          composition: "scenes/a b.html",
          assets: [],
          warnings: [],
          credits: [],
        }),
    });

    expect((await host.policy(signal())).mode).toBe("trusted");
    expect(
      (await host.search({ query: "waves", mediaKind: "video", limit: 3 }, signal())).candidates,
    ).toHaveLength(1);
    expect(
      (await host.inspect({ url: "https://example.com/p" }, signal())).candidates,
    ).toHaveLength(1);
    const imported = await host.importAsset(
      {
        candidate: "cand-1",
        resolveMissing: "m1",
        turnId: "t1",
        agent: "research",
        model: "p/m",
      },
      signal(),
    );
    expect(imported.asset).toBe("assets/research/ocean-waves.mp4");
    expect(
      (await host.resolve({ missing: "m1", asset: "a.mp4", turnId: "t1" }, signal())).node,
    ).toBe("v9");
    expect((await host.sources(signal())).summary.total).toBe(1);
    expect((await host.exportCheck("scenes/a b.html", signal())).composition).toBe(
      "scenes/a b.html",
    );

    expect(seen.map((request) => `${request.method} ${request.path}`)).toEqual([
      "GET /api/research/policy",
      `POST ${PROJECT}/search`,
      `POST ${PROJECT}/inspect`,
      `POST ${PROJECT}/import`,
      `POST ${PROJECT}/resolve`,
      `GET ${PROJECT}/sources`,
      `GET ${PROJECT}/export-check?composition=scenes%2Fa%20b.html`,
    ]);
    expect(seen[1]?.body).toEqual({ query: "waves", mediaKind: "video", limit: 3 });
    expect(seen[3]?.body).toEqual({
      candidate: "cand-1",
      resolveMissing: "m1",
      turnId: "t1",
      agent: "research",
      model: "p/m",
      requestId: expect.any(String),
    });
    expect(seen[4]?.body).toEqual({
      missing: "m1",
      asset: "a.mp4",
      turnId: "t1",
      requestId: expect.any(String),
    });
    // Nothing on the wire carries a policy mode.
    expect(JSON.stringify(seen.map((request) => request.body))).not.toContain('"mode"');
  });

  it("maps the service's ResearchError to a ResearchToolError with its code", async () => {
    const { host } = await studio({
      [`POST ${PROJECT}/search`]: (_request, response) =>
        json(response, 403, {
          error: {
            code: "blocked_by_policy",
            message: "web search is not allowed in trusted mode",
          },
        }),
      [`POST ${PROJECT}/import`]: (_request, response) =>
        json(response, 410, { error: { code: "unavailable", message: "The file was removed" } }),
      [`POST ${PROJECT}/resolve`]: (_request, response) =>
        json(response, 409, { error: { code: "locked", message: "m1 is locked" } }),
    });
    const blocked = await host.search({ query: "x", mediaKind: "video" }, signal()).catch((e) => e);
    expect(blocked).toBeInstanceOf(ResearchToolError);
    expect(blocked).toMatchObject({
      code: "blocked_by_policy",
      message: "web search is not allowed in trusted mode",
    });
    await expect(host.importAsset({ candidate: "c" }, signal())).rejects.toMatchObject({
      code: "unavailable",
    });
    await expect(host.resolve({ missing: "m1", asset: "a" }, signal())).rejects.toMatchObject({
      code: "locked",
    });
  });

  it("reports an unknown failure and an invalid payload as studio_unavailable", async () => {
    const { host } = await studio({
      [`GET ${PROJECT}/sources`]: (_request, response) => json(response, 500, { error: "boom" }),
      "GET /api/research/policy": (_request, response) => json(response, 200, { mode: 3 }),
    });
    await expect(host.sources(signal())).rejects.toMatchObject({
      code: "studio_unavailable",
      message: "boom",
    });
    await expect(host.policy(signal())).rejects.toMatchObject({
      code: "studio_unavailable",
      message: expect.stringContaining("invalid Asset Search policy"),
    });
  });

  it("reports an unreachable Studio as studio_unavailable", async () => {
    const { host, close } = await studio({});
    await close();
    await expect(host.sources(signal())).rejects.toMatchObject({
      code: "studio_unavailable",
      message: expect.stringContaining("not reachable"),
    });
  });

  it("never sends a request whose signal is already aborted", async () => {
    const { host, seen } = await studio({});
    const spent = new AbortController();
    spent.abort();
    await expect(host.sources(spent.signal)).rejects.toMatchObject({ code: "aborted" });
    await expect(host.importAsset({ candidate: "c" }, spent.signal)).rejects.toMatchObject({
      code: "aborted",
    });
    expect(seen).toEqual([]);
  });

  it("stops waiting for a read when the call is aborted", async () => {
    const received = Promise.withResolvers<void>();
    const { host } = await studio({
      [`GET ${PROJECT}/sources`]: () => {
        // Never answers: the request stays open until the caller gives up.
        received.resolve();
      },
    });
    const controller = new AbortController();
    const pending = host.sources(controller.signal);
    await received.promise;
    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: "aborted" });
  });
});

const CANCEL_ROUTE = `POST ${PROJECT}/requests/:id/cancel`;

/** A write's body carries the request id its cancel will name. */
function requestIdOf(request: Seen | undefined): string {
  if (!request || !isRecord(request.body) || typeof request.body.requestId !== "string")
    throw new Error("no request id");
  return request.body.requestId;
}

/** Studio's cancel route, answering with `state` and telling the test the cancel arrived. */
function cancelRoute(state: string) {
  const arrived = Promise.withResolvers<void>();
  const route: Route = (request, response) => {
    json(response, 200, { requestId: request.path.split("/").at(-2), state });
    arrived.resolve();
  };
  return { route, arrived: arrived.promise };
}

/** A route that keeps the request open until the test answers it. */
function heldRoute() {
  const held = Promise.withResolvers<ServerResponse>();
  const route: Route = (_request, response) => held.resolve(response);
  return { route, held: held.promise };
}

const importResult = {
  asset: "assets/research/ocean-waves.mp4",
  provenance: sampleProvenance(),
  fetch: "network",
  duplicate: null,
  resolved: null,
  resolveError: null,
  warnings: [],
};

const cancelledAnswer = { error: { code: "cancelled", message: "cancelled before any write" } };

describe("HttpResearchHost writes: a stopped import or resolution is cancelled, not dropped", () => {
  it("sends a cancel that names the request, and keeps waiting for the server's answer before it settles", async () => {
    const import_ = heldRoute();
    const cancel = cancelRoute("cancelled");
    const { host, seen } = await studio({
      [`POST ${PROJECT}/import`]: import_.route,
      [CANCEL_ROUTE]: cancel.route,
    });
    const controller = new AbortController();
    let settled = false;
    const outcome = host
      .importAsset({ candidate: "c" }, controller.signal)
      .then(
        () => null,
        (error: unknown) => error,
      )
      .finally(() => {
        settled = true;
      });
    const answer = await import_.held;
    controller.abort();
    await cancel.arrived;
    // The cancel was delivered, but the import has not answered: the turn must not see it settle yet.
    await tick();
    expect(settled).toBe(false);
    expect(seen[1]?.path).toBe(`${PROJECT}/requests/${requestIdOf(seen[0])}/cancel`);

    // Studio answers that it discarded the import before its commit.
    json(answer, 409, cancelledAnswer);
    await expect(outcome).resolves.toMatchObject({ code: "aborted" });
  });

  it("returns the result when the commit had already started: the write happened and is reported", async () => {
    const import_ = heldRoute();
    const cancel = cancelRoute("committed");
    const { host } = await studio({
      [`POST ${PROJECT}/import`]: import_.route,
      [CANCEL_ROUTE]: cancel.route,
    });
    const controller = new AbortController();
    const pending = host.importAsset({ candidate: "c" }, controller.signal);
    const answer = await import_.held;
    controller.abort();
    await cancel.arrived;
    json(answer, 200, importResult);
    await expect(pending).resolves.toMatchObject({ asset: "assets/research/ocean-waves.mp4" });
  });

  it("gives up after the settle bound when the cancel was acknowledged: Studio promised never to write, and the connection is closed", async () => {
    const import_ = heldRoute();
    const { host } = await studio(
      {
        [`POST ${PROJECT}/import`]: import_.route,
        [CANCEL_ROUTE]: cancelRoute("cancelled").route,
      },
      { settleMs: 40 },
    );
    const controller = new AbortController();
    const pending = host.importAsset({ candidate: "c" }, controller.signal);
    const answer = await import_.held;
    const closed = Promise.withResolvers<void>();
    answer.on("close", () => closed.resolve());
    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: "aborted" });
    await closed.promise;
  });

  it("fails with write_unsettled when nothing answers and a write could still land", async () => {
    // Cancel acknowledged as committed, or no cancel route at all (Studio answers 404: the write's fate is unknown).
    for (const cancel of [cancelRoute("committed").route, undefined]) {
      const import_ = heldRoute();
      const { host } = await studio(
        {
          [`POST ${PROJECT}/import`]: import_.route,
          ...(cancel && { [CANCEL_ROUTE]: cancel }),
        },
        { settleMs: 40 },
      );
      const controller = new AbortController();
      const pending = host.importAsset({ candidate: "c" }, controller.signal);
      await import_.held;
      controller.abort();
      await expect(pending).rejects.toMatchObject({
        code: "write_unsettled",
        message: expect.stringContaining("may still appear"),
      });
    }
  });

  it("cancels a call that times out the same way, and says it was cancelled", async () => {
    const import_ = heldRoute();
    const { host, seen } = await studio(
      {
        [`POST ${PROJECT}/import`]: import_.route,
        [CANCEL_ROUTE]: (request, response) => {
          json(response, 200, { requestId: request.path.split("/").at(-2), state: "cancelled" });
          void import_.held.then((answer) => json(answer, 409, cancelledAnswer));
        },
      },
      { timeoutsMs: { importAsset: 30 } },
    );
    await expect(host.importAsset({ candidate: "c" }, signal())).rejects.toMatchObject({
      code: "studio_unavailable",
      message: expect.stringContaining("was cancelled"),
    });
    expect(seen.map((request) => `${request.method} ${request.path.split("/").at(-1)}`)).toEqual([
      "POST import",
      "POST cancel",
    ]);
  });

  it("does the same for a resolution", async () => {
    const resolve = heldRoute();
    const cancel = cancelRoute("cancelled");
    const { host, seen } = await studio({
      [`POST ${PROJECT}/resolve`]: resolve.route,
      [CANCEL_ROUTE]: cancel.route,
    });
    const controller = new AbortController();
    const pending = host.resolve({ missing: "m1", asset: "a.mp4" }, controller.signal);
    const answer = await resolve.held;
    controller.abort();
    await cancel.arrived;
    json(answer, 409, cancelledAnswer);
    await expect(pending).rejects.toMatchObject({ code: "aborted" });
    expect(seen[1]?.path).toBe(`${PROJECT}/requests/${requestIdOf(seen[0])}/cancel`);
  });
});

describe("a stopped turn and its import over HTTP", () => {
  function turnOver(host: HttpResearchHost, turnSignal: AbortSignal) {
    return new TurnResearch({
      host,
      turnId: "turn-1",
      turnSignal,
      enabled: ["research"],
      turn: { mode: "normal", action: null },
      storyOptions: null,
      model: () => null,
    });
  }

  it("does not resolve shutdown() until Studio has answered the cancelled import, so its write cannot land after the checkpoint closes", async () => {
    const import_ = heldRoute();
    const cancel = cancelRoute("committed");
    const { host } = await studio({
      [`POST ${PROJECT}/import`]: import_.route,
      [CANCEL_ROUTE]: cancel.route,
    });
    const stop = new AbortController();
    const turn = turnOver(host, stop.signal);
    const call = turn.execute(
      "research",
      "import_asset",
      { candidate: "cand-1" },
      new AbortController().signal,
    );
    const answer = await import_.held;

    // The user stops the turn; the runner closes research before it ends the checkpoint transaction.
    stop.abort();
    let closed = false;
    const closing = turn.shutdown().then((result) => {
      closed = true;
      return result;
    });
    await cancel.arrived;
    await tick();
    // The cancel reached Studio, which says the commit had started: the turn still waits for the write's answer.
    expect(closed).toBe(false);

    json(answer, 200, importResult);
    await expect(closing).resolves.toEqual({ unsettledWrites: [] });
    // The write happened inside the turn: the model is told about the asset rather than about a cancellation.
    expect(await call).toMatchObject({ text: expect.stringContaining("Imported ") });
  });

  it("stops waiting after the bound and reports a write it could not settle", async () => {
    const import_ = heldRoute();
    const { host } = await studio(
      {
        [`POST ${PROJECT}/import`]: import_.route,
        [CANCEL_ROUTE]: cancelRoute("committed").route,
      },
      { settleMs: 40 },
    );
    const stop = new AbortController();
    const turn = turnOver(host, stop.signal);
    const call = turn.execute(
      "research",
      "import_asset",
      { candidate: "cand-1" },
      new AbortController().signal,
    );
    await import_.held;
    stop.abort();
    const { unsettledWrites } = await turn.shutdown();
    expect(unsettledWrites).toHaveLength(1);
    expect(unsettledWrites[0]).toContain("import_asset");
    expect(await call).toMatchObject({
      isError: true,
      text: expect.stringContaining("write_unsettled"),
    });
  });
});
