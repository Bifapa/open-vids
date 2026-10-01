import type { Hono } from "hono";
import { originMatchesHost, type AgentGateway } from "../agent/gateway.js";
import { claimIntake } from "../agent/intake.js";
import { requestSubPath } from "../helpers/requestSubPath.js";
import type { StudioApiAdapter } from "../types.js";

export function registerAgentRoutes(api: Hono, adapter: StudioApiAdapter): void {
  // Served by Studio itself (before the runtime proxy): the project's start-from-chat intake, handed out once.
  api.post("/projects/:id/agent/intake/claim", async (c) => {
    if (!originMatchesHost(c.req.raw)) {
      return c.json(
        {
          error: {
            code: "invalid_request",
            message: "The request Origin does not match its Host.",
          },
        },
        403,
      );
    }
    const project = await adapter.resolveProject(c.req.param("id"));
    if (!project) {
      return c.json({ error: { code: "invalid_request", message: "Project not found." } }, 404);
    }
    const claim = await claimIntake(project.dir);
    if (claim.status === "none") return c.body(null, 204);
    if (claim.status === "invalid") {
      return c.json({ error: { code: "invalid_request", message: claim.message } }, 422);
    }
    return c.json(claim.intake);
  });

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
