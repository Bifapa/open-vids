import type { Context } from "hono";
import { createHash, timingSafeEqual } from "node:crypto";
import { realpath, stat } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { Hono } from "hono";
import type {
  AgentErrorCode,
  AgentModelCatalog,
  ChatEvent,
  ProjectEvent,
} from "@hyperframes/agent-protocol";
import {
  AGENT_HEADERS,
  AGENT_PROTOCOL_VERSION,
  AGENT_RUNTIME_PREFIX,
  SSE_EVENTS,
  encodeSseMessage,
  parseCreateChat,
  parseRevertTurn,
  parseSetJevApiKey,
  parseStartTurn,
  parseSteerTurn,
  parseUpdateAgentSettings,
  parseUpdateChat,
} from "@hyperframes/agent-protocol";
import type { AgentBackend } from "./backend.js";
import { resolveJev, testJev } from "./agents/setup.js";
import type { CheckpointHost, ProjectScope } from "./checkpointHost.js";
import { ChatService } from "./chats.js";
import type { AnalysisHost } from "./analysis/host.js";
import type { EditingHost } from "./editing/host.js";
import { RuntimeError, errorMessage } from "./errors.js";
import { defaultEnabledAgents, type AgentSettingsStore } from "./settings.js";
import { FileChatStore } from "./store/index.js";
import { TurnRunner, type TurnRunnerOptions } from "./turns.js";

export interface RuntimeAppOptions {
  backend: AgentBackend;
  checkpoints: CheckpointHost;
  /** Opens the editing host (timeline editing, inspection, rendering) of the project a request is scoped to. */
  editing: (scope: ProjectScope) => EditingHost;
  /** Opens the analysis host (long-form transcript, speakers, shots, take issues, cut plans) of a request's project. */
  analysis: (scope: ProjectScope) => AnalysisHost;
  /** Global (per-user) agent settings shared by every project. */
  settings: AgentSettingsStore;
  token: string;
  now?: () => number;
  ids?: () => string;
  sessionIdleMs?: number;
}

interface ProjectRuntime {
  scope: ProjectScope;
  store: FileChatStore;
  chats: ChatService;
  turns: TurnRunner;
}

interface RuntimeEnvironment {
  Variables: { project: ProjectRuntime };
}

export type RuntimeApp = Hono<RuntimeEnvironment> & { dispose: () => Promise<void> };

const LOOPBACK_HOSTS: Record<string, true> = { localhost: true, "::1": true, "[::1]": true };

