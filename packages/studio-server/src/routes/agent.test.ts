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
});
