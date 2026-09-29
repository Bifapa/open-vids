// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAgentGateway, type AgentGateway } from "./gateway.js";
import type { ResolvedProject } from "../types.js";

// A child process plus a gated response verifies streaming and cancellation without fake clocks.
const FAKE_RUNTIME = String.raw`import { createServer } from "node:http";
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";

const token = process.env.OPENVIDS_AGENT_TOKEN;
const countPath = process.env.FAKE_COUNT_PATH;
const pidPath = process.env.FAKE_PID_PATH;
const abortPath = process.env.FAKE_ABORT_PATH;
if (!token || !countPath || !pidPath || !abortPath) throw new Error("fake runtime environment is incomplete");
const newline = String.fromCharCode(10);
let count = 0;
if (existsSync(countPath)) count = Number(readFileSync(countPath, "utf8"));
count += 1;
writeFileSync(countPath, String(count));
writeFileSync(pidPath, String(process.pid));

let finishSse = null;
const server = createServer(async (request, response) => {
  const path = request.url ?? "";
  if (path === "/v1/health") {
    if (request.headers.authorization !== "Bearer " + token) {
      response.writeHead(401).end();
      return;
    }
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ ok: true }));
    return;
  }
  if (path.startsWith("/v1/echo")) {
    const chunks = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({
      auth: request.headers.authorization,
      projectId: request.headers["x-openvids-project-id"],
      projectDir: request.headers["x-openvids-project-dir"],
      studioOrigin: request.headers["x-openvids-studio-origin"],
      accept: request.headers.accept,
      contentType: request.headers["content-type"],
      lastEventId: request.headers["last-event-id"],
      forgedHeader: request.headers["x-openvids-forged"],
      url: path,
      method: request.method,
      body: Buffer.concat(chunks).toString("utf8"),
      count,
    }));
    return;
  }
  if (path === "/v1/sse") {
    response.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "private",
    });
    response.write("data: first" + newline + newline);
    finishSse = () => response.end("data: second" + newline + newline);
    response.on("close", () => {
      finishSse = null;
    });
    return;
  }
  if (path === "/v1/release-sse") {
    const release = finishSse;
    finishSse = null;
    release?.();
    response.writeHead(204).end();
    return;
  }
  if (path === "/v1/abort") {
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.write("data: open" + newline + newline);
    response.on("close", () => appendFileSync(abortPath, "closed"));
    return;
  }
  if (path === "/v1/crash") {
    process.exit(17);
  }
  response.writeHead(404).end();
});

server.listen(Number(process.env.OPENVIDS_AGENT_PORT), "127.0.0.1", () => {
  const address = server.address();
  if (!address || typeof address === "string") process.exit(2);
  process.stdout.write(JSON.stringify({ "openvids-agent": "listening", port: address.port }) + newline);
});
process.once("SIGTERM", () => server.close(() => process.exit(0)));
`;

const project: ResolvedProject = { id: "project-one", dir: "/projects/one" };
const context = { project, subPath: "echo", origin: "http://studio.test" };
const tempDirs: string[] = [];
const gateways: AgentGateway[] = [];

afterEach(async () => {
  await Promise.all(gateways.splice(0).map((gateway) => gateway.dispose()));
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function createTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "openvids-agent-gateway-"));
  tempDirs.push(dir);
  return dir;
}

function createGateway(dir: string): AgentGateway {
  const scriptPath = join(dir, "fake-runtime.mjs");
  writeFileSync(scriptPath, FAKE_RUNTIME);
  const gateway = createAgentGateway({
    launch: () => ({
      command: process.execPath,
      args: [scriptPath],
      cwd: dir,
      env: {
        FAKE_COUNT_PATH: join(dir, "starts"),
        FAKE_PID_PATH: join(dir, "pid"),
        FAKE_ABORT_PATH: join(dir, "aborted"),
      },
    }),
  });
  gateways.push(gateway);
  return gateway;
}

