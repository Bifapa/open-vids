import type { Context, Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import {
  parseAnalyzeRequest,
  parseCutPlanRequest,
  parseFramesRequest,
  parseMarkCutAppliedRequest,
  parseSaveSegmentsRequest,
  parseSaveVisionNotesRequest,
  type AnalysisError,
  type ParsedAnalysis,
} from "@hyperframes/agent-protocol";
import { AnalysisFailure, analysisStatus, isAnalysisFailure } from "../analysis/errors.js";
import { AnalysisService, type AnalysisServiceOptions } from "../analysis/service.js";
import type { ResolvedProject, StudioApiAdapter } from "../types.js";

const MAX_BODY_BYTES = 2 * 1024 * 1024;

const tooLarge = bodyLimit({
  maxSize: MAX_BODY_BYTES,
  onError: (c) =>
    c.json(
      {
        error: {
          code: "invalid_request",
          message: "Request body is too large",
        } satisfies AnalysisError,
      },
      400,
    ),
});

function requiredQuery(c: Context, name: string): string {
  const value = c.req.query(name);
  if (value === undefined || value.trim() === "") {
    throw new AnalysisFailure("invalid_request", `Query parameter "${name}" is required`);
  }
  return value;
}

function optionalSeconds(c: Context, name: string): number | undefined {
  const raw = c.req.query(name);
  if (raw === undefined || raw === "") return undefined;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) {
    throw new AnalysisFailure("invalid_request", `"${name}" must be a number of seconds ≥ 0`);
  }
  return value;
}

function parsed<T>(result: ParsedAnalysis<T>): T {
  if (!result.ok) throw new AnalysisFailure(result.error.code, result.error.message);
  return result.value;
}

/**
 * Long-form analysis: per-source transcript, speakers, silence, shots, take issues and segments cached under the
 * project's `.hyperframes/analysis/`, the jobs that produce them, agent-written segments and vision notes, frame grabs
 * for Vision and cut plans. Speaks the `@hyperframes/agent-protocol` analysis contract; errors are `{ error: AnalysisError }`.
 */
export function registerAnalysisRoutes(
  api: Hono,
  adapter: StudioApiAdapter,
  options: AnalysisServiceOptions = {},
): AnalysisService {
  const service = new AnalysisService(adapter, options);

  /** Resolves the project, runs the action and turns an analysis refusal into its HTTP answer. */
  const route =
    <T>(action: (project: ResolvedProject, c: Context) => Promise<T>) =>
    async (c: Context) => {
      const project = await adapter.resolveProject(c.req.param("id") ?? "");
      if (!project) return c.json({ error: "not found" }, 404);
      try {
        return c.json(await action(project, c));
      } catch (error) {
        if (isAnalysisFailure(error)) {
          return new Response(JSON.stringify({ error: error.error }), {
            status: analysisStatus(error.error),
            headers: { "content-type": "application/json" },
          });
        }
        throw error;
      }
    };

  const body = async (c: Context): Promise<unknown> => c.req.json().catch(() => undefined);

  api.get(
    "/projects/:id/analysis/sources",
    route(async (project) => ({ sources: await service.listSources(project) })),
  );

  api.post(
    "/projects/:id/analysis/jobs",
    tooLarge,
    route(async (project, c) =>
      service.startJob(project, parsed(parseAnalyzeRequest(await body(c)))),
    ),
  );

  api.get(
    "/projects/:id/analysis/jobs/:jobId",
    route(async (project, c) => {
      const job = service.getJob(project, c.req.param("jobId") ?? "");
      if (!job)
        throw new AnalysisFailure(
          "unknown_source",
          "No such analysis job (finished jobs are kept for 10 minutes)",
        );
      return job;
    }),
  );

  api.post(
    "/projects/:id/analysis/jobs/:jobId/cancel",
    route(async (project, c) => {
      const job = await service.cancelJob(project, c.req.param("jobId") ?? "");
      if (!job)
        throw new AnalysisFailure(
          "unknown_source",
          "No such analysis job (finished jobs are kept for 10 minutes)",
        );
      return job;
    }),
  );

  api.get(
    "/projects/:id/analysis/overview",
    route(async (project, c) => service.overview(project, requiredQuery(c, "source"))),
  );

  api.get(
    "/projects/:id/analysis/transcript",
    route(async (project, c) =>
      service.transcript(project, requiredQuery(c, "source"), {
        from: optionalSeconds(c, "from"),
        to: optionalSeconds(c, "to"),
        words: ["1", "true"].includes(c.req.query("words") ?? ""),
      }),
    ),
  );

  api.get(
    "/projects/:id/analysis/artifact",
    route(async (project, c) =>
      service.artifact(project, requiredQuery(c, "source"), requiredQuery(c, "stage")),
    ),
  );

  api.put(
    "/projects/:id/analysis/segments",
    tooLarge,
    route(async (project, c) =>
      service.saveSegments(project, parsed(parseSaveSegmentsRequest(await body(c)))),
    ),
  );

  api.post(
    "/projects/:id/analysis/vision",
    tooLarge,
    route(async (project, c) =>
      service.saveVisionNotes(project, parsed(parseSaveVisionNotesRequest(await body(c)))),
    ),
  );

  api.post(
    "/projects/:id/analysis/frames",
    tooLarge,
    route(async (project, c) =>
      service.frames(project, parsed(parseFramesRequest(await body(c))), c.req.raw.signal),
    ),
  );

  api.post(
    "/projects/:id/analysis/cuts",
    tooLarge,
    route(async (project, c) =>
      service.planCut(project, parsed(parseCutPlanRequest(await body(c)))),
    ),
  );

  api.get(
    "/projects/:id/analysis/cuts",
    route(async (project, c) => ({
      plans: await service.listCuts(project, c.req.query("source")),
    })),
  );

  api.get(
    "/projects/:id/analysis/cuts/:planId",
    route(async (project, c) => service.getCut(project, c.req.param("planId") ?? "")),
  );

  api.post(
    "/projects/:id/analysis/cuts/:planId/applied",
    tooLarge,
    route(async (project, c) =>
      service.markCutApplied(
        project,
        c.req.param("planId") ?? "",
        parsed(parseMarkCutAppliedRequest(await body(c))),
      ),
    ),
  );

  return service;
}
