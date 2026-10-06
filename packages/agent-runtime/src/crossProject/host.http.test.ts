// @vitest-environment node
import { setImmediate as tick } from "node:timers/promises";
import type { ChatMessage, ProjectManifest } from "@hyperframes/agent-protocol";
import { afterEach, describe, expect, it } from "vitest";
import {
  cancelRoute,
  closeFakeStudios,
  fakeStudio,
  heldRoute,
  json,
  requestIdOf,
  type Route,
} from "../testing/fakeStudio.js";
import { manifestFile, projectReference, userMessage } from "../testing/crossProject.js";
import { sampleProvenance } from "../testing/research.js";
import { TurnCrossProject } from "./executor.js";
import { HttpCrossProjectHost, type HttpCrossProjectHostOptions } from "./host.http.js";

afterEach(closeFakeStudios);

const BASE = "/api/projects/p%201/cross-project";
const CANCEL_ROUTE = `POST ${BASE}/requests/:id/cancel`;
const KEY = "aaaaaaaaaaaaaaaa";

const studio = (routes: Record<string, Route>, options: HttpCrossProjectHostOptions = {}) =>
  fakeStudio(routes, (scope) => new HttpCrossProjectHost(scope, options));

const signal = () => new AbortController().signal;

const manifest: ProjectManifest = {
  key: KEY,
  name: "Summer reel",
  parts: ["renders", "music"],
  files: [manifestFile("renders/final.mp4", "renders"), manifestFile("a b/theme.mp3", "music")],
  truncated: false,
  story: null,
};

const importAnswer = {
  imported: [
    {
      source: "renders/final.mp4",
      asset: "assets/from/summer-reel/renders/final.mp4",
      bytes: 2_000_000,
      status: "copied",
      provenance: sampleProvenance(),
    },
  ],
  skipped: [],
};

const cancelledAnswer = { error: { code: "cancelled", message: "cancelled before any write" } };

describe("HttpCrossProjectHost", () => {
  it("reads a manifest from the documented route with the asked parts and the key escaped", async () => {
    const { host, seen } = await studio({
      [`GET ${BASE}/projects/a%2Fb/manifest`]: (_request, response) =>
        json(response, 200, manifest),
    });
    await expect(host.manifest("a/b", ["renders", "music"], signal())).resolves.toEqual(manifest);
    expect(seen.map((request) => `${request.method} ${request.path}`)).toEqual([
      `GET ${BASE}/projects/a%2Fb/manifest?parts=renders,music`,
    ]);
  });

  it("maps the service's ResearchError, an unknown failure and an invalid payload", async () => {
    const { host } = await studio({
      [`GET ${BASE}/projects/${KEY}/manifest`]: (_request, response) =>
        json(response, 404, { error: { code: "unknown_project", message: "No such project." } }),
      [`GET ${BASE}/projects/bad/manifest`]: (_request, response) =>
        json(response, 200, { files: 3 }),
      [`GET ${BASE}/projects/boom/manifest`]: (_request, response) =>
        json(response, 500, { error: "kaput" }),
    });
    await expect(host.manifest(KEY, ["renders"], signal())).rejects.toMatchObject({
      code: "unknown_project",
      message: "No such project.",
    });
    await expect(host.manifest("bad", ["renders"], signal())).rejects.toMatchObject({
      code: "studio_unavailable",
      message: expect.stringContaining("invalid project manifest"),
    });
    await expect(host.manifest("boom", ["renders"], signal())).rejects.toMatchObject({
      code: "studio_unavailable",
      message: "kaput",
    });
  });

  it("reports an unreachable Studio and never sends a request whose signal is already aborted", async () => {
    const { host, seen, close } = await studio({});
    const stopped = new AbortController();
    stopped.abort();
    await expect(host.manifest(KEY, ["renders"], stopped.signal)).rejects.toMatchObject({
      code: "aborted",
    });
    await expect(
      host.importFiles({ projectKey: KEY, files: ["x"] }, stopped.signal),
    ).rejects.toMatchObject({ code: "aborted" });
    expect(seen).toEqual([]);
    await close();
    await expect(host.manifest(KEY, ["renders"], signal())).rejects.toMatchObject({
      code: "studio_unavailable",
      message: expect.stringContaining("cross-project service is not reachable"),
    });
  });

  it("posts an import with a fresh request id, and the caller's own fields stay", async () => {
    const { host, seen } = await studio({
      [`POST ${BASE}/import`]: (_request, response) => json(response, 200, importAnswer),
    });
    const result = await host.importFiles(
      {
        projectKey: KEY,
        files: ["renders/final.mp4"],
        turnId: "t1",
        agent: "editor",
        model: "p/m",
      },
      signal(),
    );
    expect(result.imported[0]?.asset).toBe("assets/from/summer-reel/renders/final.mp4");
    expect(seen[0]?.body).toMatchObject({
      projectKey: KEY,
      files: ["renders/final.mp4"],
      turnId: "t1",
      agent: "editor",
      model: "p/m",
    });
    expect(requestIdOf(seen[0])).toMatch(/^[0-9a-f-]{36}$/);
  });
});

