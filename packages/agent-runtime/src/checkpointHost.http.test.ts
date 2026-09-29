import { createServer } from "node:http";
import type { Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { isRecord } from "@hyperframes/agent-protocol";
import { HttpCheckpointHost } from "./checkpointHost.http.js";
import type { ProjectScope } from "./checkpointHost.js";

interface RequestRecord {
  method: string;
  path: string;
  body: unknown;
}

const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve, reject) => {
          server.close((error) => (error ? reject(error) : resolve()));
        }),
    ),
  );
});

async function fakeHistoryServer(entries: unknown[], undoResponses: Record<string, unknown> = {}) {
  const requests: RequestRecord[] = [];
  const server = createServer((request, response) => {
    let bodyText = "";
    request.setEncoding("utf8");
    request.on("data", (chunk: string) => {
      bodyText += chunk;
    });
    request.on("end", () => {
      let body: unknown = {};
      if (bodyText) {
        try {
          body = JSON.parse(bodyText);
        } catch {
          body = null;
        }
      }
      requests.push({ method: request.method ?? "GET", path: request.url ?? "", body });
      let result: unknown;
      if (request.method === "GET") result = { entries, back: null, forward: null };
      else if (request.url?.endsWith("/window")) result = { windowId: "window-1", startedAt: 500 };
      else if (request.url?.endsWith("/window/window-1/close")) result = { entry: null };
      else if (request.url?.endsWith("/undo")) {
        const entryId = isRecord(body) && typeof body.entryId === "string" ? body.entryId : "";
        result = undoResponses[entryId] ?? { ok: true, entry: null };
      } else result = { ok: true };
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(result));
    });
  });
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Fake history server did not bind a TCP port");
  const scope: ProjectScope = {
    projectId: "project-one",
    projectDir: "/tmp/project-one",
    studioOrigin: `http://127.0.0.1:${address.port}`,
  };
  return { scope, requests };
}

const entry = (id: string, endedAt: number, label = "Director: render") => ({
  id,
  who: { kind: "agent", name: "Director" },
  label,
  startedAt: 500,
  endedAt,
  files: [],
});

describe("HttpCheckpointHost", () => {
  it("opens and closes a window, then returns matching entries oldest first", async () => {
    const fixture = await fakeHistoryServer([
      entry("newer", 800),
      entry("other-label", 850, "Director: other"),
      entry("older", 700),
    ]);
    const host = new HttpCheckpointHost();
    const handle = await host.begin(fixture.scope, "Director: render");
    expect(await handle.end()).toEqual(["older", "newer"]);
    expect(fixture.requests[0]).toMatchObject({
      method: "POST",
      path: "/api/projects/project-one/history/window",
      body: {
        who: { kind: "agent", name: "Director" },
        label: "Director: render",
        idleMs: 600_000,
      },
    });
    expect(
      fixture.requests.some((request) => request.path.endsWith("/window/window-1/close")),
    ).toBe(true);
    expect(await host.recover(fixture.scope, "Director: render", 500)).toEqual(["older", "newer"]);
  });

  it("passes the selected mode for every newest-first undo and reports partial conflicts", async () => {
    const fixture = await fakeHistoryServer([], {
      older: { ok: false, conflict: { files: ["index.html"], newer: ["later"] } },
      newer: { ok: true, entry: { id: "undo-newer" } },
    });
    const host = new HttpCheckpointHost();
    const result = await host.revert(fixture.scope, ["older", "newer"], "just-this");
    expect(result).toEqual({
      ok: false,
      conflict: { files: ["index.html"] },
      remainingEntryIds: ["older"],
    });
    const undos = fixture.requests.filter((request) => request.path.endsWith("/undo"));
    expect(undos).toHaveLength(2);
    expect(undos.map((request) => (isRecord(request.body) ? request.body.entryId : null))).toEqual([
      "newer",
      "older",
    ]);
    expect(undos.map((request) => (isRecord(request.body) ? request.body.mode : null))).toEqual([
      "just-this",
      "just-this",
    ]);
  });
});
