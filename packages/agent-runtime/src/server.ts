import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import type { AgentModelCatalog } from "@hyperframes/agent-protocol";
import {
  AGENT_HEADERS,
  AGENT_PROTOCOL_VERSION,
  AGENT_RUNTIME_PREFIX,
  isProviderId,
  parseAnswerPermission,
  parseAnswerQuestion,
  parseAnswerStoryOffer,
  parseCancelRun,
  parseCreateChat,
  parseDeleteChat,
  parseUsageQuery,
  parseProjectTitleRequest,
  parseRevertTurn,
  parseSetJevApiKey,
  parseSetProviderApiKey,
  parseStartOAuthLogin,
  parseStartTurn,
  parseSteerTurn,
  parseSubmitOAuthLoginInput,
  parseUpdateAgentSettings,
  parseUpdateChat,
} from "@hyperframes/agent-protocol";
import type { AgentBackend } from "./backend.js";
import { resolveJev, testJev } from "./agents/setup.js";
import type { CheckpointHost, ProjectScope } from "./checkpointHost.js";
import { ChatService } from "./chats.js";
import type { AnalysisHost } from "./analysis/host.js";
import type { EditingHost } from "./editing/host.js";
import type { FramesHost } from "./editing/frames.js";
import type { StoryHost } from "./story/host.js";
import type { DesignHost } from "./design/host.js";
import type { ResearchHost } from "./research/host.js";
import type { CrossProjectHost } from "./crossProject/host.js";
import type { QaHost } from "./qa/host.js";
import { RuntimeError } from "./errors.js";
import {
  authorized,
  chatFrame,
  isGlobalRoute,
  loginParam,
  parseSequence,
  projectFrame,
  providerParam,
  readBody,
  resolveScope,
  sendError,
  sseHeaders,
} from "./serverHttp.js";
import { defaultEnabledAgents, type AgentSettingsStore } from "./settings.js";
import { FileChatStore, takeProjectOwnership } from "./store/index.js";
import { UsageJournal } from "./usage/journal.js";
import { usageEntriesOfTurn } from "./usage/entries.js";
import { buildUsageReport } from "./usage/report.js";
import { TurnRunner, type TurnRunnerOptions } from "./turns.js";

export interface RuntimeAppOptions {
  backend: AgentBackend;
  checkpoints: CheckpointHost;
  /** Opens the editing host (timeline editing, inspection, rendering) of the project a request is scoped to. */
  editing: (scope: ProjectScope) => EditingHost;
  /** Opens the analysis host (long-form transcript, speakers, shots, take issues, cut plans) of a request's project. */
  analysis: (scope: ProjectScope) => AnalysisHost;
  /** Opens the story host (the Story Graph, story edits, Build Story) of the project a request is scoped to. */
  story: (scope: ProjectScope) => StoryHost;
  /** Opens the research host (Asset Search policy, outside material, the project's sources) of a request's project. */
  research: (scope: ProjectScope) => ResearchHost;
  /** Opens the QA host (render checks, frames of a render, stored reports) of a request's project. */
  qa: (scope: ProjectScope) => QaHost;
  /** Opens the frames host (composition frames without a render) of a request's project. */
  frames?: (scope: ProjectScope) => FramesHost;
  /** Opens the cross-project host (other attached projects: manifests, copying files) of a request's project. */
  crossProject?: (scope: ProjectScope) => CrossProjectHost;
  /** Opens the design host (design-system library, the project's attached system and extraction) of a request's project. */
  design?: (scope: ProjectScope) => DesignHost;
  /** Global (per-user) agent settings shared by every project. */
  settings: AgentSettingsStore;
  token: string;
  now?: () => number;
  ids?: () => string;
  sessionIdleMs?: number;
  /** How long the Director's model may stay silent before its turn is stopped (default 10 minutes). */
  promptStallMs?: number;
}

interface ProjectRuntime {
  scope: ProjectScope;
  store: FileChatStore;
  chats: ChatService;
  usage: UsageJournal;
  turns: TurnRunner;
  /** Gives up this process's ownership of the project's chats. */
  release: () => void;
}

interface RuntimeEnvironment {
  Variables: { project: ProjectRuntime };
}