describe("createAgentGateway", () => {
  it("starts lazily and adds trusted scope headers instead of browser values", async () => {
    const dir = createTempDir();
    const gateway = createGateway(dir);
    expect(gateway.status()).toBe("stopped");
    expect(existsSync(join(dir, "pid"))).toBe(false);

    const response = await gateway.handle(
      new Request("http://studio.test/agent/echo?marker=one", {
        method: "POST",
        headers: {
          authorization: "Bearer browser-forgery",
          "x-openvids-project-id": "spoofed-project",
          "x-openvids-project-dir": "/spoofed",
          "x-openvids-studio-origin": "https://spoofed.test",
          "x-openvids-forged": "untrusted",
          accept: "application/json",
          "content-type": "application/json; charset=utf-8",
          "last-event-id": "17",
        },
        body: JSON.stringify({ prompt: "hello" }),
      }),
      { ...context, subPath: "echo" },
    );

    expect(response.status).toBe(200);
    expect(gateway.status()).toBe("running");
    const echo: unknown = await response.json();
    expect(echo).toMatchObject({
      auth: expect.stringMatching(/^Bearer [0-9a-f]{64}$/),
      projectId: project.id,
      projectDir: project.dir,
      studioOrigin: context.origin,
      accept: "application/json",
      contentType: "application/json; charset=utf-8",
      lastEventId: "17",
      url: "/v1/echo?marker=one",
      method: "POST",
      body: JSON.stringify({ prompt: "hello" }),
      count: 1,
    });
    expect(echo).not.toHaveProperty("forgedHeader");
  });

  it("coalesces concurrent first requests into one runtime launch", async () => {
    const dir = createTempDir();
    const gateway = createGateway(dir);
    const responses = await Promise.all(
      Array.from({ length: 4 }, () =>
        gateway.handle(new Request("http://studio.test/agent/echo"), {
          ...context,
          subPath: "echo",
        }),
      ),
    );

    expect(responses.map((response) => response.status)).toEqual([200, 200, 200, 200]);
    await Promise.all(responses.map((response) => response.text()));
    expect(readFileSync(join(dir, "starts"), "utf8")).toBe("1");
  });

  it("passes SSE chunks through as they arrive and cancels the upstream on client abort", async () => {
    const dir = createTempDir();
    const gateway = createGateway(dir);
    const response = await gateway.handle(
      new Request("http://studio.test/agent/sse", {
        headers: { accept: "text/event-stream" },
      }),
      { ...context, subPath: "sse" },
    );
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("x-accel-buffering")).toBe("no");
    const sseReader = response.body?.getReader();
    if (!sseReader) throw new Error("expected an SSE response body");
    const first = await sseReader.read();
    if (!first.value) throw new Error("expected the first SSE event");
    expect(new TextDecoder().decode(first.value)).toBe("data: first\n\n");
    const released = await gateway.handle(new Request("http://studio.test/agent/release-sse"), {
      ...context,
      subPath: "release-sse",
    });
    expect(released.status).toBe(204);
    const second = await sseReader.read();
    if (!second.value) throw new Error("expected the second SSE event");
    expect(new TextDecoder().decode(second.value)).toBe("data: second\n\n");
    await sseReader.cancel();

    const abortController = new AbortController();
    const abortResponse = await gateway.handle(
      new Request("http://studio.test/agent/abort", { signal: abortController.signal }),
      { ...context, subPath: "abort" },
    );
    const abortReader = abortResponse.body?.getReader();
    if (!abortReader) throw new Error("expected an abort-test response body");
    const firstAbortChunk = await abortReader.read();
    if (!firstAbortChunk.value) throw new Error("expected the first abort-test event");
    expect(new TextDecoder().decode(firstAbortChunk.value)).toBe("data: open\n\n");
    const nextRead = abortReader.read().then(
      () => "resolved",
      () => "rejected",
    );
    abortController.abort();
    await vi.waitFor(() => expect(existsSync(join(dir, "aborted"))).toBe(true), {
      timeout: 2_000,
      interval: 20,
    });
    expect(await nextRead).toBe("rejected");
  });

  it("rejects cross-origin requests and non-JSON bodies before starting the runtime", async () => {
    const dir = createTempDir();
    const gateway = createGateway(dir);
    const originResponse = await gateway.handle(
      new Request("http://studio.test/agent/echo", {
        headers: { origin: "http://attacker.test", host: "studio.test" },
      }),
      context,
    );
    expect(originResponse.status).toBe(403);

    const contentTypeResponse = await gateway.handle(
      new Request("http://studio.test/agent/echo", {
        method: "POST",
        headers: { "content-type": "text/plain" },
        body: "prompt=hello",
      }),
      context,
    );
    expect(contentTypeResponse.status).toBe(415);
    expect(gateway.status()).toBe("stopped");
    expect(existsSync(join(dir, "pid"))).toBe(false);
  });

  it("returns 502 after a runtime crash and restarts with backoff on the next request", async () => {
    const dir = createTempDir();
    const gateway = createGateway(dir);
    const crash = await gateway.handle(new Request("http://studio.test/agent/crash"), {
      ...context,
      subPath: "crash",
    });
    expect(crash.status).toBe(502);
    await vi.waitFor(() => expect(gateway.status()).toBe("failed"), {
      timeout: 2_000,
      interval: 20,
    });

    const restarted = await gateway.handle(new Request("http://studio.test/agent/echo"), {
      ...context,
      subPath: "echo",
    });
    expect(restarted.status).toBe(200);
    expect(gateway.status()).toBe("running");
    expect(readFileSync(join(dir, "starts"), "utf8")).toBe("2");
  });

  it("returns 503 when the runtime is not installed and kills the child on dispose", async () => {
    const missing = createAgentGateway({ launch: () => null });
    gateways.push(missing);
    const unavailable = await missing.handle(new Request("http://studio.test/agent/echo"), context);
    expect(unavailable.status).toBe(503);
    expect(await unavailable.json()).toMatchObject({
      error: { code: "runtime_unavailable", message: expect.stringContaining("not installed") },
    });

    const dir = createTempDir();
    const gateway = createGateway(dir);
    const running = await gateway.handle(new Request("http://studio.test/agent/echo"), context);
    expect(running.status).toBe(200);
    const childPid = Number(readFileSync(join(dir, "pid"), "utf8"));
    await gateway.dispose();
    expect(gateway.status()).toBe("stopped");
    expect(() => process.kill(childPid, 0)).toThrow();
  });
});
