/**
 * The only way the page's Chrome reaches the network. Chrome is started with this proxy for everything, loopback
 * included, so every connection it makes (documents, subresources, preconnects, WebSocket handshakes, workers)
 * arrives here as a plain request or a CONNECT. Each one is resolved by the request policy once per host and run,
 * and connected to the vetted addresses only: Chrome never asks DNS itself, so a name that answers differently the
 * second time (DNS rebinding) cannot steer a connection to a private address, and sockets the page opens outside
 * the request interception meet the same address rules as its HTTP requests.
 */

import {
  createServer,
  request as httpRequest,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { connect, type LookupFunction, type Socket } from "node:net";
import type { Duplex } from "node:stream";
import { normalizeHostname } from "@hyperframes/studio-server/public-address";
import { pinnedLookup } from "@hyperframes/studio-server/pinned-lookup";
import type { RequestPolicy } from "./requestPolicy.js";

export interface SiteProxy {
  port: number;
  close(): Promise<void>;
}

/** What the proxy refused: the same shape the request interception reports, so one note covers both. */
export interface ProxyRefusal {
  url: string;
  reason: string;
}

const REFUSED = "HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n";
const BAD_REQUEST = "HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n";
const BAD_GATEWAY = "HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\nContent-Length: 0\r\n\r\n";

/** Request headers that talk to this proxy, not to the origin. */
function originHeaders(headers: IncomingHttpHeaders): IncomingHttpHeaders {
  const kept: IncomingHttpHeaders = {};
  for (const [name, value] of Object.entries(headers)) {
    if (!name.startsWith("proxy-")) kept[name] = value;
  }
  return kept;
}

export async function startSiteProxy(
  policy: RequestPolicy,
  refusals: ProxyRefusal[],
  /** Builds the DNS-free lookup for a vetted answer; tests swap it to reach a fixture on loopback. */
  lookupFor: (addresses: readonly string[]) => LookupFunction = pinnedLookup,
): Promise<SiteProxy> {
  const sockets = new Set<Duplex>();
  const track = <T extends Duplex>(socket: T): T => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    return socket;
  };

  const server = createServer();
  server.on("connection", (socket) => void track(socket));

  // A plain http:// request: Chrome sends it with an absolute URL.
  server.on("request", (req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      let target: URL;
      try {
        target = new URL(req.url ?? "");
      } catch {
        res.socket?.end(BAD_REQUEST);
        return;
      }
      if (target.protocol !== "http:") {
        res.socket?.end(BAD_REQUEST);
        return;
      }
      const host = normalizeHostname(target.hostname);
      const verdict = await policy.vet(host);
      if (!verdict.ok) {
        refusals.push({ url: target.href, reason: verdict.reason });
        res.socket?.end(REFUSED);
        return;
      }
      const upstream = httpRequest({
        host,
        port: target.port === "" ? 80 : Number(target.port),
        method: req.method,
        path: `${target.pathname}${target.search}`,
        headers: originHeaders(req.headers),
        lookup: lookupFor(verdict.addresses),
        agent: false,
      });
      upstream.on("response", (answer) => {
        res.writeHead(answer.statusCode ?? 502, answer.statusMessage, answer.headers);
        answer.pipe(res);
      });
      upstream.on("error", () => {
        if (res.headersSent) res.destroy();
        else res.socket?.end(BAD_GATEWAY);
      });
      res.once("close", () => upstream.destroy());
      req.pipe(upstream);
    })();
  });

  // A tunnel (https, and the handshake of every WebSocket): `host:port` and then opaque bytes.
  server.on("connect", (req: IncomingMessage, client: Duplex, head: Buffer) => {
    track(client);
    client.on("error", () => client.destroy());
    void (async () => {
      let target: URL;
      try {
        target = new URL(`http://${req.url ?? ""}`);
      } catch {
        client.end(BAD_REQUEST);
        return;
      }
      const host = normalizeHostname(target.hostname);
      const verdict = await policy.vet(host);
      if (!verdict.ok) {
        refusals.push({ url: `https://${target.host}/`, reason: verdict.reason });
        client.end(REFUSED);
        return;
      }
      const upstream: Socket = track(
        connect({
          host,
          port: target.port === "" ? 80 : Number(target.port),
          lookup: lookupFor(verdict.addresses),
        }),
      );
      let established = false;
      upstream.on("error", () => {
        if (established) client.destroy();
        else client.end(BAD_GATEWAY);
      });
      upstream.once("connect", () => {
        established = true;
        client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        if (head.length > 0) upstream.write(head);
        upstream.pipe(client);
        client.pipe(upstream);
      });
      client.once("close", () => upstream.destroy());
      upstream.once("close", () => client.destroy());
    })();
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    server.close();
    throw new Error("The site proxy has no port");
  }
  const { port } = address;

  return {
    port,
    close: () =>
      new Promise<void>((resolve) => {
        for (const socket of sockets) socket.destroy();
        server.close(() => resolve());
      }),
  };
}
