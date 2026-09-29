import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { AGENT_HEADERS, isRecord } from "@hyperframes/agent-protocol";
import { createRuntimeApp } from "./server.js";
import { FakeCheckpointHost } from "./testing/index.js";
import { ScriptedAgentBackend } from "./testing/backend.js";

async function responseObject(response: Response): Promise<Record<string, unknown>> {
  const payload: unknown = await response.json();
  if (!isRecord(payload)) throw new Error("Expected a JSON object response");
  return payload;
}

describe("runtime HTTP server", () => {
  it("authenticates requests and rejects invalid project scope", async () => {
    const root = await mkdtemp(join(tmpdir(), "openvids-agent-http-"));
    const projectDir = join(root, "project");
    await mkdir(projectDir);
    const backend = new ScriptedAgentBackend();
    const app = createRuntimeApp({
      backend,
      checkpoints: new FakeCheckpointHost(),
      token: "runtime-secret",
    });
    const headers = {
      [AGENT_HEADERS.token]: "Bearer runtime-secret",
      [AGENT_HEADERS.projectId]: "project-one",
      [AGENT_HEADERS.projectDir]: projectDir,
      [AGENT_HEADERS.studioOrigin]: "http://127.0.0.1:4173",
    };
    try {
      const unauthorized = await app.request("/v1/health");
      expect(unauthorized.status).toBe(401);
      const health = await app.request("/v1/health", {
        headers: { [AGENT_HEADERS.token]: "Bearer runtime-secret" },
      });
      expect(health.status).toBe(200);
      expect(await responseObject(health)).toMatchObject({
        ok: true,
        protocolVersion: 1,
        backend: "scripted",
      });
      const wrongToken = await app.request("/v1/health", {
        headers: { [AGENT_HEADERS.token]: "Bearer wrong" },
      });
      expect(wrongToken.status).toBe(401);
      const unscoped = await app.request("/v1/chats", {
        headers: { [AGENT_HEADERS.token]: "Bearer runtime-secret" },
      });
      expect(unscoped.status).toBe(400);

      const badDirectory = await app.request("/v1/chats", {
        headers: { ...headers, [AGENT_HEADERS.projectDir]: join(root, "missing") },
      });
      expect(badDirectory.status).toBe(400);
      const relativeDirectory = await app.request("/v1/chats", {
        headers: { ...headers, [AGENT_HEADERS.projectDir]: "relative-project" },
      });
      expect(relativeDirectory.status).toBe(400);
      const untrustedOrigin = await app.request("/v1/chats", {
        headers: { ...headers, [AGENT_HEADERS.studioOrigin]: "https://example.com" },
      });
      expect(untrustedOrigin.status).toBe(400);
      const validScope = await app.request("/v1/chats", { headers, method: "POST", body: "{}" });
      expect(validScope.status).toBe(201);
      const mismatchedProject = await app.request("/v1/chats", {
        headers: { ...headers, [AGENT_HEADERS.projectId]: "different-project" },
      });
      expect(mismatchedProject.status).toBe(400);
    } finally {
      await app.dispose();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("replays chat events after the requested sequence and streams later events live", async () => {
    const root = await mkdtemp(join(tmpdir(), "openvids-agent-sse-"));
    const projectDir = join(root, "project");
    await mkdir(projectDir);
    const app = createRuntimeApp({
      backend: new ScriptedAgentBackend(),
      checkpoints: new FakeCheckpointHost(),
      token: "runtime-secret",
    });
    const headers = {
      [AGENT_HEADERS.token]: "Bearer runtime-secret",
      [AGENT_HEADERS.projectId]: "project-one",
      [AGENT_HEADERS.projectDir]: projectDir,
      [AGENT_HEADERS.studioOrigin]: "http://localhost:4173",
    };
    let replayReader: ReadableStreamDefaultReader<Uint8Array> | null = null;
    let liveReader: ReadableStreamDefaultReader<Uint8Array> | null = null;
    let projectReader: ReadableStreamDefaultReader<Uint8Array> | null = null;
    try {
      const created = await app.request("/v1/chats", { method: "POST", headers, body: "{}" });
      const chat = await responseObject(created);
      if (!isRecord(chat) || typeof chat.id !== "string")
        throw new Error("Chat creation did not return an id");
      const chatId = chat.id;

      const replayResponse = await app.request(`/v1/chats/${chatId}/events?after=0`, { headers });
      replayReader = replayResponse.body?.getReader() ?? null;
      if (!replayReader) throw new Error("Chat event stream has no body");
      const replayed = await replayReader.read();
      expect(new TextDecoder().decode(replayed.value)).toContain("id: 1");
      expect(new TextDecoder().decode(replayed.value)).toContain("event: chat");
      await replayReader.cancel();
      replayReader = null;

      const liveResponse = await app.request(`/v1/chats/${chatId}/events`, {
        headers: { ...headers, "Last-Event-ID": "1" },
      });
      liveReader = liveResponse.body?.getReader() ?? null;
      if (!liveReader) throw new Error("Live chat stream has no body");
      const projectResponse = await app.request("/v1/events", { headers });
      projectReader = projectResponse.body?.getReader() ?? null;
      if (!projectReader) throw new Error("Project event stream has no body");
      const projectEvent = projectReader.read();
      const nextEvent = liveReader.read();
      const updated = await app.request(`/v1/chats/${chatId}`, {
        method: "PATCH",
        headers: { ...headers, "content-type": "application/json" },
        body: JSON.stringify({ title: "A new title" }),
      });
      expect(updated.status).toBe(200);
      const [liveChunk, projectChunk] = await Promise.all([nextEvent, projectEvent]);
      const liveFrame = new TextDecoder().decode(liveChunk.value);
      const projectFrame = new TextDecoder().decode(projectChunk.value);
      expect(liveFrame).toContain("id: 2");
      expect(liveFrame).toContain("A new title");
      expect(projectFrame).toContain("event: project");
      expect(projectFrame).toContain("chat.upserted");
    } finally {
      await replayReader?.cancel();
      await liveReader?.cancel();
      await projectReader?.cancel();
      await app.dispose();
      await rm(root, { recursive: true, force: true });
    }
  });
});
