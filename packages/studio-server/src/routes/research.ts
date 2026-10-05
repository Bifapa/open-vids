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
  parseRecordWebsiteRequest,
  parseRequestId,
  parseResolveRequest,
  parseSearchRequest,
  parseSetApiKey,
  parseTurnId,
  parseUpdateSource,
  parseWebsiteFileRequest,
  parseWebsiteGrantRequest,
  parseWebsiteRequest,
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
  const service = new ResearchService({
    ...options,
    story,
    // The adapter is completed after the routes are registered, so its capability is looked up per request.
    inspectWebsite:
      options.inspectWebsite ??
      (async (opts) =>
        adapter.inspectWebsite
          ? adapter.inspectWebsite(opts)
          : {
              error: {
                code: "unsupported",
                message: "This Studio cannot render web pages (no browser capability)",
              },
            }),
    recordWebsite:
      options.recordWebsite ??
      (async (opts) =>
        adapter.recordWebsite
          ? adapter.recordWebsite(opts)
          : {
              error: {
                code: "unsupported",
                message: "This Studio cannot record web pages (no browser capability)",
              },
            }),
  });

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
    answer(c, async () => service.updatePolicy(parsePolicyUpdate(await body(c)))),
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

  api.put("/research/sources/:id/api-key", tooLarge, async (c) =>
    answer(c, async () =>
      service.setSourceApiKey(c.req.param("id") ?? "", parseSetApiKey(await body(c)).key),
    ),
  );

  api.delete("/research/sources/:id/api-key", (c) =>
    answer(c, () => service.removeSourceApiKey(c.req.param("id") ?? "")),
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

  api.post(
    "/projects/:id/research/website",
    tooLarge,
    inProject(async (project, c) =>
      service.website(project, parseWebsiteRequest(await body(c)), c.req.raw.signal),
    ),
  );

  api.post(
    "/projects/:id/research/website/file",
    tooLarge,
    inProject(async (project, c) =>
      service.websiteFile(project, parseWebsiteFileRequest(await body(c)), c.req.raw.signal),
    ),
  );

  api.post(
    "/projects/:id/research/website/record",
    tooLarge,
    inProject(async (project, c) =>
      service.websiteRecord(project, parseRecordWebsiteRequest(await body(c)), c.req.raw.signal),
    ),
  );

  // One-time Websites grants from the chat's permission card ("Allow once"); revoked at the turn's end.
  api.post(
    "/projects/:id/research/website/grants",
    tooLarge,
    inProject(async (project, c) =>
      service.websiteGrant(project, parseWebsiteGrantRequest(await body(c))),
    ),
  );

  api.delete(
    "/projects/:id/research/website/grants/:turnId",
    inProject(async (project, c) => {
      service.revokeWebsiteGrant(project, parseTurnId(c.req.param("turnId")));
      return { ok: true };
    }),
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
