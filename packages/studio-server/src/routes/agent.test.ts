import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createStudioApi } from "../createStudioApi.js";
import type { AgentGateway } from "../agent/gateway.js";
import type { StudioApiAdapter } from "../types.js";

function createAdapter(agent?: AgentGateway): StudioApiAdapter {
  return {
    agent,
    listProjects: () => [],
    resolveProject: (id) => (id === "known" ? { id, dir: "/projects/known" } : null),
    bundle: async () => null,
    lint: () => ({ findings: [] }),
    runtimeUrl: "/api/runtime.js",
    rendersDir: () => "/tmp/renders",
    startRender: () => ({
      id: "render-1",
      status: "rendering",
      progress: 0,
      outputPath: "/tmp/out.mp4",
    }),
  };
}

const noAgent = createAdapter();

describe("agent gateway route", () => {
  it("resolves the project and passes the same-origin URL scope to the gateway", async () => {
    let received: {
      projectId: string;
      projectDir: string;
      subPath: string;
      origin: string;
    } | null = null;
    const agent: AgentGateway = {
      handle: async (_request, context) => {
        received = {
          projectId: context.project.id,
          projectDir: context.project.dir,
          subPath: context.subPath,
          origin: context.origin,
        };
        return Response.json({ ok: true });
      },
      status: () => "stopped",
      dispose: async () => {},
    };
    const api = createStudioApi(createAdapter(agent));

    const response = await api.fetch(
      new Request("http://studio.test/projects/known/agent/chats?after=4"),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    expect(received).toEqual({
      projectId: "known",
      projectDir: "/projects/known",
      subPath: "chats",
      origin: "http://studio.test",
    });
  });

  it("forwards the provider routes (list, refresh, save or remove a key) untouched, and never echoes a key", async () => {
    const seen: Array<{ method: string; subPath: string; body: string }> = [];
    const agent: AgentGateway = {
      handle: async (request, context) => {
        seen.push({
          method: request.method,
          subPath: context.subPath,
          body: await request.text(),
        });
        return Response.json({ providers: [], syncedAt: null });
      },
      status: () => "stopped",
      dispose: async () => {},
    };
    const api = createStudioApi(createAdapter(agent));
    const post = (path: string, body?: unknown) =>
      api.fetch(
        new Request(`http://studio.test/projects/known/agent/${path}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          ...(body !== undefined && { body: JSON.stringify(body) }),
        }),
      );

    expect(
      (await api.fetch(new Request("http://studio.test/projects/known/agent/providers"))).status,
    ).toBe(200);
    expect((await post("providers/refresh")).status).toBe(200);
    const saved = await post("providers/openrouter/api-key", { apiKey: "sk-or-secret" });
    expect(saved.status).toBe(200);
    expect(await saved.text()).not.toContain("sk-or-secret");
    expect((await post("providers/openrouter/api-key", { apiKey: null })).status).toBe(200);

    expect(seen).toEqual([
      { method: "GET", subPath: "providers", body: "" },
      { method: "POST", subPath: "providers/refresh", body: "" },
      {
        method: "POST",
        subPath: "providers/openrouter/api-key",
        body: JSON.stringify({ apiKey: "sk-or-secret" }),
      },
      {
        method: "POST",
        subPath: "providers/openrouter/api-key",
        body: JSON.stringify({ apiKey: null }),
      },
    ]);
  });

  it("returns project-not-found and runtime-unavailable responses without a gateway", async () => {
    const api = createStudioApi(noAgent);
    const missingProject = await api.fetch(
      new Request("http://studio.test/projects/missing/agent/chats"),
    );
    expect(missingProject.status).toBe(404);
    expect(await missingProject.json()).toMatchObject({ error: { code: "invalid_request" } });

    const unavailable = await api.fetch(
      new Request("http://studio.test/projects/known/agent/chats"),
    );
    expect(unavailable.status).toBe(503);
    expect(await unavailable.json()).toMatchObject({
      error: { code: "runtime_unavailable" },
    });
  });

  it("hands out a project's intake exactly once, without the agent runtime", async () => {
    const dir = mkdtempSync(join(tmpdir(), "openvids-intake-"));
    try {
      const adapter = createAdapter();
      adapter.resolveProject = (id) => (id === "known" ? { id, dir } : null);
      const api = createStudioApi(adapter);
      const claim = () =>
        api.fetch(
          new Request("http://studio.test/projects/known/agent/intake/claim", { method: "POST" }),
        );

      expect((await claim()).status).toBe(204);

      mkdirSync(join(dir, ".hyperframes", "agent"), { recursive: true });
      writeFileSync(
        join(dir, ".hyperframes", "agent", "intake.json"),
        JSON.stringify({
          version: 1,
          prompt: "Cut a 30 second teaser",
          intent: "plan",
          model: "anthropic/claude-sonnet",
          thinking: "medium",
          agents: ["vision", "editor"],
          files: [{ path: "assets/a.mp4", name: "a.mp4", size: 10, kind: "video" }],
          createdAt: "2026-10-01T00:00:00Z",
        }),
      );
      // Two Studio tabs claiming at once: one gets the intake, the other nothing.
      const [first, second] = await Promise.all([claim(), claim()]);
      const statuses = [first.status, second.status].sort();
      expect(statuses).toEqual([200, 204]);
      const winner = first.status === 200 ? first : second;
      expect(await winner.json()).toMatchObject({
        prompt: "Cut a 30 second teaser",
        // An intake written before the Plan mode was removed starts as Edit.
        intent: "edit",
        model: { provider: "anthropic", modelId: "claude-sonnet" },
        agents: ["editor", "vision"],
        files: [{ path: "assets/a.mp4", kind: "video" }],
      });
      expect(readdirSync(join(dir, ".hyperframes", "agent"))).toEqual([]);
      expect((await claim()).status).toBe(204);

      writeFileSync(join(dir, ".hyperframes", "agent", "intake.json"), "{ nope");
      expect((await claim()).status).toBe(422);
      expect(readdirSync(join(dir, ".hyperframes", "agent"))).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
