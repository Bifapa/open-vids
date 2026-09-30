import { mkdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { Effort } from "@oh-my-pi/pi-catalog/effort";
import {
  clampThinkingLevelForModel,
  getSupportedEfforts,
} from "@oh-my-pi/pi-catalog/model-thinking";
import {
  AgentRegistry,
  AuthStorage,
  ModelRegistry,
  Settings,
  SessionManager,
  createAgentSession,
  discoverAuthStorage,
  type AgentSession,
  type CreateAgentSessionOptions,
  type CustomTool,
  type ExtensionFactory,
} from "@oh-my-pi/pi-coding-agent";
import { cfgDefaultThinkingLevel } from "@oh-my-pi/pi-coding-agent/session/settings";
import type {
  AgentBackend,
  BackendPromptInput,
  BackendPromptOutcome,
  BackendSession,
  HostTool,
  OpenBackendSessionInput,
} from "../backend.ts";
import { AGENT_DISPLAY_NAMES, isRecord } from "@hyperframes/agent-protocol";
import type {
  AgentModelCatalog,
  AgentModelInfo,
  ModelSelection,
  ProviderInfo,
  ThinkingEffort,
} from "@hyperframes/agent-protocol";
import { humanReadableError, terminalEventResult, translateOmpEvent } from "./events.ts";
import {
  createModelCatalog,
  isThinkingEffort,
  mapModelInfo,
  parseModelRole,
  sameModel,
  type ModelCatalogSource,
} from "./model-mapping.ts";
import { hostToolContent } from "./tool-content.ts";
import { guardToolCallPaths } from "./path-guard.ts";

const MODEL_CATALOG_TTL_MS = 60_000;
const PROJECT_FILE_TOOLS = ["read", "grep", "glob", "find", "edit", "write"];
const EMPTY_CATALOG: AgentModelCatalog = {
  models: [],
  defaultModel: null,
  defaultThinking: null,
};

type OmpModel = NonNullable<CreateAgentSessionOptions["model"]>;
type UserThinkingSetting = "auto" | Effort;
type OmpThinking = Effort | "off";

type CatalogServices = {
  authStorage: AuthStorage;
  registry: ModelRegistry;
  settings: Settings;
  defaultRole: string | undefined;
  defaultThinking: Exclude<ThinkingEffort, "off">;
  catalog: AgentModelCatalog;
  lastRefreshAt: number;
  lastRefreshError: string | null;
  refreshing: Promise<void> | null;
};

class OmpCatalogUnavailableError extends Error {
  readonly catalog = EMPTY_CATALOG;

  constructor(message: string, cause?: unknown) {
    super(message, { cause });
    this.name = "OmpCatalogUnavailableError";
  }
}

function toOmpEffort(effort: Exclude<ThinkingEffort, "off">): Effort {
  switch (effort) {
    case "minimal":
      return Effort.Minimal;
    case "low":
      return Effort.Low;
    case "medium":
      return Effort.Medium;
    case "high":
      return Effort.High;
    case "xhigh":
      return Effort.XHigh;
    case "max":
      return Effort.Max;
  }
}

function toProtocolEffort(effort: unknown): ThinkingEffort | null {
  return isThinkingEffort(effort) ? effort : null;
}

function defaultEffort(setting: UserThinkingSetting): Exclude<ThinkingEffort, "off"> {
  if (setting === "auto") return "high";
  const effort = toProtocolEffort(setting);
  return effort && effort !== "off" ? effort : "high";
}

function sameOmpModel(left: OmpModel | undefined, right: OmpModel | undefined): boolean {
  return (
    left !== undefined &&
    right !== undefined &&
    left.provider === right.provider &&
    left.id === right.id
  );
}

function isAvailableModel(registry: ModelRegistry, model: OmpModel | undefined): model is OmpModel {
  return (
    model !== undefined &&
    registry.hasConfiguredAuth(model) &&
    registry.getAvailable().some((available) => sameOmpModel(available, model))
  );
}

function availableModels(registry: ModelRegistry): OmpModel[] {
  return registry.getAvailable().filter((model) => registry.hasConfiguredAuth(model));
}

function resolveRoleDefault(
  registry: ModelRegistry,
  role: string | undefined,
): { model: OmpModel | undefined; thinking: ThinkingEffort | null } {
  const parsed = parseModelRole(role);
  const model = parsed ? registry.find(parsed.model.provider, parsed.model.modelId) : undefined;
  if (!isAvailableModel(registry, model)) return { model: undefined, thinking: null };
  if (!parsed || parsed.thinking === null) return { model, thinking: null };
  if (parsed.thinking === "off") return { model, thinking: "off" };

  const clamped = clampThinkingLevelForModel(model, toOmpEffort(parsed.thinking));
  return { model, thinking: toProtocolEffort(clamped) };
}

function catalogSources(models: readonly OmpModel[]): ModelCatalogSource[] {
  return models.map((model) => ({
    provider: model.provider,
    modelId: model.id,
    name: model.name,
    reasoning: model.reasoning,
    ...(typeof model.contextWindow === "number" && Number.isFinite(model.contextWindow)
      ? { contextWindow: model.contextWindow }
      : {}),
    supportedEfforts: getSupportedEfforts(model),
  }));
}

async function projectContextFiles(
  projectDir: string,
): Promise<Array<{ path: string; content: string }>> {
  for (const name of ["AGENTS.md", "CLAUDE.md"]) {
    const filePath = path.join(projectDir, name);
    if (await guardToolCallPaths(projectDir, { path: filePath })) continue;
    try {
      const content = await readFile(filePath, "utf8");
      return [{ path: filePath, content }];
    } catch (error) {
      if (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === "ENOENT"
      ) {
        continue;
      }
    }
  }
  return [];
}

function projectBoundaryExtension(projectDir: string): ExtensionFactory {
  return (pi) => {
    pi.on("tool_call", async (event) => {
      const reason = await guardToolCallPaths(projectDir, event.input, event.toolName);
      return reason ? { block: true, reason } : undefined;
    });
  };
}

function chooseBackendModel(
  registry: ModelRegistry,
  catalog: CatalogServices["catalog"],
): OmpModel | undefined {
  if (catalog.defaultModel) {
    const configured = registry.find(catalog.defaultModel.provider, catalog.defaultModel.modelId);
    if (isAvailableModel(registry, configured)) return configured;
  }
  return availableModels(registry)[0];
}

function toModelSelection(model: OmpModel): ModelSelection {
  return { provider: model.provider, modelId: model.id };
}

function createCatalog(registry: ModelRegistry, settings: Settings): CatalogServices["catalog"] {
  const models = availableModels(registry);
  const defaultRole = settings.getModelRole("default");
  const roleDefault = resolveRoleDefault(registry, defaultRole);
  return createModelCatalog(catalogSources(models), defaultRole, roleDefault.thinking);
}

/** Exposes a runtime host tool to OMP. It is essential (always loaded), and the runtime reports its effects. */
function toOmpTool(tool: HostTool): CustomTool {
  return {
    name: tool.name,
    label: tool.name,
    description: tool.description,
    parameters: tool.parameters,
    loadMode: "essential",
    async execute(_toolCallId, params, _onUpdate, _context, signal) {
      const result = await tool.execute(params, signal ?? new AbortController().signal);
      return {
        content: hostToolContent(result),
        ...(result.isError && { isError: true }),
      };
    },
  };
}

class OmpBackendSession implements BackendSession {
  private activeTurn: {
    onEvent: BackendPromptInput["onEvent"];
    settle: (outcome: BackendPromptOutcome) => void;
    fail: (error: Error) => void;
    settled: boolean;
    aborted: boolean;
    abort: () => void;
  } | null = null;
  private disposed = false;
  private promptInProgress = false;
  private readonly pendingSteering: string[] = [];
  private disposePromise: Promise<void> | null = null;
  private readonly unsubscribe: () => void;

  constructor(
    private readonly session: AgentSession,
    private readonly projectDir: string,
    private readonly services: CatalogServices,
    /** The shared registry, or a session-private one when the session has its own credentials. */
    private readonly registry: ModelRegistry,
    private readonly hostTools: ReadonlyMap<string, HostTool>,
    private readonly onDispose: () => void,
  ) {
    this.unsubscribe = session.subscribe((event) => this.handleEvent(event));
  }

  private handleEvent(event: unknown): void {
    const active = this.activeTurn;
    if (!active || active.settled) return;

    const translated = translateOmpEvent(event, this.projectDir, this.hostTools);
    if (translated) {
      try {
        active.onEvent(translated);
      } catch {
        // The runtime owns event persistence; a consumer callback must not break OMP's stream.
      }
    }
    if (isRecord(event) && event.type === "agent_start" && this.pendingSteering.length > 0) {
      const pending = this.pendingSteering.splice(0);
      for (const text of pending) {
        void this.session.steer(text).catch((error: unknown) => {
          if (!active.settled) {
            active.fail(new Error(humanReadableError(error), { cause: error }));
          }
        });
      }
    }

    const terminal = terminalEventResult(event);
    if (!terminal) return;
    if (active.aborted || terminal.aborted) {
      active.settle("aborted");
    } else if (terminal.error) {
      active.fail(new Error(terminal.error));
    } else {
      active.settle("completed");
    }
  }

  private resolveModel(selection: BackendPromptInput["model"]): OmpModel {
    const model = selection
      ? this.registry.find(selection.provider, selection.modelId)
      : chooseBackendModel(this.registry, this.services.catalog);
    if (!model || !this.registry.hasConfiguredAuth(model)) {
      if (selection) {
        throw new Error(
          `The selected model ${selection.provider}/${selection.modelId} is not available or has no configured credentials.`,
        );
      }
      throw new Error(
        "No authenticated OMP model is available. Sign in with OMP or configure a provider API key.",
      );
    }
    return model;
  }

  private resolveThinking(input: BackendPromptInput, model: OmpModel): OmpThinking | undefined {
    const requested =
      input.thinking ??
      (sameModel(toModelSelection(model), this.services.catalog.defaultModel)
        ? this.services.catalog.defaultThinking
        : null) ??
      this.services.defaultThinking;
    if (requested === "off") return "off";
    return clampThinkingLevelForModel(model, toOmpEffort(requested));
  }

  async prompt(input: BackendPromptInput): Promise<BackendPromptOutcome> {
    if (this.disposed) throw new Error("The OMP session has been disposed.");
    if (this.promptInProgress) throw new Error("Only one OMP prompt may run per chat at a time.");
    if (input.signal.aborted) return "aborted";
    this.promptInProgress = true;

    let model: OmpModel;
    let thinking: OmpThinking | undefined;
    try {
      model = this.resolveModel(input.model);
      thinking = this.resolveThinking(input, model);
      await this.session.setModel(model, "default", {
        thinkingLevel: thinking === "off" ? undefined : thinking,
        persist: false,
      });
      if (thinking === "off") {
        this.session.agent.setDisableReasoning(true);
      } else {
        this.session.setThinkingLevel(thinking, false);
      }
    } catch (error) {
      this.promptInProgress = false;
      this.pendingSteering.length = 0;
      if (this.disposed) return "aborted";
      throw new Error(humanReadableError(error), { cause: error });
    }

    if (this.disposed || input.signal.aborted) {
      this.promptInProgress = false;
      this.pendingSteering.length = 0;
      return "aborted";
    }
    const resolvedThinking =
      thinking === "off" ? "off" : toProtocolEffort(this.session.thinkingLevel);
    try {
      input.onEvent({
        type: "model.resolved",
        model: toModelSelection(model),
        thinking: resolvedThinking,
      });
    } catch (error) {
      this.promptInProgress = false;
      this.pendingSteering.length = 0;
      throw error;
    }
    return new Promise<BackendPromptOutcome>((resolve, reject) => {
      const cleanup = (): void => {
        input.signal.removeEventListener("abort", onSignalAbort);
        if (this.activeTurn === active) this.activeTurn = null;
        this.promptInProgress = false;
        this.pendingSteering.length = 0;
      };
      const active = {
        onEvent: input.onEvent,
        settled: false,
        aborted: false,
        settle: (outcome: BackendPromptOutcome): void => {
          if (active.settled) return;
          active.settled = true;
          cleanup();
          resolve(outcome);
        },
        fail: (error: Error): void => {
          if (active.settled) return;
          active.settled = true;
          cleanup();
          reject(error);
        },
        abort: (): void => {
          if (active.settled || active.aborted) return;
          active.aborted = true;
          void this.session
            .abort()
            .catch(() => undefined)
            .finally(() => active.settle("aborted"));
        },
      };
      const onSignalAbort = (): void => active.abort();
      this.activeTurn = active;
      input.signal.addEventListener("abort", onSignalAbort, { once: true });

      if (input.signal.aborted) {
        active.abort();
        return;
      }

      this.session
        .prompt(input.text, { runCommands: false, expandPromptTemplates: false })
        .then((dispatched) => {
          if (!dispatched && !active.settled && !active.aborted && !this.disposed) {
            active.fail(new Error("The OMP session did not dispatch the prompt."));
          }
        })
        .catch((error: unknown) => {
          if (active.settled || active.aborted || this.disposed) return;
          active.fail(new Error(humanReadableError(error), { cause: error }));
        });
    });
  }

  async steer(text: string): Promise<void> {
    if (this.disposed) throw new Error("The OMP session has been disposed.");
    if (!this.activeTurn && this.promptInProgress) {
      this.pendingSteering.push(text);
      return;
    }
    if (!this.activeTurn) throw new Error("There is no active OMP turn to steer.");
    try {
      await this.session.steer(text);
    } catch (error) {
      throw new Error(humanReadableError(error), { cause: error });
    }
  }

  dispose(): Promise<void> {
    if (this.disposePromise) return this.disposePromise;
    this.disposed = true;
    this.session.beginDispose();
    const active = this.activeTurn;
    if (active) active.aborted = true;
    this.disposePromise = this.session.dispose().finally(() => {
      if (active) active.settle("aborted");
      this.pendingSteering.length = 0;
      this.promptInProgress = false;
      this.unsubscribe();
      this.onDispose();
    });
    return this.disposePromise;
  }
}

class OmpBackend implements AgentBackend {
  readonly name = "omp";
  private servicesPromise: Promise<CatalogServices> | null = null;
  private readonly sessions = new Set<OmpBackendSession>();
  private disposed = false;
  private disposePromise: Promise<void> | null = null;

  constructor(private readonly agentDir: string) {}

  private async loadServices(): Promise<CatalogServices> {
    const settings = await Settings.loadReadOnly({ cwd: homedir(), agentDir: this.agentDir });
    const authStorage = await discoverAuthStorage(this.agentDir, {
      cwd: homedir(),
      settings,
    });
    const registry = new ModelRegistry(authStorage, undefined, { settings });
    let refreshError: string | null = null;
    try {
      await registry.refresh();
    } catch (error) {
      refreshError = humanReadableError(error);
    }

    const defaultThinking = defaultEffort(cfgDefaultThinkingLevel.get(settings));
    const services: CatalogServices = {
      authStorage,
      registry,
      settings,
      defaultRole: settings.getModelRole("default"),
      defaultThinking,
      catalog: createCatalog(registry, settings),
      lastRefreshAt: Date.now(),
      lastRefreshError: refreshError,
      refreshing: null,
    };
    if (services.catalog.models.length === 0 && refreshError) {
      throw new OmpCatalogUnavailableError(
        `The OMP model catalog could not be loaded: ${refreshError}`,
        refreshError,
      );
    }
    return services;
  }

  private async ensureServices(): Promise<CatalogServices> {
    if (this.disposed) throw new Error("The OMP backend has been disposed.");
    if (!this.servicesPromise) this.servicesPromise = this.loadServices();

    let services: CatalogServices;
    try {
      services = await this.servicesPromise;
    } catch (error) {
      this.servicesPromise = null;
      if (error instanceof OmpCatalogUnavailableError) throw error;
      throw new OmpCatalogUnavailableError(
        `The OMP model catalog could not be loaded: ${humanReadableError(error)}`,
        error,
      );
    }

    if (Date.now() - services.lastRefreshAt >= MODEL_CATALOG_TTL_MS) {
      this.refreshInBackground(services);
    }
    return services;
  }

  private refreshInBackground(services: CatalogServices): void {
    if (services.refreshing) return;
    services.lastRefreshAt = Date.now();
    services.refreshing = services.registry
      .refresh()
      .then(() => {
        services.catalog = createCatalog(services.registry, services.settings);
        services.lastRefreshError = null;
      })
      .catch((error: unknown) => {
        services.lastRefreshError = humanReadableError(error);
      })
      .finally(() => {
        services.refreshing = null;
      });
  }

  async listModels(): Promise<AgentModelCatalog> {
    const services = await this.ensureServices();
    if (services.catalog.models.length === 0 && services.lastRefreshError) {
      throw new OmpCatalogUnavailableError(
        `The OMP model catalog could not be loaded: ${services.lastRefreshError}`,
        services.lastRefreshError,
      );
    }
    return {
      models: [...services.catalog.models],
      defaultModel: services.catalog.defaultModel ? { ...services.catalog.defaultModel } : null,
      defaultThinking: services.catalog.defaultThinking,
    };
  }

  async listProviders(): Promise<ProviderInfo[]> {
    const { registry } = await this.ensureServices();
    const providers = new Map<string, boolean>();
    for (const model of registry.getAll()) {
      const authenticated = providers.get(model.provider) ?? false;
      providers.set(model.provider, authenticated || registry.hasConfiguredAuth(model));
    }
    return [...providers]
      .map(([id, authenticated]) => ({ id, authenticated }))
      .sort((left, right) => left.id.localeCompare(right.id));
  }

  async listProviderModels(provider: string): Promise<AgentModelInfo[]> {
    const { registry } = await this.ensureServices();
    return catalogSources(registry.getAll().filter((model) => model.provider === provider)).map(
      mapModelInfo,
    );
  }

  async openSession(input: OpenBackendSessionInput): Promise<BackendSession> {
    const services = await this.ensureServices();
    if (this.disposed) throw new Error("The OMP backend has been disposed.");

    let sessionManager: SessionManager;
    if (input.stateDir === null) {
      sessionManager = SessionManager.inMemory(input.projectDir);
    } else {
      await mkdir(input.stateDir, { recursive: true });
      const existing = await SessionManager.list(input.projectDir, input.stateDir);
      let newest = existing[0];
      for (const candidate of existing) {
        if (!newest || candidate.modified.getTime() > newest.modified.getTime()) {
          newest = candidate;
        }
      }
      sessionManager = newest
        ? await SessionManager.open(newest.path, input.stateDir, undefined, {
            initialCwd: input.projectDir,
            throwIfMissing: true,
          })
        : SessionManager.create(input.projectDir, input.stateDir);
    }

    // Explicit credentials (Jev's API key) live in a private in-memory store for this session only, so they never
    // replace the credentials other agents use for the same provider.
    let privateAuth: AuthStorage | null = null;
    try {
      let authStorage = services.authStorage;
      let registry = services.registry;
      if (input.credentials) {
        privateAuth = await AuthStorage.create(":memory:");
        privateAuth.keys.setRuntime(input.credentials.provider, input.credentials.apiKey);
        authStorage = privateAuth;
        registry = new ModelRegistry(privateAuth, undefined, { settings: services.settings });
      }
      const defaultModel = chooseBackendModel(registry, services.catalog);
      const roleDefault = resolveRoleDefault(registry, services.defaultRole);
      const initialThinking =
        roleDefault.model &&
        sameOmpModel(defaultModel, roleDefault.model) &&
        roleDefault.thinking !== null &&
        roleDefault.thinking !== "off"
          ? toOmpEffort(roleDefault.thinking)
          : toOmpEffort(services.defaultThinking);
      // The user's environment may pin another edit variant (its targets live in free text the guard
      // cannot read); the session's own pinned mode must win.
      delete process.env.PI_EDIT_VARIANT;
      delete process.env.PI_STRICT_EDIT_MODE;
      const sessionSettings = Settings.isolated({
        defaultThinkingLevel: initialThinking,
        // A path-based edit form: `{path, old_string, new_string}`. The default hashline/apply_patch
        // forms hide their target files inside free text, which the project-boundary guard cannot check.
        "edit.mode": "replace",
      });
      const hostToolMap = new Map(input.hostTools.map((tool) => [tool.name, tool]));
      const hostToolNames = [...hostToolMap.keys()];
      const { session } = await createAgentSession({
        cwd: input.projectDir,
        sessionManager,
        agentDir: this.agentDir,
        authStorage,
        modelRegistry: registry,
        model: defaultModel,
        thinkingLevel: initialThinking,
        settings: sessionSettings,
        agentRegistry: new AgentRegistry(),
        agentName: input.agent === "director" ? "main" : input.agent,
        agentDisplayName: `OpenVids ${AGENT_DISPLAY_NAMES[input.agent]}`,
        // Only project file tools plus the runtime's own host tools (delegation, plan, Jev) — never OMP's
        // task/subagent tools: the runtime owns the one-level agent hierarchy.
        toolNames: [...PROJECT_FILE_TOOLS, ...hostToolNames],
        restrictToolNames: true,
        customTools: input.hostTools.map(toOmpTool),
        allowRestrictedCustomTools: true,
        autoApprove: true,
        enableMCP: false,
        enableLsp: false,
        enableIrc: false,
        disableExtensionDiscovery: true,
        // A restricted tool set drops `extensions`; only prepared extensions keep their hooks,
        // and the boundary guard is one of those hooks.
        preloadedPreparedExtensions: [
          {
            path: "<openvids-project-boundary>",
            resolvedPath: "<openvids-project-boundary>",
            factory: projectBoundaryExtension(input.projectDir),
            error: null,
          },
        ],
        skills: [],
        rules: [],
        contextFiles: await projectContextFiles(input.projectDir),
        promptTemplates: [],
        slashCommands: [],
        customSystemPrompt: input.instructions,
        hasUI: false,
        settingsApproval: false,
        bindProcessState: false,
      });
      // OMP drops inline extensions without a warning under `restrictToolNames`. The boundary guard is
      // the only thing between the model and the rest of the disk, so never run a session without it.
      if (!session.extensionRunner?.hasHandlers("tool_call")) {
        await session.dispose().catch(() => undefined);
        throw new Error("The project boundary guard is not active; refusing to start the agent.");
      }
      // Restricted sessions silently drop custom tools unless explicitly allowed and named; without them the
      // Director could not delegate and nobody would notice. Refuse to run a session that lost any.
      const active = new Set(session.getActiveToolNames());
      const missing = hostToolNames.filter((name) => !active.has(name));
      if (missing.length > 0) {
        await session.dispose().catch(() => undefined);
        throw new Error(
          `Agent tools are not active (${missing.join(", ")}); refusing to start the agent.`,
        );
      }
      const ownAuth = privateAuth;
      let adapter: OmpBackendSession;
      adapter = new OmpBackendSession(
        session,
        input.projectDir,
        services,
        registry,
        hostToolMap,
        () => {
          this.sessions.delete(adapter);
          ownAuth?.close();
        },
      );
      this.sessions.add(adapter);
      return adapter;
    } catch (error) {
      privateAuth?.close();
      await sessionManager.close().catch(() => undefined);
      throw new Error(humanReadableError(error), { cause: error });
    }
  }

  dispose(): Promise<void> {
    if (this.disposePromise) return this.disposePromise;
    this.disposed = true;
    this.disposePromise = (async () => {
      await Promise.allSettled([...this.sessions].map((session) => session.dispose()));
      const services = await this.servicesPromise?.catch(() => null);
      if (services?.refreshing) await services.refreshing;
    })();
    return this.disposePromise;
  }
}

export function createBackend(options?: { agentDir?: string }): AgentBackend {
  const suppliedDir = options?.agentDir;
  const agentDir =
    suppliedDir === undefined
      ? path.join(homedir(), ".omp", "agent")
      : suppliedDir === "~"
        ? homedir()
        : suppliedDir.startsWith(`~${path.sep}`)
          ? path.resolve(homedir(), suppliedDir.slice(2))
          : suppliedDir;
  return new OmpBackend(path.resolve(agentDir));
}
