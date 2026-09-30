import type { Context, Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import {
  parseSaveStoryRequest,
  parseStoryBuildRequest,
  parseStoryEditRequest,
  parseStoryRebuildRequest,
  type ParsedStory,
  type StoryError,
} from "@hyperframes/agent-protocol";
import { isAnalysisFailure } from "../analysis/errors.js";
import type { AnalysisService } from "../analysis/service.js";
import type { MediaProber } from "../editing/mediaFacts.js";
import { isEditFailure } from "../editing/errors.js";
import { StoryFailure, isStoryFailure, storyStatus } from "../story/errors.js";
import { StoryService } from "../story/service.js";
import type { ResolvedProject, StudioApiAdapter } from "../types.js";

const MAX_BODY_BYTES = 4 * 1024 * 1024;

const tooLarge = bodyLimit({
  maxSize: MAX_BODY_BYTES,
  onError: (c) =>
    c.json(
      {
        error: {
          code: "invalid_request",
          message: "Request body is too large",
        } satisfies StoryError,
      },
      400,
    ),
});

function parsed<T>(result: ParsedStory<T>): T {
  if (!result.ok)
    throw new StoryFailure(result.error.code, result.error.message, result.error.opIndex);
  return result.value;
}

function seconds(c: Context, name: string): number {
  const raw = c.req.query(name);
  const value = raw === undefined || raw === "" ? Number.NaN : Number(raw);
  if (!Number.isFinite(value) || value < 0) {
    throw new StoryFailure(
      "invalid_request",
      `Query parameter "${name}" must be a number of seconds ≥ 0`,
    );
  }
  return value;
}

/**
 * Story Mode: the project's Story Graph (`.hyperframes/story/graph.json`) with its facts, the user's saves, the
 * agents' validated edits, Build Story, and preview frames for the cards. Speaks the `@hyperframes/agent-protocol`
 * story contract; errors are `{ error: StoryError }`.
 */
export function registerStoryRoutes(
  api: Hono,
  adapter: StudioApiAdapter,
  analysis: AnalysisService,
  options: { probe?: MediaProber } = {},
): StoryService {
  const service = new StoryService(adapter, analysis, options);

  /** Resolves the project, runs the action and turns a refusal into its HTTP answer. */
  const route =
    (action: (project: ResolvedProject, c: Context) => Promise<Response | object>) =>
    async (c: Context) => {
      const project = await adapter.resolveProject(c.req.param("id") ?? "");
      if (!project) return c.json({ error: "not found" }, 404);
      try {
        const result = await action(project, c);
        return result instanceof Response ? result : c.json(result);
      } catch (error) {
        if (isStoryFailure(error)) return c.json({ error: error.error }, storyStatus(error.error));
        if (isAnalysisFailure(error)) {
          const story: StoryError = {
            code: error.error.code === "unknown_source" ? "unknown_asset" : "invalid_request",
            message: error.error.message,
          };
          return c.json({ error: story }, storyStatus(story));
        }
        if (isEditFailure(error)) {
          const story: StoryError = { code: "invalid_request", message: error.error.message };
          return c.json({ error: story }, 400);
        }
        throw error;
      }
    };

  const body = async (c: Context): Promise<unknown> => c.req.json().catch(() => undefined);

  api.get(
    "/projects/:id/story",
    route((project) => service.view(project)),
  );

  api.put(
    "/projects/:id/story",
    tooLarge,
    route(async (project, c) =>
      service.save(project, parsed(parseSaveStoryRequest(await body(c)))),
    ),
  );

  api.post(
    "/projects/:id/story/edit",
    tooLarge,
    route(async (project, c) =>
      service.edit(project, parsed(parseStoryEditRequest(await body(c)))),
    ),
  );

  api.post(
    "/projects/:id/story/build",
    tooLarge,
    route(async (project, c) =>
      service.build(project, parsed(parseStoryBuildRequest(await body(c)))),
    ),
  );

  api.post(
    "/projects/:id/story/rebuild",
    tooLarge,
    route(async (project, c) =>
      service.rebuild(project, parsed(parseStoryRebuildRequest(await body(c)))),
    ),
  );

  api.get(
    "/projects/:id/story/frame",
    route(async (project, c) => {
      const source = c.req.query("source");
      if (source === undefined || source.trim() === "") {
        throw new StoryFailure("invalid_request", 'Query parameter "source" is required');
      }
      const time = seconds(c, "t");
      const rawWidth = c.req.query("w");
      const width = rawWidth === undefined || rawWidth === "" ? undefined : Number(rawWidth);
      if (width !== undefined && (!Number.isFinite(width) || width <= 0)) {
        throw new StoryFailure("invalid_request", 'Query parameter "w" must be a width in pixels');
      }
      const jpeg = await service.frame(project, source, time, width, c.req.raw.signal);
      return new Response(new Uint8Array(jpeg), {
        headers: { "content-type": "image/jpeg", "cache-control": "private, max-age=3600" },
      });
    }),
  );

  return service;
}
