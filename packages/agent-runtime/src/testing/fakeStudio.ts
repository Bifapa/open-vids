import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { isRecord } from "@hyperframes/agent-protocol";
import type { ProjectScope } from "../checkpointHost.js";

/** One request the fake Studio received. */
export interface Seen {
  method: string;
  path: string;
  body: unknown;
}

export type Route = (request: Seen, response: ServerResponse) => void;

const servers = new Set<Server>();

function stop(server: Server): Promise<void> {
  return new Promise<void>((resolve) => {
    server.closeAllConnections();
    server.close(() => resolve());
  });
}

/** Closes every fake Studio a test started; call it from `afterEach`. */
export async function closeFakeStudios(): Promise<void> {
  const open = [...servers];
  servers.clear();
  await Promise.all(open.map(stop));
}

export function json(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}

/**
 * A loopback stand-in for Studio's HTTP routes for the project "p 1": `routes` is keyed by "METHOD /path-without-query"
 * and a cancel route is keyed as `…/requests/:id/cancel`. `makeHost` builds the host under test against it.
 */
export async function fakeStudio<Host>(
  routes: Record<string, Route>,
  makeHost: (scope: ProjectScope) => Host,
): Promise<{ host: Host; seen: Seen[]; close: () => Promise<void> }> {
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
  servers.add(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("no port");
  const scope: ProjectScope = {
    projectId: "p 1",
    projectDir: "/tmp/p",
    studioOrigin: `http://127.0.0.1:${address.port}`,
  };
  return { host: makeHost(scope), seen, close: () => stop(server) };
}

/** A write's body carries the request id its cancel will name. */
export function requestIdOf(request: Seen | undefined): string {
  if (!request || !isRecord(request.body) || typeof request.body.requestId !== "string")
    throw new Error("no request id");
  return request.body.requestId;
}

/** Studio's cancel route, answering with `state` and telling the test the cancel arrived. */
export function cancelRoute(state: string): { route: Route; arrived: Promise<void> } {
  const arrived = Promise.withResolvers<void>();
  const route: Route = (request, response) => {
    json(response, 200, { requestId: request.path.split("/").at(-2), state });
    arrived.resolve();
  };
  return { route, arrived: arrived.promise };
}

/** A route that keeps the request open until the test answers it. */
export function heldRoute(): { route: Route; held: Promise<ServerResponse> } {
  const held = Promise.withResolvers<ServerResponse>();
  const route: Route = (_request, response) => held.resolve(response);
  return { route, held: held.promise };
}