describe("HttpCrossProjectHost import: a stopped import is cancelled, not dropped", () => {
  it("sends a cancel that names the request and keeps waiting for the server's answer before it settles", async () => {
    const copy = heldRoute();
    const cancel = cancelRoute("cancelled");
    const { host, seen } = await studio({
      [`POST ${BASE}/import`]: copy.route,
      [CANCEL_ROUTE]: cancel.route,
    });
    const controller = new AbortController();
    let settled = false;
    const outcome = host
      .importFiles({ projectKey: KEY, files: ["x"] }, controller.signal)
      .then(
        () => null,
        (error: unknown) => error,
      )
      .finally(() => {
        settled = true;
      });
    const answer = await copy.held;
    controller.abort();
    await cancel.arrived;
    await tick();
    expect(settled).toBe(false);
    expect(seen[1]?.path).toBe(`${BASE}/requests/${requestIdOf(seen[0])}/cancel`);

    json(answer, 409, cancelledAnswer);
    await expect(outcome).resolves.toMatchObject({ code: "aborted" });
  });

  it("returns the result when the commit had already started: the write happened and is reported", async () => {
    const copy = heldRoute();
    const cancel = cancelRoute("committed");
    const { host } = await studio({
      [`POST ${BASE}/import`]: copy.route,
      [CANCEL_ROUTE]: cancel.route,
    });
    const controller = new AbortController();
    const pending = host.importFiles({ projectKey: KEY, files: ["x"] }, controller.signal);
    const answer = await copy.held;
    controller.abort();
    await cancel.arrived;
    json(answer, 200, importAnswer);
    await expect(pending).resolves.toMatchObject({ imported: [{ status: "copied" }] });
  });

  it("gives up after the settle bound when the cancel was acknowledged: Studio promised never to write", async () => {
    const copy = heldRoute();
    const { host } = await studio(
      {
        [`POST ${BASE}/import`]: copy.route,
        [CANCEL_ROUTE]: cancelRoute("cancelled").route,
      },
      { settleMs: 40 },
    );
    const controller = new AbortController();
    const pending = host.importFiles({ projectKey: KEY, files: ["x"] }, controller.signal);
    const answer = await copy.held;
    const closed = Promise.withResolvers<void>();
    answer.on("close", () => closed.resolve());
    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: "aborted" });
    await closed.promise;
  });

  it("fails with write_unsettled when nothing answers and a write could still land", async () => {
    for (const cancel of [cancelRoute("committed").route, undefined]) {
      const copy = heldRoute();
      const { host } = await studio(
        {
          [`POST ${BASE}/import`]: copy.route,
          ...(cancel && { [CANCEL_ROUTE]: cancel }),
        },
        { settleMs: 40 },
      );
      const controller = new AbortController();
      const pending = host.importFiles({ projectKey: KEY, files: ["x"] }, controller.signal);
      await copy.held;
      controller.abort();
      await expect(pending).rejects.toMatchObject({
        code: "write_unsettled",
        message: expect.stringContaining("may still appear"),
      });
    }
  });

  it("cancels a call that times out the same way, and says it was cancelled", async () => {
    const copy = heldRoute();
    const { host, seen } = await studio(
      {
        [`POST ${BASE}/import`]: copy.route,
        [CANCEL_ROUTE]: (request, response) => {
          json(response, 200, { requestId: request.path.split("/").at(-2), state: "cancelled" });
          void copy.held.then((answer) => json(answer, 409, cancelledAnswer));
        },
      },
      { timeoutsMs: { importFiles: 30 } },
    );
    await expect(
      host.importFiles({ projectKey: KEY, files: ["x"] }, signal()),
    ).rejects.toMatchObject({
      code: "studio_unavailable",
      message: expect.stringContaining("was cancelled"),
    });
    expect(seen.map((request) => `${request.method} ${request.path.split("/").at(-1)}`)).toEqual([
      "POST import",
      "POST cancel",
    ]);
  });
});

