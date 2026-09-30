// @vitest-environment node
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import type { StoryRebuildRequest } from "@hyperframes/agent-protocol";
import type { ProjectScope } from "../checkpointHost.js";
import { sampleBuildResult, sampleRebuildResult, userEditedStory } from "../testing/story.js";
import { StoryToolError } from "./host.js";
import { HttpStoryHost } from "./host.http.js";

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

const PREFIX = "/api/projects/p%201/story";

/** A loopback stand-in for Studio's story routes: `routes` is keyed by "METHOD /path-without-query". */
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
  return { host: new HttpStoryHost(scope), seen };
}

const signal = () => new AbortController().signal;

describe("HttpStoryHost", () => {
  it("uses the documented routes, methods and bodies", async () => {
    const view = userEditedStory();
    const { host, seen } = await studio({
      [`GET ${PREFIX}`]: (_request, response) => json(response, 200, view),
      [`POST ${PREFIX}/edit`]: (_request, response) =>
        json(response, 200, { view, results: [{ op: "set_story", id: null }] }),
      [`POST ${PREFIX}/build`]: (_request, response) =>
        json(response, 200, sampleBuildResult(view)),
    });

    expect((await host.view(signal())).version).toBe("sha256:story-v1");
    const edited = await host.edit(
      {
        baseVersion: "sha256:story-v1",
        turnId: "t1",
        operations: [{ op: "set_story", title: "X" }],
      },
      signal(),
    );
    const built = await host.build({ baseVersion: "sha256:story-v1", turnId: "t1" }, signal());

    expect(edited.results).toEqual([{ op: "set_story", id: null }]);
    expect(built.duration).toBe(57);
    expect(seen.map((request) => `${request.method} ${request.path}`)).toEqual([
      `GET ${PREFIX}`,
      `POST ${PREFIX}/edit`,
      `POST ${PREFIX}/build`,
    ]);
    expect(seen[1]?.body).toEqual({
      baseVersion: "sha256:story-v1",
      turnId: "t1",
      operations: [{ op: "set_story", title: "X" }],
    });
    expect(seen[2]?.body).toEqual({ baseVersion: "sha256:story-v1", turnId: "t1" });
  });

  it("maps the service's StoryError to a StoryToolError with its code and failing operation", async () => {
    const { host } = await studio({
      [`POST ${PREFIX}/edit`]: (_request, response) =>
        json(response, 409, {
          error: { code: "user_decision", message: "ch2 duration was set by the user", opIndex: 1 },
        }),
      [`POST ${PREFIX}/build`]: (_request, response) =>
        json(response, 404, { error: { code: "no_story", message: "There is no story yet" } }),
    });
    const refusal = await host
      .edit({ operations: [{ op: "set_story", title: "x" }] }, signal())
      .catch((error: unknown) => error);
    expect(refusal).toBeInstanceOf(StoryToolError);
    expect(refusal).toMatchObject({ code: "user_decision", opIndex: 1 });
    await expect(host.build({}, signal())).rejects.toMatchObject({ code: "no_story" });
  });

  it("reports a malformed or unroutable service as unavailable", async () => {
    const { host } = await studio({
      [`GET ${PREFIX}`]: (_request, response) => json(response, 200, { nope: true }),
    });
    await expect(host.view(signal())).rejects.toMatchObject({
      code: "unavailable",
      message: "Studio returned an invalid story view.",
    });
    await expect(host.build({}, signal())).rejects.toMatchObject({ code: "unavailable" });
  });

  it("does not send a write for a turn that is already stopping", async () => {
    const { host, seen } = await studio({});
    const stopped = new AbortController();
    stopped.abort();
    await expect(host.edit({ operations: [] }, stopped.signal)).rejects.toMatchObject({
      code: "aborted",
    });
    await expect(host.build({}, stopped.signal)).rejects.toMatchObject({ code: "aborted" });
    expect(seen).toEqual([]);
  });

  it("posts a rebuild request to /rebuild with its scope and policy, and validates the result", async () => {
    const view = userEditedStory();
    const { host, seen } = await studio({
      [`POST ${PREFIX}/rebuild`]: (_request, response) =>
        json(response, 200, sampleRebuildResult(view)),
    });
    const request: StoryRebuildRequest = {
      baseVersion: "sha256:story-v1",
      turnId: "t1",
      chapters: ["ch2"],
      manualEdits: "replace",
      allowLocked: ["ch1"],
    };
    const result = await host.rebuild(request, signal());

    expect(seen.map((entry) => `${entry.method} ${entry.path}`)).toEqual([
      `POST ${PREFIX}/rebuild`,
    ]);
    expect(seen[0]?.body).toEqual(request);
    expect(result).toMatchObject({ changed: true, rebuilt: ["ch2"], keptLocked: ["ch1"] });
  });

  it("maps a rebuild refusal to its code and rejects a result without the fields the runtime reads", async () => {
    const { host } = await studio({
      [`POST ${PREFIX}/rebuild`]: (request, response) =>
        request.body && typeof request.body === "object" && "dryRun" in request.body
          ? json(response, 200, { ...sampleRebuildResult(userEditedStory()), keptEdits: "none" })
          : json(response, 409, {
              error: { code: "conflict", message: "The story changed since version sha256:old" },
            }),
    });
    await expect(host.rebuild({ baseVersion: "sha256:old" }, signal())).rejects.toMatchObject({
      code: "conflict",
    });
    await expect(host.rebuild({ dryRun: true }, signal())).rejects.toMatchObject({
      code: "unavailable",
      message: "Studio returned an invalid story rebuild result.",
    });
  });

  it("does not accept a build result without the replaced edits and kept locked chapters", async () => {
    const legacy = { ...sampleBuildResult(userEditedStory()), replacedEdits: undefined };
    const { host } = await studio({
      [`POST ${PREFIX}/build`]: (_request, response) => json(response, 200, legacy),
    });
    await expect(host.build({}, signal())).rejects.toMatchObject({ code: "unavailable" });
  });

  it("does not send a rebuild for a turn that is already stopping", async () => {
    const { host, seen } = await studio({});
    const stopped = new AbortController();
    stopped.abort();
    await expect(host.rebuild({}, stopped.signal)).rejects.toMatchObject({ code: "aborted" });
    expect(seen).toEqual([]);
  });
});
