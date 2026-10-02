import type { Hono } from "hono";
import type { AgentGateway } from "../agent/gateway.js";
import type { ResolvedProject, StudioApiAdapter } from "../types.js";

/** What `GET /projects/:id/activity` needs from the render routes. */
export interface RenderActivity {
  /** Renders of `project` that are still running. */
  activeRenders(project: ResolvedProject): number;
}

/**
 * `GET /projects/:id/activity` → `{ renders, agentTurn }`: work in progress that a restart of the app would cut
 * short. The desktop app asks before it restarts to install an update.
 *
 * Asking never starts the agent runtime: a runtime that is not running has no turn.
 */
export function registerActivityRoutes(
  api: Hono,
  adapter: StudioApiAdapter,
  renders: RenderActivity,
): void {
  api.get("/projects/:id/activity", async (c) => {
    const project = await adapter.resolveProject(c.req.param("id"));
    if (!project) return c.json({ error: "not found" }, 404);
    const origin = new URL(c.req.url).origin;
    return c.json({
      renders: renders.activeRenders(project),
      agentTurn: await agentTurnRunning(adapter.agent, project, origin),
    });
  });
}

async function agentTurnRunning(
  agent: AgentGateway | undefined,
  project: ResolvedProject,
  origin: string,
): Promise<boolean> {
  if (!agent || agent.status() !== "running") return false;
  const url = `${origin}/api/projects/${encodeURIComponent(project.id)}/agent/chats`;
  const response = await agent.handle(new Request(url), { project, subPath: "chats", origin });
  if (!response.ok) {
    await response.body?.cancel();
    return false;
  }
  const body: unknown = await response.json().catch(() => null);
  return (
    typeof body === "object" &&
    body !== null &&
    "activeTurn" in body &&
    typeof body.activeTurn === "object" &&
    body.activeTurn !== null
  );
}
