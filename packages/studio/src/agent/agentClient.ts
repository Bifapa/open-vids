import {
  AGENT_ERROR_CODES,
  EXECUTION_QUALITY_PRESETS,
  OAUTH_FLOWS,
  PROVIDER_CREDENTIAL_SOURCES,
  PROVIDER_STATUSES,
  SPECIALIST_IDS,
  isQaReport,
  isRecord,
  readErrorParams,
  isChatIntent,
  isOAuthLoginState,
  parseAgentIntake,
  type ActiveTurnInfo,
  type AgentErrorBody,
  type AgentErrorCode,
  type AgentIntake,
  type AgentModelCatalog,
  type AgentSettings,
  type AutonomySettings,
  type ChatState,
  type ChatSummary,
  type CodedMessageParams,
  type CreateChatRequest,
  type ListChatsResponse,
  type ListProviderModelsResponse,
  type ListProvidersResponse,
  type ModelConfig,
  type OAuthLoginState,
  type ProviderInfo,
  type QaReport,
  type RevertTurnRequest,
  type RevertTurnResponse,
  type SetJevApiKeyRequest,
  type SetProviderApiKeyRequest,
  type StartOAuthLoginRequest,
  type StartTurnRequest,
  type StartTurnResponse,
  type SteerTurnRequest,
  type SteerTurnResponse,
  type SubmitOAuthLoginInputRequest,
  type TestJevResponse,
  type TurnSummary,
  type UpdateAgentSettingsRequest,
  type UpdateChatRequest,
} from "@hyperframes/agent-protocol";
import { t } from "../i18n";
import { buildProjectApiPath } from "../utils/projectRouting";

/** Why a gateway call failed, reduced to what the UI can act on. */
export type AgentFailureCode = AgentErrorCode | "network" | "bad_response";

export class AgentApiError extends Error {
  readonly code: AgentFailureCode;
  readonly status: number;
  readonly details: Record<string, unknown> | undefined;
  /** Values the server's message interpolates; for `describeServerError` when it translates the code. */
  readonly params: CodedMessageParams | undefined;

  constructor(
    code: AgentFailureCode,
    message: string,
    status = 0,
    details?: Record<string, unknown>,
    params?: CodedMessageParams,
  ) {
    super(message);
    this.name = "AgentApiError";
    this.code = code;
    this.status = status;
    this.details = details;
    this.params = params;
  }

  /** The agent runtime cannot be reached (or the host has no gateway); the editor is unaffected. */
  get isUnavailable(): boolean {
    return (
      this.code === "network" ||
      this.code === "runtime_unavailable" ||
      this.status === 404 ||
      this.status === 502 ||
      this.status === 503
    );
  }
}

