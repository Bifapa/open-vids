import type { Context, Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import {
  isRecord,
  parseSaveVoiceScriptRequest,
  parseVoiceCheckRequest,
  parseVoiceSynthesisRequest,
  type Parsed,
  type SelectVoiceTakeRequest,
  type SetProjectVoiceRequest,
} from "@hyperframes/agent-protocol";
import { isVoiceFailure, voiceErrorBody, voiceStatus, VoiceFailure } from "../voice/errors.js";
import type { VoiceEngine } from "../voice/engine.js";
import { ProjectVoiceService } from "../voice/project/service.js";
import type { TranscribeMedia } from "../voice/project/synthesize.js";
import type { ResolvedProject, StudioApiAdapter } from "../types.js";

/** 500 lines of 10 000 characters is the contract's ceiling for one script. */
const MAX_BODY_BYTES = 6 * 1024 * 1024;

const tooLarge = bodyLimit({
  maxSize: MAX_BODY_BYTES,
  onError: (c) =>
    c.json(voiceErrorBody(new VoiceFailure("invalid_request", "Request body is too large")), 400),
});

export interface ProjectVoiceRoutesOptions {
  /** Tests inject a service built on a fake engine. */
  service?: ProjectVoiceService;
  transcribe?: TranscribeMedia;
}

/** Unwraps a parser's answer: a refused body is a 400 `invalid_request`. */
function accepted<T>(parsed: Parsed<T>): T {
  if (!parsed.ok) throw new VoiceFailure("invalid_request", parsed.message);
  return parsed.value;
}

function parseSetVoice(body: unknown): SetProjectVoiceRequest {
  if (!isRecord(body) || (body.presetId !== null && typeof body.presetId !== "string")) {
    throw new VoiceFailure("invalid_request", "presetId must be a preset id or null");
  }
  return { presetId: body.presetId === "" ? null : body.presetId };
}

function parseSelectTake(body: unknown): SelectVoiceTakeRequest {
  if (
    !isRecord(body) ||
    typeof body.takeId !== "string" ||
    body.takeId.length === 0 ||
    body.takeId.length > 128
  ) {
    throw new VoiceFailure("invalid_request", "takeId is required");
  }
  return { takeId: body.takeId };
}

function requestIdOf(value: string | undefined): string {
  if (value === undefined || !/^[A-Za-z0-9_-]{1,128}$/.test(value)) {
    throw new VoiceFailure("invalid_request", "requestId must be 1–128 letters, digits, - or _");
  }
  return value;
}

/**
 * A project's voiceover (`/projects/:id/voice/*`): the script and its takes, the dialect check with the estimate,
 * generation through the engine, and picking a take. Errors are `{ error: VoiceErrorBody["error"] }`.
 */
export function registerProjectVoiceRoutes(
  api: Hono,
  adapter: StudioApiAdapter,
  engine: VoiceEngine,
  options: ProjectVoiceRoutesOptions = {},
): ProjectVoiceService {
  const service =
    options.service ??
    new ProjectVoiceService({
      engine,
      // The adapter is completed after the routes are registered, so its capability is looked up per call.
      transcribe:
        options.transcribe ??
        (async (opts) =>
          adapter.transcribeMedia
            ? adapter.transcribeMedia(opts)
            : { unavailable: "this Studio has no speech recognizer" }),
    });

  const answer = async (
    c: Context,
    action: () => Promise<Response | object> | Response | object,
  ) => {
    try {
      const result = await action();
      return result instanceof Response ? result : c.json(result);
    } catch (error) {
      if (!isVoiceFailure(error)) throw error;
      const retryAfter = error.params?.retryAfterSeconds;
      if (error.code === "rate_limited" && typeof retryAfter === "number") {
        c.header("Retry-After", String(Math.max(1, Math.ceil(retryAfter))));
      }
      return c.json(voiceErrorBody(error), voiceStatus(error.code));
    }
  };

  const body = async (c: Context): Promise<unknown> => c.req.json().catch(() => undefined);

  const inProject =
    (
      action: (
        project: ResolvedProject,
        c: Context,
      ) => Promise<Response | object> | Response | object,
    ) =>
    async (c: Context) => {
      const project = await adapter.resolveProject(c.req.param("id") ?? "");
      if (!project) {
        return c.json(voiceErrorBody(new VoiceFailure("not_found", "Project not found")), 404);
      }
      return answer(c, () => action(project, c));
    };

  api.get(
    "/projects/:id/voice/script",
    inProject((project) => service.script(project)),
  );

  api.put(
    "/projects/:id/voice/script",
    tooLarge,
    inProject(async (project, c) =>
      service.saveScript(project, accepted(parseSaveVoiceScriptRequest(await body(c)))),
    ),
  );

  api.put(
    "/projects/:id/voice/voice",
    tooLarge,
    inProject(async (project, c) => service.setVoice(project, parseSetVoice(await body(c)))),
  );

  api.post(
    "/projects/:id/voice/check",
    tooLarge,
    inProject(async (project, c) =>
      service.check(project, accepted(parseVoiceCheckRequest(await body(c)))),
    ),
  );

  // Blocks until every line is done; the client's disconnect cancels the request like the cancel route does.
  api.post(
    "/projects/:id/voice/synthesize",
    tooLarge,
    inProject(async (project, c) =>
      service.synthesize(
        project,
        accepted(parseVoiceSynthesisRequest(await body(c))),
        c.req.raw.signal,
      ),
    ),
  );

  api.get(
    "/projects/:id/voice/requests/:requestId",
    inProject((project, c) => service.progress(project, requestIdOf(c.req.param("requestId")))),
  );

  // A cancel answers with a guarantee about writes, like Research's: `cancelled`, `committed` or `finished`.
  api.post(
    "/projects/:id/voice/requests/:requestId/cancel",
    inProject((project, c) => {
      const requestId = requestIdOf(c.req.param("requestId"));
      return { requestId, state: service.cancel(project, requestId) };
    }),
  );

  api.put(
    "/projects/:id/voice/lines/:lineId/take",
    tooLarge,
    inProject(async (project, c) =>
      service.selectTake(project, c.req.param("lineId") ?? "", parseSelectTake(await body(c))),
    ),
  );

  return service;
}
