import { chmod, mkdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { authPolicyFor } from "@oh-my-pi/pi-catalog/compat/auth";
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
} from "@oh-my-pi/pi-coding-agent";
import { SqliteAuthCredentialStore } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { cfgDefaultThinkingLevel } from "@oh-my-pi/pi-coding-agent/session/settings";
import type {
  AgentBackend,
  BackendEvent,
  BackendPromptInput,
  BackendPromptOutcome,
  BackendSession,
  HostTool,
  OpenBackendSessionInput,
  RefreshProvidersOptions,
} from "../backend.ts";
import { AGENT_DISPLAY_NAMES, isRecord } from "@hyperframes/agent-protocol";
import type {
  AgentModelCatalog,
  AgentModelInfo,
  ListProvidersResponse,
  ModelSelection,
  OAuthFlow,
  OAuthLoginState,
  ProjectTitleRequest,
  ThinkingEffort,
} from "@hyperframes/agent-protocol";
import { RuntimeError } from "../errors.ts";
import { OAuthLogins, type LoginController } from "../oauthLogins.ts";
import { LayeredAuthCredentialStore, isOpenVidsCredentialId } from "./layered-auth-store.ts";
import { oauthLoginOptions, providerOAuthInfo } from "./oauth-support.ts";
import { humanReadableError, terminalEventResult, translateOmpEvent } from "./events.ts";
import {
  createModelCatalog,
  isThinkingEffort,
  mapModelInfo,
  parseModelRole,
  sameModel,
  type ModelCatalogSource,
} from "./model-mapping.ts";
import {
  isLostSignInCause,
  toProviderInfo,
  type DiscoveryFacts,
  type OmpCredentialKind,
} from "./provider-status.ts";
import { hostToolContent } from "./tool-content.ts";
import { projectContextFiles } from "./context-files.ts";
import { projectBoundaryExtension } from "./tool-guard.ts";
import { generateProjectTitleWithOmp } from "./title.ts";

const MODEL_CATALOG_TTL_MS = 60_000;
const PROJECT_FILE_TOOLS = ["read", "grep", "glob", "find", "edit", "write"];
const EMPTY_CATALOG: AgentModelCatalog = {
  models: [],
  defaultModel: null,
  defaultThinking: null,
};

/**
 * The API keys the user entered in OpenVids, by provider id; read on every use so a key saved by another runtime process
 * is picked up. Applied on top of the user's OMP credentials, in memory only.
 */
export type ProviderKeySource = () => Promise<ReadonlyMap<string, string>>;

type RefreshStrategy = NonNullable<Parameters<ModelRegistry["refresh"]>[0]>;

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
  /** When the last refresh (successful or not) started; paces the background refresh. */
  lastRefreshAt: number;
  lastRefreshError: string | null;
  /** When a live refresh last succeeded; null before the first one. */
  syncedAt: number | null;
  /** The OpenVids-stored keys currently applied to `authStorage` as runtime overrides, by provider. */
  appliedKeys: Map<string, string>;
  /**
   * `authStorage` reads OMP's credentials and OpenVids' own sign-ins through a {@link LayeredAuthCredentialStore}.
   * False when it could not be set up (OMP uses an auth broker, an XDG layout, or no OpenVids auth path was given):
   * then OMP's credentials are used exactly as before and in-app sign-in is unavailable.
   */
  layered: boolean;
  /** The refresh in flight (they run one after another); null when idle. */
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