/** Creates the private, bearer-authenticated HTTP surface served by the Bun sidecar. */
export function createRuntimeApp(options: RuntimeAppOptions): RuntimeApp {
  if (!options.token) throw new Error("A runtime bearer token is required");
  const app = new Hono<RuntimeEnvironment>();
  const projects = new Map<string, Promise<ProjectRuntime>>();
  const now = options.now ?? Date.now;
  const ids = options.ids;
  const turnOptions: TurnRunnerOptions = {
    editing: options.editing,
    analysis: options.analysis,
    now,
    ...(ids && { ids }),
    ...(options.sessionIdleMs !== undefined && { sessionIdleMs: options.sessionIdleMs }),
  };

  app.use("*", async (context, next) => {
    if (!authorized(context.req.header(AGENT_HEADERS.token), options.token)) {
      return sendError(
        context,
        new RuntimeError("unauthorized", "A valid runtime bearer token is required", 401),
      );
    }
    if (context.req.path === `${AGENT_RUNTIME_PREFIX}/health`) return next();
    try {
      const scope = await resolveScope(context.req.raw.headers);
      const project = await getProjectRuntime(scope, projects, options, turnOptions, now, ids);
      context.set("project", project);
      return next();
    } catch (error) {
      return sendError(context, error);
    }
  });

  app.onError((error, context) => sendError(context, error));

  app.get(`${AGENT_RUNTIME_PREFIX}/health`, (context) =>
    context.json({
      ok: true,
      protocolVersion: AGENT_PROTOCOL_VERSION,
      backend: options.backend.name,
    }),
  );

  app.get(`${AGENT_RUNTIME_PREFIX}/models`, async (context) =>
    context.json(await options.backend.listModels()),
  );

  app.get(`${AGENT_RUNTIME_PREFIX}/providers`, async (context) =>
    context.json({ providers: await options.backend.listProviders() }),
  );

  app.get(`${AGENT_RUNTIME_PREFIX}/providers/:provider/models`, async (context) =>
    context.json({
      models: await options.backend.listProviderModels(context.req.param("provider")),
    }),
  );

  app.get(`${AGENT_RUNTIME_PREFIX}/settings`, async (context) =>
    context.json(await options.settings.get()),
  );

  app.patch(`${AGENT_RUNTIME_PREFIX}/settings`, async (context) => {
    const parsed = parseUpdateAgentSettings(await readBody(context));
    if (!parsed.ok) throw new RuntimeError("invalid_request", parsed.message, 400);
    return context.json(await options.settings.update(parsed.value));
  });

  app.post(`${AGENT_RUNTIME_PREFIX}/settings/jev/api-key`, async (context) => {
    const parsed = parseSetJevApiKey(await readBody(context));
    if (!parsed.ok) throw new RuntimeError("invalid_request", parsed.message, 400);
    return context.json(await options.settings.setJevApiKey(parsed.value.apiKey));
  });

  app.post(`${AGENT_RUNTIME_PREFIX}/settings/jev/test`, async (context) => {
    const settings = await options.settings.get();
    let catalog: AgentModelCatalog = { models: [], defaultModel: null, defaultThinking: null };
    try {
      catalog = await options.backend.listModels();
    } catch {
      // Without a catalog only API-key mode can be tested; resolveJev reports the rest.
    }
    const jev = resolveJev(settings, await options.settings.jevApiKey(), catalog);
    return context.json(
      await testJev(options.backend, context.get("project").scope.projectDir, jev, now),
    );
  });

  app.get(`${AGENT_RUNTIME_PREFIX}/chats`, (context) => {
    const { chats, turns } = context.get("project");
    return context.json({ chats: chats.list(), activeTurn: turns.activeTurn });
  });

  app.post(`${AGENT_RUNTIME_PREFIX}/chats`, async (context) => {
    const parsed = parseCreateChat(await readBody(context));
    if (!parsed.ok) throw new RuntimeError("invalid_request", parsed.message, 400);
    const defaults = defaultEnabledAgents(await options.settings.get());
    const chat = await context.get("project").chats.create(parsed.value, defaults);
    return context.json(chat, 201);
  });

  app.get(`${AGENT_RUNTIME_PREFIX}/chats/:chatId`, (context) => {
    const state = context.get("project").chats.get(context.req.param("chatId"));
    if (!state) throw new RuntimeError("chat_not_found", "Chat was not found", 404);
    return context.json(state);
  });

  app.patch(`${AGENT_RUNTIME_PREFIX}/chats/:chatId`, async (context) => {
    const project = context.get("project");
    const chatId = context.req.param("chatId");
    const parsed = parseUpdateChat(await readBody(context));
    if (!parsed.ok) throw new RuntimeError("invalid_request", parsed.message, 400);
    if (project.turns.activeTurn?.chatId === chatId)
      throw new RuntimeError("chat_busy", "This chat has a running turn", 409);
    const chat = await project.chats.update(chatId, parsed.value);
    if (!chat) throw new RuntimeError("chat_not_found", "Chat was not found", 404);
    return context.json(chat);
  });

  app.get(`${AGENT_RUNTIME_PREFIX}/chats/:chatId/events`, (context) => {
    const project = context.get("project");
    const chatId = context.req.param("chatId");
    if (!project.chats.get(chatId))
      throw new RuntimeError("chat_not_found", "Chat was not found", 404);
    const queryAfter = context.req.query("after");
    const rawAfter = queryAfter || context.req.header("Last-Event-ID");
    const after = rawAfter === undefined || rawAfter === "" ? 0 : parseSequence(rawAfter);
    const encoder = new TextEncoder();
    let controller: ReadableStreamDefaultController<Uint8Array> | null = null;
    let canceled = false;
    let keepalive: NodeJS.Timeout | undefined;
    let unsubscribe: () => void = () => {};
    const enqueue = (frame: string) => {
      if (canceled || !controller) return;
      try {
        controller.enqueue(encoder.encode(frame));
      } catch {
        canceled = true;
        unsubscribe();
        clearInterval(keepalive);
        keepalive = undefined;
      }
    };
    const subscription = project.chats.subscribeChat(chatId, after, (event) =>
      enqueue(chatFrame(event)),
    );
    unsubscribe = subscription.unsubscribe;
    const stream = new ReadableStream<Uint8Array>({
      start(streamController) {
        controller = streamController;
        for (const event of subscription.replay) enqueue(chatFrame(event));
        keepalive = setInterval(() => enqueue(": keepalive\n\n"), 15_000);
      },
      cancel() {
        canceled = true;
        unsubscribe();
        clearInterval(keepalive);
        keepalive = undefined;
      },
    });
    return new Response(stream, { headers: sseHeaders() });
  });

  app.get(`${AGENT_RUNTIME_PREFIX}/events`, (context) => {
    const project = context.get("project");
    const encoder = new TextEncoder();
    let controller: ReadableStreamDefaultController<Uint8Array> | null = null;
    let canceled = false;
    let keepalive: NodeJS.Timeout | undefined;
    let unsubscribe: () => void = () => {};
    const close = () => {
      canceled = true;
      unsubscribe();
      clearInterval(keepalive);
      keepalive = undefined;
    };
    unsubscribe = project.chats.subscribeProject((event) => {
      if (canceled || !controller) return;
      try {
        controller.enqueue(encoder.encode(projectFrame(event)));
      } catch {
        close();
      }
    });
    const stream = new ReadableStream<Uint8Array>({
      start(streamController) {
        controller = streamController;
        keepalive = setInterval(() => {
          if (canceled || !controller) return;
          try {
            controller.enqueue(encoder.encode(": keepalive\n\n"));
          } catch {
            close();
          }
        }, 15_000);
      },
      cancel: close,
    });
    return new Response(stream, { headers: sseHeaders() });
  });

  app.post(`${AGENT_RUNTIME_PREFIX}/chats/:chatId/turns`, async (context) => {
    const parsed = parseStartTurn(await readBody(context));
    if (!parsed.ok) throw new RuntimeError("invalid_request", parsed.message, 400);
    const turn = await context
      .get("project")
      .turns.start(context.req.param("chatId"), parsed.value);
    return context.json({ turn }, 202);
  });

  app.post(`${AGENT_RUNTIME_PREFIX}/chats/:chatId/turns/:turnId/steer`, async (context) => {
    const parsed = parseSteerTurn(await readBody(context));
    if (!parsed.ok) throw new RuntimeError("invalid_request", parsed.message, 400);
    const messageId = await context
      .get("project")
      .turns.steer(context.req.param("chatId"), context.req.param("turnId"), parsed.value);
    return context.json({ messageId }, 202);
  });

  app.post(`${AGENT_RUNTIME_PREFIX}/chats/:chatId/turns/:turnId/abort`, (context) => {
    context.get("project").turns.abort(context.req.param("chatId"), context.req.param("turnId"));
    return context.json({}, 202);
  });

  app.post(`${AGENT_RUNTIME_PREFIX}/chats/:chatId/turns/:turnId/revert`, async (context) => {
    const parsed = parseRevertTurn(await readBody(context));
    if (!parsed.ok) throw new RuntimeError("invalid_request", parsed.message, 400);
    const response = await context
      .get("project")
      .turns.revert(context.req.param("chatId"), context.req.param("turnId"), parsed.value.mode);
    return context.json(response);
  });

  return Object.assign(app, {
    dispose: async () => {
      const runtimes = await Promise.allSettled([...projects.values()]);
      await Promise.all(
        runtimes.flatMap((result) =>
          result.status === "fulfilled" ? [result.value.turns.dispose()] : [],
        ),
      );
      await options.backend.dispose();
      projects.clear();
    },
  });
}

