import { mkdtemp, mkdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { describe, expect, it } from "vitest";
import { AGENT_HEADERS, AGENT_PROTOCOL_VERSION, isRecord } from "@hyperframes/agent-protocol";
import { createRuntimeApp, type RuntimeApp } from "./server.js";
import { AgentSettingsStore } from "./settings.js";
import {
  FakeAnalysisHost,
  FakeCheckpointHost,
  FakeEditingHost,
  FakeStoryHost,
} from "./testing/index.js";
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
      editing: () => new FakeEditingHost(),
      analysis: () => new FakeAnalysisHost(),
      story: () => new FakeStoryHost(),
      settings: new AgentSettingsStore(join(root, "settings")),
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
        protocolVersion: AGENT_PROTOCOL_VERSION,
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
      editing: () => new FakeEditingHost(),
      analysis: () => new FakeAnalysisHost(),
      story: () => new FakeStoryHost(),
      settings: new AgentSettingsStore(join(root, "settings")),
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

  it("serves global agent settings, seeds new chats from them and never returns the Jev key", async () => {
    const root = await mkdtemp(join(tmpdir(), "openvids-agent-settings-"));
    const projectDir = join(root, "project");
    await mkdir(projectDir);
    const settingsDir = join(root, "settings");
    const app = createRuntimeApp({
      backend: new ScriptedAgentBackend(),
      checkpoints: new FakeCheckpointHost(),
      editing: () => new FakeEditingHost(),
      analysis: () => new FakeAnalysisHost(),
      story: () => new FakeStoryHost(),
      settings: new AgentSettingsStore(settingsDir),
      token: "runtime-secret",
    });
    const headers = {
      [AGENT_HEADERS.token]: "Bearer runtime-secret",
      [AGENT_HEADERS.projectId]: "project-one",
      [AGENT_HEADERS.projectDir]: projectDir,
      [AGENT_HEADERS.studioOrigin]: "http://127.0.0.1:4173",
    };
    const call = (path: string, method = "GET", body?: unknown) =>
      app.request(path, {
        method,
        headers: { ...headers, "content-type": "application/json" },
        ...(body !== undefined && { body: JSON.stringify(body) }),
      });
    try {
      const disabled = await call("/v1/settings", "PATCH", {
        specialists: {
          audio: { model: null, thinking: null, allowedModels: [], enabledByDefault: false },
        },
      });
      expect(disabled.status).toBe(200);
      const created = await responseObject(await call("/v1/chats", "POST", {}));
      expect(created.enabledAgents).toEqual(["editor", "vision", "motion", "research"]);

      const patched = await call(`/v1/chats/${String(created.id)}`, "PATCH", {
        enabledAgents: ["vision"],
      });
      expect((await responseObject(patched)).enabledAgents).toEqual(["vision"]);
      expect(
        (await call(`/v1/chats/${String(created.id)}`, "PATCH", { enabledAgents: ["jev"] })).status,
      ).toBe(400);

      const keyed = await call("/v1/settings/jev/api-key", "POST", { apiKey: "sk-very-secret" });
      const keyedText = await keyed.text();
      expect(keyedText).not.toContain("sk-very-secret");
      expect(JSON.parse(keyedText)).toMatchObject({ jev: { apiKeyConfigured: true } });
      expect(await (await call("/v1/settings")).text()).not.toContain("sk-very-secret");
      expect((await stat(join(settingsDir, "jev-credentials.json"))).mode & 0o777).toBe(0o600);

      // Jev is still disabled: the test reports what is missing instead of calling a model.
      expect(await responseObject(await call("/v1/settings/jev/test", "POST", {}))).toMatchObject({
        ok: false,
      });

      const removed = await responseObject(
        await call("/v1/settings/jev/api-key", "POST", { apiKey: null }),
      );
      expect(removed.jev).toMatchObject({ apiKeyConfigured: false });
    } finally {
      await app.dispose();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("persists a chat's mode through PATCH across a restart and records a story turn's mode and action", async () => {
    const root = await mkdtemp(join(tmpdir(), "openvids-agent-mode-"));
    const projectDir = join(root, "project");
    await mkdir(projectDir);
    const headers = {
      [AGENT_HEADERS.token]: "Bearer runtime-secret",
      [AGENT_HEADERS.projectId]: "project-one",
      [AGENT_HEADERS.projectDir]: projectDir,
      [AGENT_HEADERS.studioOrigin]: "http://127.0.0.1:4173",
    };
    const open = () =>
      createRuntimeApp({
        backend: new ScriptedAgentBackend(),
        checkpoints: new FakeCheckpointHost(),
        editing: () => new FakeEditingHost(),
        analysis: () => new FakeAnalysisHost(),
        story: () => new FakeStoryHost(),
        settings: new AgentSettingsStore(join(root, "settings")),
        token: "runtime-secret",
      });
    const call = (app: RuntimeApp, path: string, method = "GET", body?: unknown) =>
      app.request(path, {
        method,
        headers: { ...headers, "content-type": "application/json" },
        ...(body !== undefined && { body: JSON.stringify(body) }),
      });
    const first = open();
    let second: RuntimeApp | null = null;
    try {
      const created = await responseObject(await call(first, "/v1/chats", "POST", {}));
      const chatId = String(created.id);
      expect(created.activeMode).toBe("normal");

      expect(
        (await call(first, `/v1/chats/${chatId}`, "PATCH", { activeMode: "cinema" })).status,
      ).toBe(400);
      const patched = await responseObject(
        await call(first, `/v1/chats/${chatId}`, "PATCH", { activeMode: "story" }),
      );
      expect(patched.activeMode).toBe("story");

      expect(
        (
          await call(first, `/v1/chats/${chatId}/turns`, "POST", {
            prompt: "x",
            storyAction: "deploy",
          })
        ).status,
      ).toBe(400);
      // Options belong to build/rebuild only; a build takes nothing but the locked chapters the user allowed.
      for (const body of [
        { storyAction: "review", storyOptions: { allowLocked: ["ch1"] } },
        { storyAction: "build", storyOptions: { manualEdits: "replace" } },
      ]) {
        expect(
          (await call(first, `/v1/chats/${chatId}/turns`, "POST", { prompt: "x", ...body })).status,
        ).toBe(400);
      }
      const started = await call(first, `/v1/chats/${chatId}/turns`, "POST", {
        prompt: "Build the story",
        mode: "normal",
        storyAction: "build",
        storyOptions: { allowLocked: ["ch1"] },
      });
      expect(started.status).toBeLessThan(300);
      const turn = await responseObject(started);
      // A story action implies story mode whatever the request said.
      expect(turn).toMatchObject({
        turn: { mode: "story", storyAction: "build", storyOptions: { allowLocked: ["ch1"] } },
      });
      for (let attempt = 0; attempt < 200; attempt += 1) {
        const state = await responseObject(await call(first, `/v1/chats/${chatId}`));
        const turns = Array.isArray(state.turns) ? state.turns : [];
        if (turns.length === 1 && isRecord(turns[0]) && turns[0].status !== "running") break;
        // Polling a real HTTP surface backed by file I/O: there is no in-process event to await here.
        await delay(5);
      }
      await first.dispose();

      // After a restart the chat still has its mode and the turn its mode and action.
      second = open();
      const reloaded = await responseObject(await call(second, `/v1/chats/${chatId}`));
      expect(reloaded).toMatchObject({ chat: { activeMode: "story" } });
      expect(reloaded.turns).toMatchObject([
        { mode: "story", storyAction: "build", storyOptions: { allowLocked: ["ch1"] } },
      ]);
    } finally {
      await first.dispose().catch(() => undefined);
      await second?.dispose();
      await rm(root, { recursive: true, force: true });
    }
  });
});