/** Settings of one isolated agent session; nothing is read from or written to the user's OMP config. */
export function createSessionSettings(defaultThinkingLevel: Effort): Settings {
  return Settings.isolated({
    defaultThinkingLevel,
    // A path-based edit form: `{path, old_string, new_string}`. The default hashline/apply_patch
    // forms hide their target files inside free text, which the project-boundary guard cannot check.
    "edit.mode": "replace",
    // `read` fetches web and loopback URLs when this is on, which would bypass the Websites
    // permission and the download prompt; research goes through the runtime's own host tools.
    "fetch.enabled": false,
  });
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

/**
 * Exposes a runtime host tool to OMP. It is essential (always loaded), and the runtime reports its effects; progress the
 * tool reports (a render) goes out as `tool.progress` of its call.
 */
function toOmpTool(tool: HostTool, report: (event: BackendEvent) => void): CustomTool {
  return {
    name: tool.name,
    label: tool.name,
    description: tool.description,
    parameters: tool.parameters,
    loadMode: "essential",
    async execute(toolCallId, params, _onUpdate, _context, signal) {
      const result = await tool.execute(
        params,
        signal ?? new AbortController().signal,
        (progress) => report({ type: "tool.progress", toolCallId, progress }),
      );
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

  /** An event the runtime side produced (host tool progress) for the prompt in flight. */
  report(event: BackendEvent): void {
    const active = this.activeTurn;
    if (!active || active.settled) return;
    try {
      active.onEvent(event);
    } catch {
      // The runtime owns event persistence; a consumer callback must not break the tool.
    }
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

/**
 * Makes the runtime overrides of `authStorage` equal `keys`. Runtime overrides live in the SDK's memory only: they are
 * never written to `~/.omp/agent` (checked in the SDK: `KeyOverrides.setRuntime` is a `Map`), and they win over every
 * stored credential of the provider, so an OpenVids key replaces the user's OMP credential for that provider.
 * Returns whether anything changed.
 */
function applyProviderKeys(
  authStorage: AuthStorage,
  applied: Map<string, string>,
  keys: ReadonlyMap<string, string>,
): boolean {
  let changed = false;
  for (const [provider, key] of keys) {
    if (applied.get(provider) === key) continue;
    authStorage.keys.setRuntime(provider, key);
    applied.set(provider, key);
    changed = true;
  }
  for (const provider of [...applied.keys()]) {
    if (keys.has(provider)) continue;
    authStorage.keys.removeRuntime(provider);
    applied.delete(provider);
    changed = true;
  }
  return changed;
}

function credentialKind(authStorage: AuthStorage, provider: string): OmpCredentialKind | null {
  return authStorage.keys.source(provider, { env: "aliases" })?.kind ?? null;
}

function discoveryFacts(registry: ModelRegistry, provider: string): DiscoveryFacts | null {
  const state = registry.getProviderDiscoveryState(provider);
  if (!state) return null;
  return {
    status: state.status,
    stale: state.stale,
    ...(state.source !== undefined && { source: state.source }),
    ...(state.error !== undefined && { error: state.error }),
  };
}

/**
 * Providers whose OMP sign-in was torn down after a definitive refresh failure (expired or revoked grant), with the
 * cause. A tombstone left by the user's own logout, or by removing a duplicate, is not one.
 */
async function lostSignIns(authStorage: AuthStorage): Promise<Map<string, string>> {
  const lost = new Map<string, { cause: string; at: number }>();
  let disabled: Awaited<ReturnType<AuthStorage["credentials"]["listDisabled"]>> = [];
  try {
    disabled = await authStorage.credentials.listDisabled();
  } catch {
    return new Map();
  }
  for (const entry of disabled) {
    if (entry.type !== "oauth" || !isLostSignInCause(entry.cause)) continue;
    const at = entry.disabledAtMs ?? 0;
    const known = lost.get(entry.provider);
    if (!known || at >= known.at) lost.set(entry.provider, { cause: entry.cause, at });
  }
  return new Map([...lost].map(([provider, { cause }]) => [provider, cause]));
}

/**
 * Whether OMP keeps its credentials in an auth broker (`OMP_AUTH_BROKER_URL`, or `auth.broker` in its config) instead of
 * the local `agent.db`: then the SDK reads a remote store and OpenVids does not layer anything over it.
 */
async function ompUsesAuthBroker(agentDir: string): Promise<boolean> {
  if (process.env.OMP_AUTH_BROKER_URL?.trim()) return true;
  for (const name of ["config.yml", "config.yaml"]) {
    try {
      if (/\bbroker\b/i.test(await readFile(path.join(agentDir, name), "utf8"))) return true;
    } catch {
      // No such config file.
    }
  }
  return false;
}

/**
 * Layers OpenVids' own credential store (`authDbPath`) over the one the SDK discovered for `agentDir` (see
 * {@link LayeredAuthCredentialStore}): afterwards `authStorage` reads OMP's credentials and OpenVids' own sign-ins,
 * stores new sign-ins and their token refreshes in OpenVids' database only, and keeps OMP's rows as they were.
 * Never throws: when it cannot be done the discovered store stays in place and false is returned (in-app sign-in is
 * then off).
 */
export async function layerOpenVidsAuth(
  authStorage: AuthStorage,
  agentDir: string,
  authDbPath: string,
): Promise<boolean> {
  // The paths of OMP's database under an XDG layout, and a broker's remote store, are not something to guess at.
  if (process.env.XDG_DATA_HOME?.trim() || (await ompUsesAuthBroker(agentDir))) return false;
  let omp: SqliteAuthCredentialStore | null = null;
  let own: SqliteAuthCredentialStore | null = null;
  try {
    await mkdir(path.dirname(authDbPath), { recursive: true, mode: 0o700 });
    await chmod(path.dirname(authDbPath), 0o700).catch(() => undefined);
    omp = await SqliteAuthCredentialStore.open(path.join(agentDir, "agent.db"));
    own = await SqliteAuthCredentialStore.open(authDbPath);
    await authStorage.replaceStore(new LayeredAuthCredentialStore(omp, own));
    return true;
  } catch {
    // replaceStore closes the layered store (both databases) when it fails; close what it never got.
    try {
      omp?.close();
      own?.close();
    } catch {
      // Already closed.
    }
    return false;
  }
}

class OmpBackend implements AgentBackend {
  readonly name = "omp";
  private readonly logins: OAuthLogins;
  private servicesPromise: Promise<CatalogServices> | null = null;
  private readonly sessions = new Set<OmpBackendSession>();
  private disposed = false;
  private disposePromise: Promise<void> | null = null;

  constructor(
    private readonly agentDir: string,
    private readonly providerKeys: ProviderKeySource,
    /** OpenVids' own auth database (sign-ins made in the app), or null when none was configured. */
    private readonly authDbPath: string | null,
  ) {
    this.logins = new OAuthLogins({
      run: (loginId, controller) => this.runLogin(loginId, controller),
      onSucceeded: (provider) => this.afterSignIn(provider),
    });
  }

  private async runLogin(loginId: string, controller: LoginController): Promise<void> {
    const services = await this.ensureServices({ refreshes: false });
    if (!services.layered) throw new Error("Signing in is not available in this setup.");
    await services.authStorage.oauth.login(loginId, {
      signal: controller.signal,
      onAuth: (info) => controller.onAuth({ url: info.url, instructions: info.instructions }),
      onProgress: (message) => controller.onProgress(message),
      onPrompt: (prompt) =>
        controller.onPrompt({
          message: prompt.message,
          placeholder: prompt.placeholder,
          secret: prompt.secret,
        }),
    });
  }

  /** A sign-in stored its credential: models of the provider are available at once; the live list follows. */
  private async afterSignIn(provider: string): Promise<void> {
    const services = await this.ensureServices({ refreshes: false });
    services.catalog = createCatalog(services.registry, services.settings);
    void this.refresh(services, "online", provider);
  }

  async startOAuthLogin(provider: string, flow?: OAuthFlow): Promise<OAuthLoginState> {
    const services = await this.ensureServices({ refreshes: false });
    const options = oauthLoginOptions(provider);
    if (!services.layered || options.length === 0) {
      throw new RuntimeError(
        "invalid_request",
        services.layered
          ? `${provider} has no in-app sign-in. Use an API key, or sign in with OMP.`
          : "Signing in inside OpenVids is not available here: OMP's credentials are kept in an auth broker or an unsupported location. Sign in with OMP instead.",
        400,
      );
    }
    const option =
      flow === undefined ? options[0] : options.find((candidate) => candidate.flow === flow);
    if (!option)
      throw new RuntimeError("invalid_request", `${provider} has no ${flow} sign-in`, 400);
    // A sign-in answered from another window or runtime is picked up before one is started needlessly.
    await services.authStorage.credentials.poll().catch(() => false);
    return this.logins.start({ provider, loginId: option.loginId, flow: option.flow });
  }

  getOAuthLogin(id: string): OAuthLoginState {
    return this.logins.get(id);
  }

  submitOAuthLoginInput(id: string, text: string): OAuthLoginState {
    return this.logins.submit(id, text);
  }

  cancelOAuthLogin(id: string): Promise<OAuthLoginState> {
    return this.logins.cancel(id);
  }

  /** Removes the sign-in OpenVids stored for a provider. What OMP holds is never touched. */
  async signOutOAuth(provider: string): Promise<ListProvidersResponse> {
    const services = await this.ensureServices({ refreshes: false });
    if (!services.layered)
      throw new RuntimeError(
        "invalid_request",
        "There is no sign-in stored by OpenVids to remove.",
        400,
      );
    await services.authStorage.credentials.reload().catch(() => undefined);
    const owned = services.authStorage.credentials
      .list(provider)
      .some((row) => isOpenVidsCredentialId(row.id));
    if (!owned) {
      throw new RuntimeError(
        "invalid_request",
        `OpenVids holds no sign-in for ${provider}. A login OMP holds can only be removed in OMP.`,
        409,
      );
    }
    await services.authStorage.credentials.remove(provider);
    // OMP's own credential for the provider (if any) shows again.
    await services.authStorage.credentials.reload();
    services.catalog = createCatalog(services.registry, services.settings);
    await this.refresh(services, "offline", provider);
    return this.providerList(services);
  }

  private async storedProviderKeys(): Promise<ReadonlyMap<string, string>> {
    try {
      return await this.providerKeys();
    } catch {
      return new Map();
    }
  }

  private async loadServices(): Promise<CatalogServices> {
    const settings = await Settings.loadReadOnly({ cwd: homedir(), agentDir: this.agentDir });
    const authStorage = await discoverAuthStorage(this.agentDir, {
      cwd: homedir(),
      settings,
    });
    const layered =
      this.authDbPath !== null &&
      (await layerOpenVidsAuth(authStorage, this.agentDir, this.authDbPath));
    // The keys OpenVids stores are in place before the first discovery, so it already uses them.
    const appliedKeys = new Map<string, string>();
    applyProviderKeys(authStorage, appliedKeys, await this.storedProviderKeys());
    const registry = new ModelRegistry(authStorage, undefined, { settings });
    let refreshError: string | null = null;
    let syncedAt: number | null = null;
    try {
      await registry.refresh();
      syncedAt = Date.now();
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
      syncedAt,
      appliedKeys,
      layered,
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

  /**
   * The shared services, with the OpenVids-stored keys brought up to date (a cheap read of one small file). A key that
   * changed since the last call — saved or removed by this process or by another runtime — is applied to the credential
   * layer at once and the catalog is rebuilt from it; live model lists are refreshed in the background unless the
   * caller does that itself (`refreshes: false`).
   */
  private async ensureServices(options: { refreshes?: boolean } = {}): Promise<CatalogServices> {
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

    const keysChanged = applyProviderKeys(
      services.authStorage,
      services.appliedKeys,
      await this.storedProviderKeys(),
    );
    if (keysChanged) services.catalog = createCatalog(services.registry, services.settings);
    if (options.refreshes !== false) {
      const stale = Date.now() - services.lastRefreshAt >= MODEL_CATALOG_TTL_MS;
      if (keysChanged || (stale && !services.refreshing)) {
        void this.refresh(services, "online-if-uncached");
      }
    }
    return services;
  }

  /** Runs one registry refresh after the one in flight, then rebuilds the catalog from the registry. Never rejects. */
  private refresh(
    services: CatalogServices,
    strategy: RefreshStrategy,
    provider?: string,
  ): Promise<void> {
    const previous = services.refreshing ?? Promise.resolve();
    const run = previous.then(async () => {
      services.lastRefreshAt = Date.now();
      try {
        if (provider === undefined) await services.registry.refresh(strategy);
        else await services.registry.refreshProvider(provider, strategy);
        if (strategy !== "offline") services.syncedAt = Date.now();
        services.lastRefreshError = null;
        services.catalog = createCatalog(services.registry, services.settings);
      } catch (error) {
        services.lastRefreshError = humanReadableError(error);
      }
    });
    services.refreshing = run;
    void run.finally(() => {
      if (services.refreshing === run) services.refreshing = null;
    });
    return run;
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

  private async providerList(services: CatalogServices): Promise<ListProvidersResponse> {
    const { registry, authStorage } = services;
    // While a refresh runs the registry's discovery states are in flux (or left over from before a key changed), so
    // nothing is concluded from them: the providers show as not yet checked until it has settled.
    const checking = services.refreshing !== null;
    const lost = await lostSignIns(authStorage);
    const signedIn = new Set<string>();
    if (services.layered) {
      for (const row of authStorage.credentials.list()) {
        if (isOpenVidsCredentialId(row.id)) signedIn.add(row.provider);
      }
    }
    const known = new Map<string, { models: number; authenticated: boolean }>();
    for (const model of registry.getAll()) {
      const entry = known.get(model.provider) ?? { models: 0, authenticated: false };
      entry.models += 1;
      entry.authenticated = entry.authenticated || registry.hasConfiguredAuth(model);
      known.set(model.provider, entry);
    }
    const providers = [...known]
      .map(([id, entry]) =>
        toProviderInfo({
          id,
          sdkName: authPolicyFor(id)?.name ?? null,
          modelCount: entry.models,
          authenticated: entry.authenticated,
          credential: credentialKind(authStorage, id),
          signedInWithOpenVids: signedIn.has(id),
          oauth: services.layered ? providerOAuthInfo(id) : null,
          discovery: checking ? null : discoveryFacts(registry, id),
          lostSignIn: entry.authenticated ? null : (lost.get(id) ?? null),
        }),
      )
      .sort((left, right) => left.id.localeCompare(right.id));
    return { providers, syncedAt: services.syncedAt };
  }

  async listProviders(): Promise<ListProvidersResponse> {
    const services = await this.ensureServices();
    // A sign-in done with OMP while the runtime was running: adopt it (a read of OMP's credential store).
    await services.authStorage.credentials.poll().catch(() => false);
    return this.providerList(services);
  }

  async refreshProviders(options: RefreshProvidersOptions = {}): Promise<ListProvidersResponse> {
    const services = await this.ensureServices({ refreshes: false });
    await services.authStorage.credentials.reload().catch(() => undefined);
    await this.refresh(services, options.offline ? "offline" : "online", options.provider);
    return this.providerList(services);
  }

  async listProviderModels(provider: string): Promise<AgentModelInfo[]> {
    const { registry } = await this.ensureServices();
    return catalogSources(registry.getAll().filter((model) => model.provider === provider)).map(
      mapModelInfo,
    );
  }

  async generateProjectTitle(input: ProjectTitleRequest): Promise<string> {
    const services = await this.ensureServices();
    const chosen = input.model
      ? services.registry.find(input.model.provider, input.model.modelId)
      : undefined;
    const model = input.model
      ? isAvailableModel(services.registry, chosen)
        ? chosen
        : undefined
      : chooseBackendModel(services.registry, services.catalog);
    if (!model) {
      throw new RuntimeError(
        "model_unavailable",
        input.model
          ? `The selected model ${input.model.provider}/${input.model.modelId} is not available or has no configured credentials.`
          : "No authenticated OMP model is available to name the project.",
        input.model ? 400 : 503,
      );
    }
    return generateProjectTitleWithOmp({
      model,
      registry: services.registry,
      request: input,
    });
  }

  async openSession(input: OpenBackendSessionInput): Promise<BackendSession> {
    const services = await this.ensureServices();
    if (this.disposed) throw new Error("The OMP backend has been disposed.");

    const sessionManager =
      input.stateDir === null
        ? SessionManager.inMemory(input.projectDir)
        : await openProjectSessionManager(input.projectDir, input.stateDir);

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
      const sessionSettings = createSessionSettings(initialThinking);
      const hostToolMap = new Map(input.hostTools.map((tool) => [tool.name, tool]));
      // Host tools are created before the adapter exists; their progress reaches it once it does.
      let progressTarget: OmpBackendSession | null = null;
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
        customTools: input.hostTools.map((tool) =>
          toOmpTool(tool, (event) => progressTarget?.report(event)),
        ),
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
            factory: projectBoundaryExtension(
              input.projectDir,
              input.fileWriteRefusal,
              input.askBeforeLockedEdits,
            ),
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
      const adapter = new OmpBackendSession(
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
      progressTarget = adapter;
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
      // Sign-ins first: their callback servers and timers must not outlive the runtime.
      await this.logins.dispose().catch(() => undefined);
      await Promise.allSettled([...this.sessions].map((session) => session.dispose()));
      const services = await this.servicesPromise?.catch(() => null);
      if (services?.refreshing) await services.refreshing;
      // Closing the credential databases checkpoints their write-ahead logs: nothing a sign-out blanked lingers there.
      try {
        services?.authStorage.close();
      } catch {
        // Already closed.
      }
    })();
    return this.disposePromise;
  }
}

/**
 * Resumes the newest OMP session stored in `stateDir`, or starts one, bound to `projectDir`.
 *
 * A session file records the folder it was created in, and OMP resumes there when that folder
 * still exists. A project copied or duplicated together with its chats would then edit the
 * ORIGINAL project's files, so a resumed session is rebound to this project (the file stays in
 * `stateDir`).
 */
export async function openProjectSessionManager(
  projectDir: string,
  stateDir: string,
): Promise<SessionManager> {
  await mkdir(stateDir, { recursive: true });
  const existing = await SessionManager.list(projectDir, stateDir);
  let newest = existing[0];
  for (const candidate of existing) {
    if (!newest || candidate.modified.getTime() > newest.modified.getTime()) newest = candidate;
  }
  if (!newest) return SessionManager.create(projectDir, stateDir);
  const manager = await SessionManager.open(newest.path, stateDir, undefined, {
    initialCwd: projectDir,
    throwIfMissing: true,
  });
  if (path.resolve(manager.getCwd()) !== path.resolve(projectDir)) {
    await manager.moveTo(projectDir, stateDir);
  }
  return manager;
}

export function createBackend(options?: {
  agentDir?: string;
  /** The API keys OpenVids stores for providers; default: none. */
  providerKeys?: ProviderKeySource;
  /** OpenVids' own auth database for sign-ins made in the app (`<settings dir>/auth.db`); default: none, no sign-in. */
  authDbPath?: string;
}): AgentBackend {
  const suppliedDir = options?.agentDir;
  const agentDir =
    suppliedDir === undefined
      ? path.join(homedir(), ".omp", "agent")
      : suppliedDir === "~"
        ? homedir()
        : suppliedDir.startsWith(`~${path.sep}`)
          ? path.resolve(homedir(), suppliedDir.slice(2))
          : suppliedDir;
  return new OmpBackend(
    path.resolve(agentDir),
    options?.providerKeys ?? (async () => new Map()),
    options?.authDbPath ? path.resolve(options.authDbPath) : null,
  );
}
