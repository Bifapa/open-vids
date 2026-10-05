import { createServer, request, type Server } from "node:http";
import {
  connect,
  createServer as createTcpServer,
  type LookupFunction,
  type Server as TcpServer,
} from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createRequestPolicy, type RequestPolicy } from "./requestPolicy.js";
import { startSiteProxy, type ProxyRefusal, type SiteProxy } from "./siteProxy.js";

const PUBLIC = "93.184.216.34";
const open: Array<{ close(): unknown }> = [];

afterEach(async () => {
  while (open.length > 0) await open.pop()?.close();
});

function listenHttp(
  handler: Parameters<typeof createServer>[1],
): Promise<{ server: Server; port: number }> {
  return new Promise((resolve) => {
    const server = createServer(handler);
    server.listen(0, "127.0.0.1", () => {
      open.push({ close: () => server.closeAllConnections() });
      open.push(server);
      const address = server.address();
      resolve({ server, port: typeof address === "object" && address ? address.port : 0 });
    });
  });
}

function listenTcp(onData: (data: Buffer) => string): Promise<{ server: TcpServer; port: number }> {
  return new Promise((resolve) => {
    const server = createTcpServer((socket) => {
      socket.on("data", (data) => socket.end(onData(Buffer.from(data))));
    });
    server.listen(0, "127.0.0.1", () => {
      open.push(server);
      const address = server.address();
      resolve({ server, port: typeof address === "object" && address ? address.port : 0 });
    });
  });
}

/** Reaches the fixture on loopback whatever address the policy vetted (the real lookup refuses loopback). */
const toFixture =
  (seen: string[][] = []): ((addresses: readonly string[]) => LookupFunction) =>
  (addresses) =>
  (_host, options, callback) => {
    seen.push([...addresses]);
    if (options.all) callback(null, [{ address: "127.0.0.1", family: 4 }]);
    else callback(null, "127.0.0.1", 4);
  };

async function proxyFor(
  policy: RequestPolicy,
  lookupFor?: (addresses: readonly string[]) => LookupFunction,
): Promise<{ proxy: SiteProxy; refusals: ProxyRefusal[] }> {
  const refusals: ProxyRefusal[] = [];
  const proxy = await startSiteProxy(policy, refusals, lookupFor);
  open.push(proxy);
  return { proxy, refusals };
}

/** Sends a CONNECT and returns the proxy's status line plus whatever the tunnel answers to `payload`. */
function tunnel(proxyPort: number, target: string, payload: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = connect(proxyPort, "127.0.0.1");
    let received = "";
    socket.on("error", reject);
    socket.on("data", (data) => {
      received += data.toString("latin1");
      if (received.includes("200 Connection Established") && !received.includes("\r\n\r\nECHO")) {
        socket.write(payload);
      }
    });
    socket.on("close", () => resolve(received));
    socket.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n\r\n`);
  });
}

describe("the site proxy", () => {
  it("tunnels to the address the policy vetted, never to a fresh DNS answer", async () => {
    const reached = vi.fn((data: Buffer) => `ECHO ${data.toString()}`);
    const origin = await listenTcp(reached);
    // The name resolves to a public address the first time; a rebinding server would answer loopback afterwards.
    let answers = 0;
    const policy = createRequestPolicy(async () => (answers++ === 0 ? [PUBLIC] : ["127.0.0.1"]));
    const seen: string[][] = [];
    const { proxy, refusals } = await proxyFor(policy, toFixture(seen));

    expect(await policy.check("https://rebind.example.com/")).toBeNull();
    const first = await tunnel(proxy.port, `rebind.example.com:${origin.port}`, "hello");
    const second = await tunnel(proxy.port, `rebind.example.com:${origin.port}`, "again");

    expect(first).toContain("200 Connection Established");
    expect(first).toContain("ECHO hello");
    expect(second).toContain("ECHO again");
    expect(seen).toEqual([[PUBLIC], [PUBLIC]]);
    expect(answers).toBe(1);
    expect(refusals).toEqual([]);
  });

  it("refuses a tunnel to loopback, a private name and a name that answers a private address", async () => {
    const origin = await listenTcp(() => "ECHO reached");
    const policy = createRequestPolicy(async (host) =>
      host === "rebind.example.com" ? [PUBLIC, "10.0.0.7"] : [PUBLIC],
    );
    const { proxy, refusals } = await proxyFor(policy, toFixture());

    for (const target of [
      `127.0.0.1:${origin.port}`,
      `[::1]:${origin.port}`,
      `localhost:${origin.port}`,
      `rebind.example.com:${origin.port}`,
    ]) {
      const answer = await tunnel(proxy.port, target, "hello");
      expect(answer).toContain("403 Forbidden");
      expect(answer).not.toContain("ECHO");
    }
    expect(refusals.map((entry) => entry.url)).toEqual([
      `https://127.0.0.1:${origin.port}/`,
      `https://[::1]:${origin.port}/`,
      `https://localhost:${origin.port}/`,
      `https://rebind.example.com:${origin.port}/`,
    ]);
    expect(refusals.every((entry) => entry.reason.length > 0)).toBe(true);
  });

  it("keeps the real pinned lookup's own refusal of a private address as a second line", async () => {
    const origin = await listenTcp(() => "ECHO reached");
    const policy: RequestPolicy = {
      check: async () => null,
      vet: async () => ({ ok: true, addresses: ["127.0.0.1"] }),
    };
    const { proxy } = await proxyFor(policy);

    const answer = await tunnel(proxy.port, `bug.example.com:${origin.port}`, "hello");

    expect(answer).toContain("502 Bad Gateway");
    expect(answer).not.toContain("ECHO");
  });

  it("forwards a plain http request to the vetted address and refuses a private one", async () => {
    let hits = 0;
    const origin = await listenHttp((req, res) => {
      hits += 1;
      res.writeHead(200, { "content-type": "text/plain", "x-host": req.headers.host ?? "" });
      res.end(`path ${req.url}`);
    });
    const policy = createRequestPolicy(async () => [PUBLIC]);
    const { proxy, refusals } = await proxyFor(policy, toFixture());

    const get = (url: string) =>
      new Promise<{ status: number; body: string; host: string }>((resolve, reject) => {
        const req = request(
          {
            host: "127.0.0.1",
            port: proxy.port,
            method: "GET",
            path: url,
            // Chrome names the origin in Host; the client's default would name the proxy.
            headers: { host: new URL(url).host },
          },
          (res) => {
            let body = "";
            res.on("data", (chunk) => (body += chunk));
            res.on("end", () =>
              resolve({ status: res.statusCode ?? 0, body, host: String(res.headers["x-host"]) }),
            );
          },
        );
        req.on("error", reject);
        req.end();
      });

    const allowed = await get(`http://site.example.com:${origin.port}/a/b?c=1`);
    expect(allowed).toEqual({
      status: 200,
      body: "path /a/b?c=1",
      host: `site.example.com:${origin.port}`,
    });

    hits = 0;
    const refused = await get(`http://127.0.0.1:${origin.port}/secret`);
    expect(refused.status).toBe(403);
    expect(hits).toBe(0);
    expect(refusals).toHaveLength(1);
    expect(refusals[0]?.url).toBe(`http://127.0.0.1:${origin.port}/secret`);
  });
});
