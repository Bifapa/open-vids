import type { Hono } from "hono";
import type { AgentGateway } from "../agent/gateway.js";
import { requestSubPath } from "../helpers/requestSubPath.js";
import type { StudioApiAdapter } from "../types.js";

export function registerAgentRoutes(api: Hono, adapter: StudioApiAdapter): void {
  api.all("/projects/:id/agent/*", async (c) => {
    const project = await adapter.resolveProject(c.req.param("id"));
    if (!project) {
      return c.json({ error: { code: "invalid_request", message: "Project not found." } }, 404);
    }
    const agent: AgentGateway | undefined = adapter.agent;
    if (!agent) {
      return c.json(
        {
          error: {
            code: "runtime_unavailable",
            message: "The local agent runtime is not available on this Studio server.",
          },
        },
        503,
      );
    }
    return agent.handle(c.req.raw, {
      project,
      subPath: requestSubPath(c.req.url, "projects/:id/agent"),
      origin: new URL(c.req.url).origin,
    });
  });
}
