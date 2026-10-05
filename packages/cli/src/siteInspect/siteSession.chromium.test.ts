import { createServer, type Server } from "node:http";
import {
  createServer as createTcpServer,
  type LookupFunction,
  type Server as TcpServer,
} from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Browser } from "puppeteer-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createRequestPolicy } from "./requestPolicy.js";
import { guardPage, launchChrome, type PageCapture } from "./siteSession.js";

// launchChrome finds its Chrome through the engine's browser manager, which honours this variable.
const chrome = process.env.HYPERFRAMES_BROWSER_PATH;
const PUBLIC = "93.184.216.34";

function listen(server: Server | TcpServer): Promise<number> {
  return new Promise((resolve, reject) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") reject(new Error("no port"));
      else resolve(address.port);
    });
  });
}

/** Every vetted connection lands on the loopback fixture (the real lookup refuses loopback, as it should). */
const toFixture: (addresses: readonly string[]) => LookupFunction =
  () => (_host, options, callback) => {
    if (options.all) callback(null, [{ address: "127.0.0.1", family: 4 }]);
    else callback(null, "127.0.0.1", 4);
  };

describe.runIf(chrome)("the page's Chrome behind the vetting proxy", () => {
  let site: Server;
  let internal: TcpServer;
  let internalPort = 0;
  let internalConnections = 0;
  let sitePort = 0;
  let profile = "";
  let browser: Browser | undefined;

  const page = (internal: number) => `<!doctype html><title>pending</title><script>
    const worker = new Worker(URL.createObjectURL(new Blob([
      "try { new WebSocket('ws://127.0.0.1:${internal}/ws'); } catch (e) {}" +
      "fetch('http://127.0.0.1:${internal}/worker').catch(() => {});",
    ])));
    fetch("/ok.txt").then((r) => r.text()).then((text) => { document.title = text; });
  </script>`;

  beforeAll(async () => {
    internal = createTcpServer((socket) => {
      internalConnections += 1;
      socket.destroy();
    });
    internalPort = await listen(internal);
    site = createServer((req, res) => {
      if (req.url === "/ok.txt") res.writeHead(200, { "content-type": "text/plain" }).end("served");
      else res.writeHead(200, { "content-type": "text/html" }).end(page(internalPort));
    });
    sitePort = await listen(site);
    profile = mkdtempSync(join(tmpdir(), "openvids-site-test-"));
  });
  afterAll(async () => {
    await browser?.close().catch(() => {});
    site?.close();
    internal?.close();
    rmSync(profile, { recursive: true, force: true });
  });

  it("loads the vetted public page through the proxy while a worker's sockets to a private address go nowhere", async () => {
    const policy = createRequestPolicy(async () => [PUBLIC]);
    const capture: PageCapture = { blocked: [], pending: [] };
    browser = await launchChrome(profile, policy, capture.blocked, toFixture);
    const tab = await browser.newPage();
    await guardPage(tab, policy, capture);

    await tab.goto(`http://site.example.test:${sitePort}/`, { waitUntil: "load", timeout: 15_000 });
    await tab.waitForFunction(() => document.title === "served", { timeout: 10_000 });
    await new Promise((resolve) => setTimeout(resolve, 1500));

    expect(internalConnections).toBe(0);
    expect(capture.blocked.some((entry) => entry.url.includes(`127.0.0.1:${internalPort}`))).toBe(
      true,
    );
  }, 40_000);
});
