import type { Context, Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import {
  parseQaCheckRequest,
  parseQaFinishRequest,
  parseQaFramesRequest,
  parseQaReportInput,
  type Parsed,
} from "@hyperframes/agent-protocol";
import type { MediaProber } from "../editing/mediaFacts.js";
import { QaFailure, asQaFailure, qaStatus } from "../qa/errors.js";
import { QaService, type QaAnalysis } from "../qa/service.js";
import type { ResolvedProject, StudioApiAdapter } from "../types.js";

const MAX_BODY_BYTES = 1024 * 1024;

const tooLarge = bodyLimit({
  maxSize: MAX_BODY_BYTES,
  onError: (c) =>
    c.json({ error: { code: "invalid_request", message: "Request body is too large" } }, 400),
});

function parsed<T>(result: Parsed<T>): T {
  if (!result.ok) throw new QaFailure("invalid_request", result.message);
  return result.value;
}

/**
 * Render QA: deterministic checks on a rendered file and its timeline, the frames Vision reviews, and the durable
 * reports of QA passes under the project's `.hyperframes/qa/`. Speaks the `@hyperframes/agent-protocol` QA contract;
 * errors are `{ error: QaError }`.
 *
 * Work that spawns processes (ffmpeg, the layout checker) gets the request's abort signal: the node server aborts
 * `c.req.raw.signal` when the client disconnects, which kills those processes.
 */
export function registerQaRoutes(
  api: Hono,
  adapter: StudioApiAdapter,
  analysis: QaAnalysis,
  options: { probe?: MediaProber; ffmpegPath?: string; now?: () => number } = {},
): QaService {
  const service = new QaService(adapter, analysis, options);

  /** Resolves the project, runs the action and turns a failure into its QA error answer. */
  const route =
    <T>(action: (project: ResolvedProject, c: Context) => Promise<T> | T) =>
    async (c: Context) => {
      const project = await adapter.resolveProject(c.req.param("id") ?? "");
      if (!project) {
        return c.json({ error: { code: "not_found", message: "No such project" } }, 404);
      }
      try {
        return c.json(await action(project, c));
      } catch (error) {
        const failure = asQaFailure(error);
        return new Response(JSON.stringify({ error: failure.error }), {
          status: qaStatus(failure.error),
          headers: { "content-type": "application/json" },
        });
      }
    };

  const body = async (c: Context): Promise<unknown> => c.req.json().catch(() => undefined);

  api.get(
    "/projects/:id/qa/state",
    route((project) => service.state(project)),
  );

  api.post(
    "/projects/:id/qa/check",
    tooLarge,
    route(async (project, c) =>
      service.check(project, parsed(parseQaCheckRequest(await body(c))), c.req.raw.signal),
    ),
  );

  api.post(
    "/projects/:id/qa/frames",
    tooLarge,
    route(async (project, c) =>
      service.frames(project, parsed(parseQaFramesRequest(await body(c))), c.req.raw.signal),
    ),
  );

  api.post(
    "/projects/:id/qa/reports",
    tooLarge,
    route(async (project, c) =>
      service.saveReport(project, parsed(parseQaReportInput(await body(c)))),
    ),
  );

  api.post(
    "/projects/:id/qa/sessions/:sessionId/finish",
    tooLarge,
    route(async (project, c) =>
      service.finishSession(
        project,
        c.req.param("sessionId") ?? "",
        parsed(parseQaFinishRequest(await body(c))),
      ),
    ),
  );

  api.get(
    "/projects/:id/qa/reports",
    route((project) => service.listReports(project)),
  );

  api.get(
    "/projects/:id/qa/reports/:reportId",
    route((project, c) => service.getReport(project, c.req.param("reportId") ?? "")),
  );

  return service;
}