export type RuntimeApp = Hono<RuntimeEnvironment> & { dispose: () => Promise<void> };

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
    story: options.story,
    research: options.research,
    qa: options.qa,
    ...(options.frames && { frames: options.frames }),
    ...(options.crossProject && { crossProject: options.crossProject }),
    ...(options.design && { design: options.design }),
    now,
    ...(ids && { ids }),
    ...(options.sessionIdleMs !== undefined && { sessionIdleMs: options.sessionIdleMs }),
    ...(options.promptStallMs !== undefined && { promptStallMs: options.promptStallMs }),
  };

  app.use("*", async (context, next) => {
    if (!authorized(context.req.header(AGENT_HEADERS.token), options.token)) {
      return sendError(
        context,
        new RuntimeError("unauthorized", "A valid runtime bearer token is required", 401),
      );
    }
    if (isGlobalRoute(context.req.path)) return next();
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

  // The Start composer names a project before any project exists: one short, tool-less completion (Home falls back
  // to its own derivation on any failure). Global: token only.
  app.post(`${AGENT_RUNTIME_PREFIX}/project-title`, async (context) => {
    const parsed = parseProjectTitleRequest(await readBody(context));
    if (!parsed.ok) throw new RuntimeError("invalid_request", parsed.message, 400);
    return context.json({ title: await options.backend.generateProjectTitle(parsed.value) });
  });

  app.get(`${AGENT_RUNTIME_PREFIX}/providers`, async (context) =>
    context.json(await options.backend.listProviders()),
  );

  app.post(`${AGENT_RUNTIME_PREFIX}/providers/refresh`, async (context) =>
    context.json(await options.backend.refreshProviders()),
  );

  app.post(`${AGENT_RUNTIME_PREFIX}/providers/:provider/api-key`, async (context) => {
    const provider = context.req.param("provider");
    if (!isProviderId(provider))
      throw new RuntimeError("invalid_request", "Provider id is not valid", 400);
    const parsed = parseSetProviderApiKey(await readBody(context));
    if (!parsed.ok) throw new RuntimeError("invalid_request", parsed.message, 400);
    const { apiKey } = parsed.value;
    if (apiKey !== null) {
      const known = (await options.backend.listProviders()).providers;
      if (!known.some((candidate) => candidate.id === provider))
        throw new RuntimeError("invalid_request", `Unknown provider ${provider}`, 400);
    }
    await options.settings.setProviderApiKey(provider, apiKey);
    // A new key is checked against the provider's live model list; a removed one needs no network.
    return context.json(
      await options.backend.refreshProviders(
        apiKey === null ? { provider, offline: true } : { provider },
      ),
    );
  });

  // In-app OAuth sign-in: start + poll (never held open), so a UI polls `oauth/logins/:id`. Global: token only.
  app.post(`${AGENT_RUNTIME_PREFIX}/providers/:provider/oauth/login`, async (context) => {
    const provider = providerParam(context);
    const parsed = parseStartOAuthLogin(await readBody(context));
    if (!parsed.ok) throw new RuntimeError("invalid_request", parsed.message, 400);
    return context.json(await options.backend.startOAuthLogin(provider, parsed.value.flow));
  });

  app.post(`${AGENT_RUNTIME_PREFIX}/providers/:provider/oauth/logout`, async (context) =>
    context.json(await options.backend.signOutOAuth(providerParam(context))),
  );

  app.get(`${AGENT_RUNTIME_PREFIX}/oauth/logins/:loginId`, (context) =>
    context.json(options.backend.getOAuthLogin(loginParam(context))),
  );

  app.post(`${AGENT_RUNTIME_PREFIX}/oauth/logins/:loginId/input`, async (context) => {
    const loginId = loginParam(context);
    const parsed = parseSubmitOAuthLoginInput(await readBody(context));
    if (!parsed.ok) throw new RuntimeError("invalid_request", parsed.message, 400);
    return context.json(options.backend.submitOAuthLoginInput(loginId, parsed.value.text));
  });

  app.post(`${AGENT_RUNTIME_PREFIX}/oauth/logins/:loginId/cancel`, async (context) =>
    context.json(await options.backend.cancelOAuthLogin(loginParam(context))),
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
    // The test needs no project: it runs in an empty scratch directory, so the agent can read nothing of the user's.
    const scratch = await realpath(await mkdtemp(join(tmpdir(), "openvids-jev-test-")));
    try {
      return context.json(await testJev(options.backend, scratch, jev, now));
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  });

  app.get(`${AGENT_RUNTIME_PREFIX}/chats`, (context) => {
    const { chats, turns } = context.get("project");
    return context.json({ chats: chats.list(), activeTurn: turns.activeTurn });
  });

  // What the project's agents used (tokens and cost), from the journal that outlives chats: slices total / by agent /
  // by model / by chat, optionally for a period (`since`, `until` in epoch ms).
  app.get(`${AGENT_RUNTIME_PREFIX}/usage`, async (context) => {
    const parsed = parseUsageQuery(new URL(context.req.url).searchParams);
    if (!parsed.ok) throw new RuntimeError("invalid_request", parsed.message, 400);
    const { chats, turns, usage } = context.get("project");
    // The running turn is read first: one that ends while the journal is read still counts, through its chat state.
    const active = turns.activeTurn;
    await chats.settleTurnHooks();
    const journal = await usage.all();
    const activeState = active ? chats.get(active.chatId) : null;
    return context.json(
      buildUsageReport({
        journal,
        live: active && activeState ? usageEntriesOfTurn(activeState, active.turnId) : [],
        turnRunning: active !== null,
        query: parsed.value,
        chatTitles: new Map(chats.list().map((chat) => [chat.id, chat.title])),
      }),
    );
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

  // Removes the chat and its stored events; refused (409 chat_busy) while it runs a turn or is being reverted.
  app.delete(`${AGENT_RUNTIME_PREFIX}/chats/:chatId`, async (context) => {
    const parsed = parseDeleteChat(await readBody(context));
    if (!parsed.ok) throw new RuntimeError("invalid_request", parsed.message, 400);
    return context.json(await context.get("project").turns.deleteChat(context.req.param("chatId")));
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

  // The user's answer to a permission request shown in the chat ("Allow once" / "Turn on" / "Don't allow"): the
  // waiting tool call resumes (or is refused) with it. `always` switches the setting on, `once` grants the turn.
  app.post(
    `${AGENT_RUNTIME_PREFIX}/chats/:chatId/turns/:turnId/permissions/:permissionId`,
    async (context) => {
      const parsed = parseAnswerPermission(await readBody(context));
      if (!parsed.ok) throw new RuntimeError("invalid_request", parsed.message, 400);
      const response = await context
        .get("project")
        .turns.answerPermission(
          context.req.param("chatId"),
          context.req.param("turnId"),
          context.req.param("permissionId"),
          parsed.value.decision,
        );
      return context.json(response);
    },
  );

  // The user's answer to a question an agent asked mid-turn (`request_input`): the waiting call resumes with it.
  app.post(
    `${AGENT_RUNTIME_PREFIX}/chats/:chatId/turns/:turnId/questions/:questionId`,
    async (context) => {
      const parsed = parseAnswerQuestion(await readBody(context));
      if (!parsed.ok) throw new RuntimeError("invalid_request", parsed.message, 400);
      const response = await context
        .get("project")
        .turns.answerQuestion(
          context.req.param("chatId"),
          context.req.param("turnId"),
          context.req.param("questionId"),
          parsed.value.answer,
        );
      return context.json(response);
    },
  );

  // The user stops one delegated run; the turn and the other runs go on.
  app.post(
    `${AGENT_RUNTIME_PREFIX}/chats/:chatId/turns/:turnId/runs/:runId/cancel`,
    async (context) => {
      const parsed = parseCancelRun(await readBody(context));
      if (!parsed.ok) throw new RuntimeError("invalid_request", parsed.message, 400);
      const response = await context
        .get("project")
        .turns.cancelRun(
          context.req.param("chatId"),
          context.req.param("turnId"),
          context.req.param("runId"),
          parsed.value.reason,
        );
      return context.json(response);
    },
  );

  // The user's answer to a Story Mode offer card ("Open in Story" / "No, edit right away"): the offer stays
  // answerable after its own turn ended, so unlike a permission it is read from the chat. An `accept` writes the
  // chapters into the Story Graph through the story service before it answers (no model runs).
  app.post(
    `${AGENT_RUNTIME_PREFIX}/chats/:chatId/turns/:turnId/story-offers/:offerId`,
    async (context) => {
      const parsed = parseAnswerStoryOffer(await readBody(context));
      if (!parsed.ok) throw new RuntimeError("invalid_request", parsed.message, 400);
      const response = await context
        .get("project")
        .turns.answerStoryOffer(
          context.req.param("chatId"),
          context.req.param("turnId"),
          context.req.param("offerId"),
          parsed.value.decision,
          context.req.raw.signal,
        );
      return context.json(response);
    },
  );

  app.post(`${AGENT_RUNTIME_PREFIX}/chats/:chatId/turns/:turnId/revert`, async (context) => {
    const parsed = parseRevertTurn(await readBody(context));
    if (!parsed.ok) throw new RuntimeError("invalid_request", parsed.message, 400);
    const response = await context
      .get("project")
      .turns.revert(context.req.param("chatId"), context.req.param("turnId"), parsed.value.mode);
    return context.json(response);
  });

  app.post(`${AGENT_RUNTIME_PREFIX}/chats/:chatId/turns/:turnId/unrevert`, async (context) => {
    const parsed = parseRevertTurn(await readBody(context));
    if (!parsed.ok) throw new RuntimeError("invalid_request", parsed.message, 400);
    const response = await context
      .get("project")
      .turns.unrevert(context.req.param("chatId"), context.req.param("turnId"), parsed.value.mode);
    return context.json(response);
  });

  return Object.assign(app, {
    dispose: async () => {
      const runtimes = await Promise.allSettled([...projects.values()]);
      for (const result of runtimes) {
        if (result.status !== "fulfilled") continue;
        await result.value.turns.dispose();
        await result.value.usage.drain();
        result.value.release();
      }
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
      // One runtime process owns a project's chats; a second one is refused (409 project_served_elsewhere).
      const release = await takeProjectOwnership(scope.projectDir);
      try {
        const store = new FileChatStore(scope.projectDir);
        const usage = new UsageJournal(scope.projectDir, store);
        const chats = await ChatService.open(scope, store, {
          now,
          ...(ids && { ids }),
          onTurnEnded: (state, turnId) => usage.recordTurn(state, turnId),
        });
        const turns = new TurnRunner(
          chats,
          options.backend,
          options.checkpoints,
          store,
          options.settings,
          turnOptions,
        );
        // Rebuild a missing journal from the chat logs in the background; a failure is retried by the next use.
        void usage.ready().catch(() => undefined);
        await turns.recoverCheckpoints();
        return { scope, store, chats, usage, turns, release };
      } catch (error) {
        release();
        throw error;
      }
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
