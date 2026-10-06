import type { Context, Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import {
  parseImportFromProjectRequest,
  parseManifestParts,
  type ResearchError,
} from "@hyperframes/agent-protocol";
import { CrossProjectService } from "../crossProject/service.js";
import { ResearchFailure, isResearchFailure, researchStatus } from "../research/errors.js";
import { parseRequestId, parseTurnId } from "../research/requests.js";
import type { ResolvedProject, StudioApiAdapter } from "../types.js";

const MAX_BODY_BYTES = 64 * 1024;
const MAX_LABEL_CHARS = 200;

const tooLarge = bodyLimit({
  maxSize: MAX_BODY_BYTES,
  onError: (c) =>
    c.json(
      {
        error: {
          code: "invalid_request",
          message: "Request body is too large",
        } satisfies ResearchError,
      },
      400,
    ),
});

/**
 * Other projects for `#` mentions (`/projects/:id/cross-project/*`): the list, a project's parts and manifest, the
 * import into the open project and its cancel. Speaks the `@hyperframes/agent-protocol` cross-project contract;
 * errors are `{ error: ResearchError }` (`unknown_project` → 404).
 */
export function registerCrossProjectRoutes(
  api: Hono,
  adapter: Pick<StudioApiAdapter, "resolveProject" | "externalProjects">,
): CrossProjectService {
  const service = new CrossProjectService({ adapter });

  /** Resolves the open project, then answers; a refusal is the wire error with its status. */
  const inProject =
    (action: (project: ResolvedProject, c: Context) => Promise<object> | object) =>
    async (c: Context) => {
      const project = await adapter.resolveProject(c.req.param("id") ?? "");
      if (!project) return c.json({ error: "not found" }, 404);
      try {
        return c.json(await action(project, c));
      } catch (error) {
        if (!isResearchFailure(error)) throw error;
        return c.json({ error: error.error }, researchStatus(error.error));
      }
    };

  const key = (c: Context): string => c.req.param("key") ?? "";

  api.get(
    "/projects/:id/cross-project/projects",
    inProject((project) => service.list(project)),
  );

  api.get(
    "/projects/:id/cross-project/projects/:key/summary",
    inProject((project, c) => service.summary(project, key(c))),
  );

  api.get(
    "/projects/:id/cross-project/projects/:key/manifest",
    inProject((project, c) => {
      const raw = c.req.query("parts");
      const parts = raw === undefined ? ["all" as const] : parseManifestParts(raw);
      if (!parts) {
        throw new ResearchFailure(
          "invalid_request",
          "parts must name known parts, comma-separated",
        );
      }
      return service.manifest(project, key(c), parts);
    }),
  );

  api.post(
    "/projects/:id/cross-project/import",
    tooLarge,
    inProject(async (project, c) => {
      const parsed = parseImportFromProjectRequest(await c.req.json().catch(() => undefined));
      if (!parsed.ok) throw new ResearchFailure("invalid_request", parsed.message);
      const { requestId, turnId, agent, model } = parsed.value;
      // These end up in the registry and in the provenance ledger: same bounds as the research import's.
      if (requestId !== undefined) parseRequestId(requestId);
      if (turnId !== undefined) parseTurnId(turnId);
      if ((agent?.length ?? 0) > MAX_LABEL_CHARS || (model?.length ?? 0) > MAX_LABEL_CHARS) {
        throw new ResearchFailure("invalid_request", "agent and model are too long");
      }
      return service.import(project, parsed.value, c.req.raw.signal);
    }),
  );

  // A cancel answers with a guarantee about writes, as the research import's does.
  api.post(
    "/projects/:id/cross-project/requests/:requestId/cancel",
    inProject((project, c) => {
      const requestId = parseRequestId(c.req.param("requestId"));
      return { requestId, state: service.cancel(project, requestId) };
    }),
  );

  return service;
}
