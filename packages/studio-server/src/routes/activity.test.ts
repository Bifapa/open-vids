import { describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerRenderRoutes } from "./render";
import { registerActivityRoutes } from "./activity";
import type { AgentGateway, AgentGatewayStatus } from "../agent/gateway";
import type { RenderJobState, StudioApiAdapter } from "../types";

function gateway(status: AgentGatewayStatus, activeTurn: unknown): AgentGateway {
  return {
    status: () => status,
    dispose: async () => {},
    handle: vi.fn(async (request: Request, ctx: { subPath: string }) => {
      expect(request.method).toBe("GET");
      expect(ctx.subPath).toBe("chats");
      return Response.json({ chats: [], activeTurn });
    }),
  };
}

function setup(agent?: AgentGateway) {
  const root = mkdtempSync(join(tmpdir(), "hf-activity-test-"));
  const jobs: RenderJobState[] = [];
  const adapter: StudioApiAdapter = {
    listProjects: () => [],
    resolveProject: async (id: string) => (id === "missing" ? null : { id, dir: tmpdir() }),
    bundle: async () => null,
    lint: async () => ({ findings: [] }),
    runtimeUrl: "/api/runtime.js",
    rendersDir: (project) => join(root, project.id, "renders"),
    startRender: (opts) => {
      const job: RenderJobState = {
        id: opts.jobId,
        status: "rendering",
        progress: 0,
        outputPath: opts.outputPath,
      };
      jobs.push(job);
      return job;
    },
    agent,
  };
  const app = new Hono();
  registerActivityRoutes(app, adapter, registerRenderRoutes(app, adapter));
  const activity = async (id: string) => {
    const res = await app.request(`http://localhost/projects/${id}/activity`);
    return { status: res.status, body: await res.json() };
  };
  const render = (id: string) =>
    app.request(`http://localhost/projects/${id}/render`, { method: "POST", body: "{}" });
  return { jobs, activity, render, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

describe("GET /projects/:id/activity", () => {
  it("counts only this project's renders that are still running", async () => {
    const { jobs, activity, render, cleanup } = setup();
    try {
      expect((await activity("a")).body).toEqual({ renders: 0, agentTurn: false });
      await render("a");
      await render("b");
      expect((await activity("a")).body).toEqual({ renders: 1, agentTurn: false });
      for (const job of jobs) job.status = "complete";
      expect((await activity("a")).body.renders).toBe(0);
    } finally {
      cleanup();
    }
  });

  it("reports a running agent turn and never starts a stopped runtime", async () => {
    const running = gateway("running", { chatId: "c", turnId: "t", startedAt: 1 });
    const idle = gateway("running", null);
    const stopped = gateway("stopped", { chatId: "c", turnId: "t", startedAt: 1 });
    for (const [agent, expected] of [
      [running, true],
      [idle, false],
      [stopped, false],
    ] as const) {
      const { activity, cleanup } = setup(agent);
      try {
        expect((await activity("a")).body.agentTurn).toBe(expected);
      } finally {
        cleanup();
      }
    }
    expect(stopped.handle).not.toHaveBeenCalled();
  });

  it("answers 404 for an unknown project", async () => {
    const { activity, cleanup } = setup();
    try {
      expect((await activity("missing")).status).toBe(404);
    } finally {
      cleanup();
    }
  });
});
