// @vitest-environment node
import { createServer, type Server } from "node:http";
import { gzipSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { pinnedLookup, pinnedTransport } from "./pinnedTransport.js";

// The test server lives on loopback, which the real guard refuses: treat it as public here only.
vi.mock("./address.js", () => ({
  isPrivateAddress: (address: string) => address === "10.0.0.1",
}));

let server: Server;
let port = 0;
const seenHosts: string[] = [];

beforeEach(async () => {
  seenHosts.length = 0;
  server = createServer((request, response) => {
    seenHosts.push(String(request.headers.host));
    if (request.url === "/gz") {
      response.writeHead(200, { "content-encoding": "gzip", "content-type": "text/plain" });
      response.end(gzipSync("hello gzip"));
    } else if (request.url === "/redirect") {
      response.writeHead(302, { location: "/elsewhere" });
      response.end();
    } else if (request.url === "/slow") {
      response.writeHead(200, { "content-type": "text/plain" });
      response.write("part");
    } else {
      response.writeHead(200, { "content-type": "text/plain" });
      response.end("plain");
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("server did not bind");
  port = address.port;
});

afterEach(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

const init = (addresses: string[], signal = new AbortController().signal) => ({
  headers: {},
  redirect: "manual" as const,
  signal,
  addresses,
});

describe("pinnedTransport", () => {
  it("connects to the vetted address for a name that does not resolve, keeping the name as Host", async () => {
    // `.invalid` never resolves: reaching the server proves no DNS lookup decided the destination.
    const response = await pinnedTransport(`http://pinned.invalid:${port}/`, init(["127.0.0.1"]));
    expect(await response.text()).toBe("plain");
    expect(seenHosts).toEqual([`pinned.invalid:${port}`]);
  });

  it("decodes compressed bodies and returns redirects to the caller", async () => {
    const gz = await pinnedTransport(`http://pinned.invalid:${port}/gz`, init(["127.0.0.1"]));
    expect(await gz.text()).toBe("hello gzip");
    expect(gz.headers.get("content-encoding")).toBeNull();
    const moved = await pinnedTransport(
      `http://pinned.invalid:${port}/redirect`,
      init(["127.0.0.1"]),
    );
    expect(moved.status).toBe(302);
    expect(moved.headers.get("location")).toBe("/elsewhere");
  });

  it("refuses to connect when every vetted address turns out private", async () => {
    await expect(
      pinnedTransport(`http://pinned.invalid:${port}/`, init(["10.0.0.1"])),
    ).rejects.toThrow();
    expect(seenHosts).toEqual([]);
  });

  it("aborts a body that is still streaming", async () => {
    const controller = new AbortController();
    const response = await pinnedTransport(
      `http://pinned.invalid:${port}/slow`,
      init(["127.0.0.1"], controller.signal),
    );
    const reader = response.body!.getReader();
    expect((await reader.read()).done).toBe(false);
    controller.abort();
    await expect(reader.read()).rejects.toBeDefined();
  });
});

describe("pinnedLookup", () => {
  const lookup = (addresses: string[], all: boolean) =>
    new Promise<unknown>((resolve) => {
      pinnedLookup(addresses)("example.com", { all }, (error, address, family) =>
        resolve({ error: error?.message ?? null, address, family }),
      );
    });

  it("answers with the vetted addresses only, in either calling convention", async () => {
    expect(await lookup(["93.184.216.34"], false)).toEqual({
      error: null,
      address: "93.184.216.34",
      family: 4,
    });
    expect(await lookup(["93.184.216.34", "2606:2800:220:1::1"], true)).toMatchObject({
      address: [
        { address: "93.184.216.34", family: 4 },
        { address: "2606:2800:220:1::1", family: 6 },
      ],
    });
  });

  it("drops a private address even when it was handed in", async () => {
    expect(await lookup(["10.0.0.1", "93.184.216.34"], false)).toMatchObject({
      address: "93.184.216.34",
    });
    expect(await lookup(["10.0.0.1"], false)).toMatchObject({
      error: "No vetted public address to connect to",
    });
  });
});
