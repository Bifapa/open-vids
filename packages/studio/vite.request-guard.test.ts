import { createServer, request, type Server } from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { studioRequestGuard } from "./vite.request-guard";

let server: Server;
let port: number;

beforeEach(async () => {
  const guard = studioRequestGuard();
  server = createServer((req, res) => {
    guard(req, res, () => {
      res.writeHead(200);
      res.end("api");
    });
  });
  const listening = Promise.withResolvers<void>();
  server.listen(0, "127.0.0.1", listening.resolve);
  await listening.promise;
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("no TCP address");
  port = address.port;
});

afterEach(async () => {
  const closed = Promise.withResolvers<void>();
  server.close(() => closed.resolve());
  await closed.promise;
});

// fetch() forbids overriding Host/Origin, so speak raw http.
function send(method: string, headers: Record<string, string>): Promise<number> {
  const { promise, resolve, reject } = Promise.withResolvers<number>();
  const req = request(
    { host: "127.0.0.1", port, path: "/api/projects", method, headers },
    (res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    },
  );
  req.on("error", reject);
  req.end(method === "GET" ? undefined : "{}");
  return promise;
}

describe("dev host request guard", () => {
  it("refuses a rebound Host before the request reaches /api", async () => {
    expect(await send("GET", { host: "evil.example:5190" })).toBe(403);
  });

  it("refuses a CORS-simple POST from a foreign Origin", async () => {
    const status = await send("POST", {
      host: `127.0.0.1:${port}`,
      origin: "https://evil.example",
      "content-type": "text/plain",
    });
    expect(status).toBe(403);
  });

  it("refuses a cross-site fetch even without an Origin", async () => {
    expect(
      await send("DELETE", { host: `127.0.0.1:${port}`, "sec-fetch-site": "cross-site" }),
    ).toBe(403);
  });

  it("lets the Studio's own same-origin requests through", async () => {
    const host = `127.0.0.1:${port}`;
    expect(await send("POST", { host, origin: `http://${host}` })).toBe(200);
    expect(await send("GET", { host: `localhost:${port}` })).toBe(200);
  });
});
