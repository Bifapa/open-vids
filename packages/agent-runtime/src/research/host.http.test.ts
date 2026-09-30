// @vitest-environment node
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
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
import { HttpResearchHost } from "./host.http.js";

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
  const close = () =>
    new Promise<void>((resolve) => {
      server.closeAllConnections();
      server.close(() => resolve());
    });
  return { host: new HttpResearchHost(scope), seen, close };
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
    });
    expect(seen[4]?.body).toEqual({ missing: "m1", asset: "a.mp4", turnId: "t1" });
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

  it("stops waiting when the call is aborted, and never sends a request whose signal is already aborted", async () => {
    const received = Promise.withResolvers<void>();
    const { host, seen } = await studio({
      [`POST ${PROJECT}/import`]: () => {
        // Never answers: the request stays open until the caller gives up.
        received.resolve();
      },
    });
    const controller = new AbortController();
    const pending = host.importAsset({ candidate: "c" }, controller.signal);
    await received.promise;
    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: "aborted" });

    const before = seen.length;
    const spent = new AbortController();
    spent.abort();
    await expect(host.sources(spent.signal)).rejects.toMatchObject({ code: "aborted" });
    expect(seen.length).toBe(before);
  });
});