async function getProjectRuntime(
  scope: ProjectScope,
  projects: Map<string, Promise<ProjectRuntime>>,
  options: RuntimeAppOptions,
  turnOptions: TurnRunnerOptions,
  now: () => number,
  ids: (() => string) | undefined,
): Promise<ProjectRuntime> {
  let project = projects.get(scope.projectDir);
  if (!project) {
    project = (async () => {
      const store = new FileChatStore(scope.projectDir);
      const chats = await ChatService.open(scope, store, { now, ...(ids && { ids }) });
      const turns = new TurnRunner(
        chats,
        options.backend,
        options.checkpoints,
        store,
        options.settings,
        turnOptions,
      );
      await turns.recoverCheckpoints();
      return { scope, store, chats, turns };
    })();
    projects.set(scope.projectDir, project);
  }
  let runtime: ProjectRuntime;
  try {
    runtime = await project;
  } catch (error) {
    if (projects.get(scope.projectDir) === project) projects.delete(scope.projectDir);
    throw error;
  }
  if (runtime.scope.projectId !== scope.projectId) {
    throw new RuntimeError(
      "invalid_request",
      "Project id does not match the selected project directory",
      400,
    );
  }
  return runtime;
}

async function resolveScope(headers: Headers): Promise<ProjectScope> {
  const projectId = headers.get(AGENT_HEADERS.projectId)?.trim();
  const projectDir = headers.get(AGENT_HEADERS.projectDir);
  const studioOrigin = headers.get(AGENT_HEADERS.studioOrigin);
  if (!projectId || !projectDir || !studioOrigin)
    throw new RuntimeError("invalid_request", "Project scope headers are required", 400);
  if (!isAbsolute(projectDir))
    throw new RuntimeError("invalid_request", "Project directory must be absolute", 400);
  let canonicalDir: string;
  try {
    canonicalDir = await realpath(projectDir);
    const info = await stat(canonicalDir);
    if (!info.isDirectory()) throw new Error("not a directory");
  } catch {
    throw new RuntimeError(
      "invalid_request",
      "Project directory must exist and be a directory",
      400,
    );
  }
  let parsedOrigin: URL;
  try {
    parsedOrigin = new URL(studioOrigin);
  } catch {
    throw new RuntimeError(
      "invalid_request",
      "Studio origin must be an http(s) loopback origin",
      400,
    );
  }
  const hostname = parsedOrigin.hostname.toLowerCase();
  if (
    (parsedOrigin.protocol !== "http:" && parsedOrigin.protocol !== "https:") ||
    (!Object.hasOwn(LOOPBACK_HOSTS, hostname) && !isIpv4Loopback(hostname)) ||
    parsedOrigin.username ||
    parsedOrigin.password ||
    parsedOrigin.pathname !== "/" ||
    parsedOrigin.search ||
    parsedOrigin.hash ||
    (studioOrigin !== parsedOrigin.origin && studioOrigin !== `${parsedOrigin.origin}/`)
  ) {
    throw new RuntimeError(
      "invalid_request",
      "Studio origin must be an http(s) loopback origin",
      400,
    );
  }
  return { projectId, projectDir: canonicalDir, studioOrigin: parsedOrigin.origin };
}