/** The gateway API as the store sees it. `createAgentClient` is the network implementation. */
export interface AgentClient {
  listChats(): Promise<ListChatsResponse>;
  listModels(): Promise<AgentModelCatalog>;
  createChat(request: CreateChatRequest): Promise<ChatSummary>;
  getChat(chatId: string): Promise<ChatState>;
  updateChat(chatId: string, request: UpdateChatRequest): Promise<ChatSummary>;
  startTurn(chatId: string, request: StartTurnRequest): Promise<StartTurnResponse>;
  steerTurn(chatId: string, turnId: string, request: SteerTurnRequest): Promise<SteerTurnResponse>;
  abortTurn(chatId: string, turnId: string): Promise<void>;
  revertTurn(
    chatId: string,
    turnId: string,
    request: RevertTurnRequest,
  ): Promise<RevertTurnResponse>;
  /** Undo revert: puts a reverted turn's changes back (same request and response as a revert). */
  unrevertTurn(
    chatId: string,
    turnId: string,
    request: RevertTurnRequest,
  ): Promise<RevertTurnResponse>;
  /** Same-origin URL for the chat event stream, resuming after `afterSeq`. */
  chatEventsUrl(chatId: string, afterSeq: number): string;
  projectEventsUrl(): string;
  /** Global (per-user) agent settings: Director and specialist defaults, and Jev. */
  getSettings(): Promise<AgentSettings>;
  updateSettings(request: UpdateAgentSettingsRequest): Promise<AgentSettings>;
  /** Stores (string) or removes (null) Jev's API key; the key never comes back. */
  setJevApiKey(request: SetJevApiKeyRequest): Promise<AgentSettings>;
  testJev(): Promise<TestJevResponse>;
  listProviders(): Promise<ListProvidersResponse>;
  /** Re-reads every provider's credentials and live model list now; can take a while when one is unreachable. */
  refreshProviders(): Promise<ListProvidersResponse>;
  /**
   * Stores (string) or removes (null) the API key OpenVids keeps for one provider. A new key is checked against the
   * provider live (up to ~10 s when it is unreachable). The key never comes back.
   */
  setProviderApiKey(
    provider: string,
    request: SetProviderApiKeyRequest,
  ): Promise<ListProvidersResponse>;
  /**
   * Starts the provider's in-app sign-in (the default flow unless `request.flow` names one). A second start for the
   * same provider returns the sign-in that is already running. The runtime never opens a browser: the UI does.
   */
  startOAuthLogin(provider: string, request: StartOAuthLoginRequest): Promise<OAuthLoginState>;
  /** Where a sign-in is now; answers 404 once a finished one has been forgotten. */
  getOAuthLogin(loginId: string): Promise<OAuthLoginState>;
  /** Answers the prompt of a sign-in (a code, a redirect URL or what the provider asked for); never echoed back. */
  submitOAuthLoginInput(
    loginId: string,
    request: SubmitOAuthLoginInputRequest,
  ): Promise<OAuthLoginState>;
  cancelOAuthLogin(loginId: string): Promise<OAuthLoginState>;
  /** Forgets a sign-in made in OpenVids. It does not revoke the grant at the provider. */
  logoutProvider(provider: string): Promise<ListProvidersResponse>;
  /** Every model of one provider, signed in or not (Jev can bring its own key). */
  listProviderModels(provider: string): Promise<ListProviderModelsResponse>;
  /** One stored Render QA pass (Studio server, not the agent gateway); `current` is derived when read. */
  getQaReport(reportId: string): Promise<QaReport>;
  /** Same-origin URL of a project-relative render (`renders/<file>`). */
  renderFileUrl(renderPath: string): string;
  /** The project's start-from-chat intake, handed out once (Studio server); null when there is none. */
  claimIntake(): Promise<AgentIntake | null>;
}

// ── Response guards ──────────────────────────────────────────────────────────
// The gateway is OpenVids' own; these check the envelope a consumer dereferences,
// not every leaf, so a broken response fails here instead of deep inside render.

const isString = (value: unknown): value is string => typeof value === "string";
const isNumber = (value: unknown): value is number => typeof value === "number";

export function isChatSummary(value: unknown): value is ChatSummary {
  return (
    isRecord(value) &&
    isString(value.id) &&
    isString(value.title) &&
    isString(value.status) &&
    isNumber(value.updatedAt)
  );
}

export function isActiveTurn(value: unknown): value is ActiveTurnInfo {
  return isRecord(value) && isString(value.chatId) && isString(value.turnId);
}

function isListChatsResponse(value: unknown): value is ListChatsResponse {
  return (
    isRecord(value) &&
    Array.isArray(value.chats) &&
    value.chats.every(isChatSummary) &&
    (value.activeTurn === null || isActiveTurn(value.activeTurn))
  );
}

function isModelCatalog(value: unknown): value is AgentModelCatalog {
  return isRecord(value) && Array.isArray(value.models);
}

export function isChatState(value: unknown): value is ChatState {
  return (
    isRecord(value) &&
    isChatSummary(value.chat) &&
    Array.isArray(value.messages) &&
    Array.isArray(value.turns) &&
    Array.isArray(value.runs) &&
    isNumber(value.lastSeq)
  );
}

function isTurnSummary(value: unknown): value is TurnSummary {
  return isRecord(value) && isString(value.id) && isString(value.chatId) && isString(value.status);
}

function isStartTurnResponse(value: unknown): value is StartTurnResponse {
  return isRecord(value) && isTurnSummary(value.turn);
}

function isSteerTurnResponse(value: unknown): value is SteerTurnResponse {
  return isRecord(value) && isString(value.messageId);
}

function isRevertTurnResponse(value: unknown): value is RevertTurnResponse {
  if (!isRecord(value)) return false;
  if (value.ok === true) return isTurnSummary(value.turn);
  return (
    value.ok === false &&
    isRecord(value.conflict) &&
    Array.isArray(value.conflict.files) &&
    value.conflict.files.every(isString)
  );
}

function isModelConfig(value: unknown): value is ModelConfig {
  return (
    isRecord(value) &&
    (value.model === null || isRecord(value.model)) &&
    (value.thinking === null || isString(value.thinking))
  );
}