describe("a stopped turn and its project import over HTTP", () => {
  const messages = (): ChatMessage[] => [
    userMessage("x", [projectReference(KEY, "Summer reel", ["renders"])]),
  ];

  function turnOver(host: HttpCrossProjectHost, turnSignal: AbortSignal) {
    return new TurnCrossProject({
      host,
      turnId: "turn-1",
      turnSignal,
      enabled: ["editor"],
      turn: { mode: "normal", action: null },
      messages,
      model: () => null,
    });
  }

  const routes = (copy: Route, cancel: Route): Record<string, Route> => ({
    [`GET ${BASE}/projects/${KEY}/manifest`]: (_request, response) => json(response, 200, manifest),
    [`POST ${BASE}/import`]: copy,
    [CANCEL_ROUTE]: cancel,
  });

  it("does not resolve shutdown() until Studio has answered the cancelled import, so its write cannot land after the checkpoint closes", async () => {
    const copy = heldRoute();
    const cancel = cancelRoute("committed");
    const { host } = await studio(routes(copy.route, cancel.route));
    const stop = new AbortController();
    const turn = turnOver(host, stop.signal);
    const call = turn.execute(
      "editor",
      "import_from_project",
      { project: KEY, files: ["renders/final.mp4"] },
      signal(),
    );
    const answer = await copy.held;

    stop.abort();
    let closed = false;
    const closing = turn.shutdown().then((result) => {
      closed = true;
      return result;
    });
    await cancel.arrived;
    await tick();
    expect(closed).toBe(false);

    json(answer, 200, importAnswer);
    await expect(closing).resolves.toEqual({ unsettledWrites: [] });
    expect(await call).toMatchObject({ text: expect.stringContaining("Copied 1 of 1 file") });
  });

  it("stops waiting after the bound and reports a write it could not settle", async () => {
    const copy = heldRoute();
    const { host } = await studio(routes(copy.route, cancelRoute("committed").route), {
      settleMs: 40,
    });
    const stop = new AbortController();
    const turn = turnOver(host, stop.signal);
    const call = turn.execute(
      "editor",
      "import_from_project",
      { project: KEY, files: ["renders/final.mp4"] },
      signal(),
    );
    await copy.held;
    stop.abort();
    const { unsettledWrites } = await turn.shutdown();
    expect(unsettledWrites).toHaveLength(1);
    expect(unsettledWrites[0]).toContain("import_from_project");
    expect(await call).toMatchObject({
      isError: true,
      text: expect.stringContaining("write_unsettled"),
    });
  });

  it("never sends the import for a file outside the manifest", async () => {
    const { host, seen } = await studio(
      routes(
        (_request, response) => json(response, 200, importAnswer),
        cancelRoute("cancelled").route,
      ),
    );
    const turn = turnOver(host, new AbortController().signal);
    const result = await turn.execute(
      "editor",
      "import_from_project",
      { project: KEY, files: ["a b/theme.mp3"] },
      signal(),
    );
    expect(result.isError).toBe(true);
    expect(seen.map((request) => request.method)).toEqual(["GET"]);
  });
});