function isIpv4Loopback(hostname: string): boolean {
  const parts = hostname.split(".");
  if (parts.length !== 4 || parts[0] !== "127") return false;
  return parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255);
}

function authorized(header: string | undefined, token: string): boolean {
  const candidate = header?.startsWith("Bearer ") ? header.slice(7) : "";
  const expectedHash = createHash("sha256").update(token).digest();
  const candidateHash = createHash("sha256").update(candidate).digest();
  return (
    timingSafeEqual(expectedHash, candidateHash) &&
    candidate.length > 0 &&
    header?.startsWith("Bearer ") === true
  );
}

function parseSequence(value: string): number {
  if (!/^(0|[1-9]\d*)$/.test(value))
    throw new RuntimeError("invalid_request", "Event sequence must be a non-negative integer", 400);
  const result = Number(value);
  if (!Number.isSafeInteger(result))
    throw new RuntimeError("invalid_request", "Event sequence is out of range", 400);
  return result;
}

async function readBody(context: Context<RuntimeEnvironment>): Promise<unknown> {
  let body: string;
  try {
    body = await context.req.raw.text();
  } catch {
    throw new RuntimeError("invalid_request", "Request body must be valid JSON", 400);
  }
  if (!body.trim()) return undefined;
  try {
    const parsed: unknown = JSON.parse(body);
    return parsed;
  } catch {
    throw new RuntimeError("invalid_request", "Request body must be valid JSON", 400);
  }
}

function chatFrame(event: ChatEvent): string {
  return encodeSseMessage({
    id: String(event.seq),
    event: SSE_EVENTS.chat,
    data: JSON.stringify(event),
  });
}

function projectFrame(event: ProjectEvent): string {
  return encodeSseMessage({ event: SSE_EVENTS.project, data: JSON.stringify(event) });
}

function sseHeaders(): HeadersInit {
  return {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
  };
}

function sendError(context: Context<RuntimeEnvironment>, error: unknown): Response {
  const runtimeError =
    error instanceof RuntimeError
      ? error
      : new RuntimeError("internal", errorMessage(error, "Internal runtime error"), 500);
  const errorBody = {
    error: {
      code: runtimeError.code satisfies AgentErrorCode,
      message: runtimeError.message,
      ...(runtimeError.details && { details: runtimeError.details }),
    },
  };
  if (runtimeError.status === 400) return context.json(errorBody, 400);
  if (runtimeError.status === 401) return context.json(errorBody, 401);
  if (runtimeError.status === 404) return context.json(errorBody, 404);
  if (runtimeError.status === 409) return context.json(errorBody, 409);
  if (runtimeError.status === 502) return context.json(errorBody, 502);
  if (runtimeError.status === 503) return context.json(errorBody, 503);
  return context.json(errorBody, 500);
}