function isExecutionQuality(value: unknown): boolean {
  return (
    isRecord(value) &&
    EXECUTION_QUALITY_PRESETS.some((preset) => preset === value.preset) &&
    isRecord(value.custom)
  );
}

function isAutonomy(value: unknown): value is AutonomySettings {
  return (
    isRecord(value) &&
    isChatIntent(value.defaultIntent) &&
    typeof value.askBeforeLockedEdits === "boolean" &&
    typeof value.askBeforeDownloads === "boolean"
  );
}

export function isAgentSettings(value: unknown): value is AgentSettings {
  if (!isRecord(value) || !isModelConfig(value.director)) return false;
  const { specialists, jev } = value;
  return (
    isExecutionQuality(value.executionQuality) &&
    isAutonomy(value.autonomy) &&
    isRecord(specialists) &&
    SPECIALIST_IDS.every((id) => {
      const entry = specialists[id];
      return (
        isModelConfig(entry) &&
        isRecord(entry) &&
        Array.isArray(entry.allowedModels) &&
        typeof entry.enabledByDefault === "boolean"
      );
    }) &&
    isRecord(jev) &&
    typeof jev.enabled === "boolean" &&
    typeof jev.apiKeyConfigured === "boolean" &&
    isString(jev.credentials)
  );
}

function isTestJevResponse(value: unknown): value is TestJevResponse {
  if (!isRecord(value)) return false;
  if (value.ok === true) {
    return isRecord(value.model) && isString(value.reply) && isNumber(value.elapsedMs);
  }
  return value.ok === false && isString(value.message);
}

function isProviderOAuth(value: unknown): value is NonNullable<ProviderInfo["oauth"]> {
  return (
    isRecord(value) &&
    Array.isArray(value.flows) &&
    value.flows.every(
      (flow) =>
        isRecord(flow) &&
        OAUTH_FLOWS.some((known) => known === flow.flow) &&
        (flow.callbackPort === null || isNumber(flow.callbackPort)) &&
        typeof flow.fixedPort === "boolean",
    )
  );
}

function isProviderInfo(value: unknown): value is ProviderInfo {
  return (
    isRecord(value) &&
    isString(value.id) &&
    isString(value.name) &&
    typeof value.authenticated === "boolean" &&
    PROVIDER_STATUSES.some((status) => status === value.status) &&
    (value.credentialSource === null ||
      PROVIDER_CREDENTIAL_SOURCES.some((source) => source === value.credentialSource)) &&
    (value.error === null || isString(value.error)) &&
    isNumber(value.modelCount) &&
    typeof value.keyless === "boolean" &&
    typeof value.verified === "boolean" &&
    (value.oauth === undefined || value.oauth === null || isProviderOAuth(value.oauth))
  );
}

export function isProvidersResponse(value: unknown): value is ListProvidersResponse {
  return (
    isRecord(value) &&
    Array.isArray(value.providers) &&
    value.providers.every(isProviderInfo) &&
    (value.syncedAt === null || isNumber(value.syncedAt))
  );
}

function isProviderModelsResponse(value: unknown): value is ListProviderModelsResponse {
  return isRecord(value) && Array.isArray(value.models);
}

function isErrorBody(value: unknown): value is AgentErrorBody {
  return isRecord(value) && isRecord(value.error) && isString(value.error.message);
}

function isAgentErrorCode(value: unknown): value is AgentErrorCode {
  return isString(value) && (AGENT_ERROR_CODES as readonly string[]).includes(value);
}

