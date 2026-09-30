import type { Context, Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { ResearchError } from "@hyperframes/agent-protocol";
import { isEditFailure } from "../editing/errors.js";
import { ResearchFailure, isResearchFailure, researchStatus } from "../research/errors.js";
import {
  parseAddSource,
  parseImportRequest,
  parseInspectRequest,
  parsePolicyUpdate,
  parseRequestId,
  parseResolveRequest,
  parseSearchRequest,
  parseUpdateSource,
} from "../research/requests.js";
import { ResearchService, type ResearchServiceOptions } from "../research/service.js";
import type { StoryService } from "../story/service.js";
import type { ResolvedProject, StudioApiAdapter } from "../types.js";

const MAX_BODY_BYTES = 256 * 1024;

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
 * Research, sources and licensing: the global Asset Search policy (`/research/*`), and per project the search, page
 * inspection, import, Missing Asset resolution and the Sources/Licenses view (`/projects/:id/research/*`). Speaks the
 * `@hyperframes/agent-protocol` research contract; errors are `{ error: ResearchError }`.
 */
export function registerResearchRoutes(
  api: Hono,
  adapter: StudioApiAdapter,
  story: StoryService,
  options: Omit<ResearchServiceOptions, "story"> = {},
): ResearchService {
  const service = new ResearchService({ ...options, story });

  const answer = async (
    c: Context,
    action: () => Promise<Response | object> | Response | object,
  ) => {
    try {
      const result = await action();
      return result instanceof Response ? result : c.json(result);
    } catch (error) {
      if (isResearchFailure(error))
        return c.json({ error: error.error }, researchStatus(error.error));
      if (isEditFailure(error)) {
        const failure = new ResearchFailure("unknown_asset", error.error.message);
        return c.json({ error: failure.error }, researchStatus(failure.error));
      }
      throw error;
    }
  };

  const body = async (c: Context): Promise<unknown> => c.req.json().catch(() => undefined);

  /** Resolves the project, then answers like {@link answer}. */
  const inProject =
    (action: (project: ResolvedProject, c: Context) => Promise<Response | object>) =>
    async (c: Context) => {
      const project = await adapter.resolveProject(c.req.param("id") ?? "");
      if (!project) return c.json({ error: "not found" }, 404);
      return answer(c, () => action(project, c));
    };

  // ── Global policy ─────────────────────────────────────────────────────────

  api.get("/research/policy", (c) => answer(c, () => service.policy()));

  api.put("/research/policy", tooLarge, async (c) =>
    answer(c, async () => service.setMode(parsePolicyUpdate(await body(c)).mode)),
  );

  api.post("/research/sources/restore", (c) => answer(c, () => service.restoreSources()));

  api.post("/research/sources", tooLarge, async (c) =>
    answer(c, async () => service.addSource(parseAddSource(await body(c)))),
  );

  api.patch("/research/sources/:id", tooLarge, async (c) =>
    answer(c, async () =>
      service.updateSource(c.req.param("id") ?? "", parseUpdateSource(await body(c))),
    ),
  );

  api.delete("/research/sources/:id", (c) =>
    answer(c, () => service.removeSource(c.req.param("id") ?? "")),
  );

  // ── Project ───────────────────────────────────────────────────────────────

  api.post(
    "/projects/:id/research/search",
    tooLarge,
    inProject(async (project, c) =>
      service.search(project, parseSearchRequest(await body(c)), c.req.raw.signal),
    ),
  );

  api.post(
    "/projects/:id/research/inspect",
    tooLarge,
    inProject(async (project, c) =>
      service.inspect(project, parseInspectRequest(await body(c)), c.req.raw.signal),
    ),
  );

  api.post(
    "/projects/:id/research/import",
    tooLarge,
    inProject(async (project, c) =>
      service.import(project, parseImportRequest(await body(c)), c.req.raw.signal),
    ),
  );

  api.post(
    "/projects/:id/research/resolve",
    tooLarge,
    inProject(async (project, c) =>
      service.resolve(project, parseResolveRequest(await body(c)), c.req.raw.signal),
    ),
  );

  // A cancel answers with a guarantee about writes, see `CancelResearchRequestResult`.
  api.post(
    "/projects/:id/research/requests/:requestId/cancel",
    inProject(async (project, c) => {
      const requestId = parseRequestId(c.req.param("requestId"));
      return { requestId, state: service.cancel(project, requestId) };
    }),
  );

  api.get(
    "/projects/:id/research/sources",
    inProject((project) => service.sources(project)),
  );

  api.get(
    "/projects/:id/research/export-check",
    inProject((project, c) => service.exportCheck(project, c.req.query("composition"))),
  );

  return service;
}