async function readJson(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function failureFor(response: Response, body: unknown): AgentApiError {
  if (isErrorBody(body)) {
    const { code, message, details } = body.error;
    return new AgentApiError(
      isAgentErrorCode(code) ? code : "internal",
      message,
      response.status,
      details,
      readErrorParams(body.error.params),
    );
  }
  const code: AgentFailureCode = response.status === 503 ? "runtime_unavailable" : "internal";
  return new AgentApiError(
    code,
    t("agent.error.http", { status: response.status }),
    response.status,
  );
}

export interface AgentClientOptions {
  fetchImpl?: typeof fetch;
}

export function createAgentClient(
  projectId: string,
  { fetchImpl }: AgentClientOptions = {},
): AgentClient {
  const base = (suffix: string) => buildProjectApiPath(projectId, `/agent${suffix}`);

  async function request<T>(
    method: string,
    url: string,
    guard: (value: unknown) => value is T,
    body?: unknown,
  ): Promise<T> {
    let response: Response;
    try {
      const doFetch = fetchImpl ?? globalThis.fetch.bind(globalThis);
      response = await doFetch(url, {
        method,
        headers: body === undefined ? undefined : { "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch (error) {
      throw new AgentApiError(
        "network",
        error instanceof Error ? error.message : t("agent.error.networkRequest"),
      );
    }
    const payload = await readJson(response);
    if (!response.ok) throw failureFor(response, payload);
    if (!guard(payload)) {
      throw new AgentApiError("bad_response", t("agent.error.unexpectedResponse"), response.status);
    }
    return payload;
  }

  const call = <T>(
    method: string,
    suffix: string,
    guard: (value: unknown) => value is T,
    body?: unknown,
  ) => request(method, base(suffix), guard, body);

  const enc = encodeURIComponent;

  return {
    listChats: () => call("GET", "/chats", isListChatsResponse),
    listModels: () => call("GET", "/models", isModelCatalog),
    createChat: (request) => call("POST", "/chats", isChatSummary, request),
    getChat: (chatId) => call("GET", `/chats/${enc(chatId)}`, isChatState),
    updateChat: (chatId, request) => call("PATCH", `/chats/${enc(chatId)}`, isChatSummary, request),
    startTurn: (chatId, request) =>
      call("POST", `/chats/${enc(chatId)}/turns`, isStartTurnResponse, request),
    steerTurn: (chatId, turnId, request) =>
      call(
        "POST",
        `/chats/${enc(chatId)}/turns/${enc(turnId)}/steer`,
        isSteerTurnResponse,
        request,
      ),
    abortTurn: async (chatId, turnId) => {
      await call("POST", `/chats/${enc(chatId)}/turns/${enc(turnId)}/abort`, isRecord, {});
    },
    revertTurn: (chatId, turnId, request) =>
      call(
        "POST",
        `/chats/${enc(chatId)}/turns/${enc(turnId)}/revert`,
        isRevertTurnResponse,
        request,
      ),
    unrevertTurn: (chatId, turnId, request) =>
      call(
        "POST",
        `/chats/${enc(chatId)}/turns/${enc(turnId)}/unrevert`,
        isRevertTurnResponse,
        request,
      ),
    chatEventsUrl: (chatId, afterSeq) =>
      `${base(`/chats/${enc(chatId)}/events`)}?after=${afterSeq}`,
    projectEventsUrl: () => base("/events"),
    getSettings: () => call("GET", "/settings", isAgentSettings),
    updateSettings: (request) => call("PATCH", "/settings", isAgentSettings, request),
    setJevApiKey: (request) => call("POST", "/settings/jev/api-key", isAgentSettings, request),
    testJev: () => call("POST", "/settings/jev/test", isTestJevResponse, {}),
    listProviders: () => call("GET", "/providers", isProvidersResponse),
    refreshProviders: () => call("POST", "/providers/refresh", isProvidersResponse),
    setProviderApiKey: (provider, request) =>
      call("POST", `/providers/${enc(provider)}/api-key`, isProvidersResponse, request),
    startOAuthLogin: (provider, request) =>
      call("POST", `/providers/${enc(provider)}/oauth/login`, isOAuthLoginState, request),
    getOAuthLogin: (loginId) => call("GET", `/oauth/logins/${enc(loginId)}`, isOAuthLoginState),
    submitOAuthLoginInput: (loginId, request) =>
      call("POST", `/oauth/logins/${enc(loginId)}/input`, isOAuthLoginState, request),
    cancelOAuthLogin: (loginId) =>
      call("POST", `/oauth/logins/${enc(loginId)}/cancel`, isOAuthLoginState, {}),
    logoutProvider: (provider) =>
      call("POST", `/providers/${enc(provider)}/oauth/logout`, isProvidersResponse),
    listProviderModels: (provider) =>
      call("GET", `/providers/${enc(provider)}/models`, isProviderModelsResponse),
    getQaReport: (reportId) =>
      request("GET", buildProjectApiPath(projectId, `/qa/reports/${enc(reportId)}`), isQaReport),
    renderFileUrl: (renderPath) =>
      buildProjectApiPath(projectId, `/renders/file/${enc(renderPath.replace(/^renders\//, ""))}`),
    claimIntake: async () => {
      // 204 (no intake) reads as an empty object.
      const payload = await call("POST", "/intake/claim", isRecord, {});
      if (Object.keys(payload).length === 0) return null;
      const parsed = parseAgentIntake(payload);
      if (!parsed.ok) throw new AgentApiError("bad_response", parsed.message);
      return parsed.value;
    },
  };
}
