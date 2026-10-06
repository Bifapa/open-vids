import {
  isRecord,
  isVoiceErrorCode,
  readErrorParams,
  type CodedMessageParams,
  type DesignVoiceRequest,
  type DesignVoiceResult,
  type SaveVoiceScriptRequest,
  type SelectVoiceTakeRequest,
  type SetProjectVoiceRequest,
  type UpdateVoiceProviderRequest,
  type VoiceCatalogPage,
  type VoiceCheckRequest,
  type VoiceCheckResult,
  type VoiceDialect,
  type VoiceErrorCode,
  type VoiceKeyCheckResult,
  type VoicePreset,
  type VoicePresetDraft,
  type VoiceProviderControls,
  type VoiceProviderId,
  type VoiceProviderInfo,
  type VoiceSampleRequest,
  type VoiceSampleResult,
  type VoiceScriptIssue,
  type VoiceScriptView,
  type VoiceSynthesisProgress,
  type VoiceSynthesisRequest,
  type VoiceSynthesisResult,
} from "@hyperframes/agent-protocol";
import { t } from "../i18n";
import { buildProjectApiPath } from "../utils/projectRouting";
import { describeVoiceError } from "./voiceErrors";
import {
  isCancelAnswer,
  isDesignVoiceResult,
  isDialectsAnswer,
  isOkAnswer,
  isPresetAnswer,
  isPresetsAnswer,
  isProviderAnswer,
  isProvidersAnswer,
  isVoiceCatalogPage,
  isVoiceCheckResult,
  isVoiceKeyCheckResult,
  isVoiceProviderControls,
  isVoiceSampleResult,
  isVoiceScriptView,
  isVoiceSynthesisProgress,
  isVoiceSynthesisResult,
} from "./voiceGuards";

/**
 * A failed voice request. `message` is Studio's wording for the server's `code` (`voice.error.<code>`), or the
 * server's own message for a code Studio does not know; `issues` carries a dialect violation's findings.
 */
export class VoiceApiError extends Error {
  readonly status: number;
  readonly code: VoiceErrorCode | null;
  readonly params: CodedMessageParams | undefined;
  readonly issues: VoiceScriptIssue[] | undefined;
  /** From the `Retry-After` header or the error's params, when the service said how long to wait. */
  readonly retryAfterSeconds: number | undefined;

  constructor(
    message: string,
    options: {
      status?: number;
      code?: VoiceErrorCode | null;
      params?: CodedMessageParams;
      issues?: VoiceScriptIssue[];
      retryAfterSeconds?: number;
    } = {},
  ) {
    super(message);
    this.name = "VoiceApiError";
    this.status = options.status ?? 0;
    this.code = options.code ?? null;
    this.params = options.params;
    this.issues = options.issues;
    this.retryAfterSeconds = options.retryAfterSeconds;
  }
}

/** The catalog query: the filters the user set, and where the last page ended. */
export interface VoiceCatalogQuery {
  /** Filter id → value; empty values are left out of the request. */
  filters: Readonly<Record<string, string>>;
  pageToken?: string | null;
  /** The model the catalog is for (some providers' voices depend on it); reserved name, never a filter id. */
  model?: string;
}

/** A preset to save, with the sample the user listened to (the cache entry's hash and the phrase it spoke). */
export interface SavePresetRequest {
  preset: Omit<VoicePresetDraft, "sample">;
  sampleHash?: string;
  sampleText?: string;
}

/**
 * The voice service as Studio sees it: the global providers, presets, catalog and samples (`/api/voice/…`), and one
 * project's script (`/api/projects/:id/voice/…`). The key goes to the server and never comes back: a provider only
 * says whether one is saved.
 */
export interface VoiceClient {
  providers(signal?: AbortSignal): Promise<VoiceProviderInfo[]>;
  updateProvider(
    id: VoiceProviderId,
    patch: UpdateVoiceProviderRequest,
  ): Promise<VoiceProviderInfo>;
  setApiKey(id: VoiceProviderId, key: string): Promise<VoiceProviderInfo>;
  removeApiKey(id: VoiceProviderId): Promise<VoiceProviderInfo>;
  /** Synthesizes a short phrase with the saved key: the key works, and the sample is what it sounds like. */
  checkProvider(id: VoiceProviderId): Promise<VoiceKeyCheckResult>;
  controls(
    id: VoiceProviderId,
    model?: string,
    signal?: AbortSignal,
  ): Promise<VoiceProviderControls>;
  voices(
    id: VoiceProviderId,
    query: VoiceCatalogQuery,
    signal?: AbortSignal,
  ): Promise<VoiceCatalogPage>;
  designVoice(id: VoiceProviderId, request: DesignVoiceRequest): Promise<DesignVoiceResult>;
  presets(signal?: AbortSignal): Promise<VoicePreset[]>;
  createPreset(request: SavePresetRequest): Promise<VoicePreset>;
  updatePreset(presetId: string, request: SavePresetRequest): Promise<VoicePreset>;
  deletePreset(presetId: string): Promise<void>;
  /** One synthesis of the user's own text with a draft preset: exactly the request a take makes. */
  sample(request: VoiceSampleRequest, signal?: AbortSignal): Promise<VoiceSampleResult>;
  /** Where a cache entry plays from. */
  audioUrl(hash: string): string;
  dialects(signal?: AbortSignal): Promise<VoiceDialect[]>;

  script(projectId: string, signal?: AbortSignal): Promise<VoiceScriptView>;
  saveScript(projectId: string, request: SaveVoiceScriptRequest): Promise<VoiceScriptView>;
  setProjectVoice(projectId: string, request: SetProjectVoiceRequest): Promise<VoiceScriptView>;
  check(projectId: string, request: VoiceCheckRequest): Promise<VoiceCheckResult>;
  /** Blocks until every asked line has a take (or fails); follow `progress` and stop with `cancel`. */
  synthesize(
    projectId: string,
    request: VoiceSynthesisRequest,
    signal?: AbortSignal,
  ): Promise<VoiceSynthesisResult>;
  progress(projectId: string, requestId: string): Promise<VoiceSynthesisProgress>;
  cancel(projectId: string, requestId: string): Promise<void>;
  selectTake(
    projectId: string,
    lineId: string,
    request: SelectVoiceTakeRequest,
  ): Promise<VoiceScriptView>;
}

const VOICE_URL = "/api/voice";

function failureOf(body: unknown, status: number, retryAfter: string | null): VoiceApiError {
  const header = retryAfter === null ? NaN : Number(retryAfter);
  const retryAfterSeconds = Number.isFinite(header) && header > 0 ? header : undefined;
  if (isRecord(body) && isRecord(body.error) && typeof body.error.message === "string") {
    const code =
      typeof body.error.code === "string" && isVoiceErrorCode(body.error.code)
        ? body.error.code
        : null;
    const params = readErrorParams(body.error.params);
    const issues = Array.isArray(body.error.issues)
      ? body.error.issues.filter(
          (issue): issue is VoiceScriptIssue =>
            isRecord(issue) &&
            typeof issue.code === "string" &&
            typeof issue.message === "string" &&
            (issue.severity === "error" || issue.severity === "warning") &&
            (issue.lineId === null || typeof issue.lineId === "string"),
        )
      : undefined;
    return new VoiceApiError(
      describeVoiceError(
        typeof body.error.code === "string" ? body.error.code : null,
        body.error.message,
        params,
        retryAfterSeconds,
      ),
      {
        status,
        code,
        ...(params && { params }),
        ...(issues && issues.length > 0 && { issues }),
        ...(retryAfterSeconds !== undefined && { retryAfterSeconds }),
      },
    );
  }
  return new VoiceApiError(t("voice.error.http", { status }), { status });
}

async function request<T>(
  fetchImpl: typeof fetch,
  url: string,
  guard: (value: unknown) => value is T,
  init?: RequestInit,
): Promise<T> {
  let response: Response;
  try {
    response = await fetchImpl(url, init);
  } catch (error) {
    // A cancelled request is the caller's own doing: it passes the abort through untouched.
    if (init?.signal?.aborted) throw error;
    throw new VoiceApiError(error instanceof Error ? error.message : t("voice.error.unreachable"));
  }
  const text = await response.text();
  let body: unknown;
  try {
    body = text ? JSON.parse(text) : undefined;
  } catch {
    body = undefined;
  }
  if (!response.ok) throw failureOf(body, response.status, response.headers.get("retry-after"));
  if (!guard(body))
    throw new VoiceApiError(t("voice.error.badResponse"), { status: response.status });
  return body;
}

function json(method: string, body?: unknown, signal?: AbortSignal): RequestInit {
  return {
    method,
    ...(body === undefined
      ? {}
      : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
    ...(signal && { signal }),
  };
}

const enc = encodeURIComponent;

export function createVoiceClient(fetchImpl?: typeof fetch): VoiceClient {
  const doFetch: typeof fetch = fetchImpl ?? ((input, init) => globalThis.fetch(input, init));
  const global = <T>(path: string, guard: (value: unknown) => value is T, init?: RequestInit) =>
    request(doFetch, `${VOICE_URL}${path}`, guard, init);
  const project = <T>(
    projectId: string,
    path: string,
    guard: (value: unknown) => value is T,
    init?: RequestInit,
  ) => request(doFetch, buildProjectApiPath(projectId, `/voice${path}`), guard, init);
  const provider = async (path: string, init?: RequestInit) =>
    (await global(path, isProviderAnswer, init)).provider;

  return {
    providers: async (signal) =>
      (await global("/providers", isProvidersAnswer, json("GET", undefined, signal))).providers,
    updateProvider: (id, patch) => provider(`/providers/${enc(id)}`, json("PUT", patch)),
    setApiKey: (id, key) => provider(`/providers/${enc(id)}/api-key`, json("PUT", { key })),
    removeApiKey: (id) => provider(`/providers/${enc(id)}/api-key`, json("DELETE")),
    checkProvider: (id) =>
      global(`/providers/${enc(id)}/check`, isVoiceKeyCheckResult, json("POST", {})),
    controls: (id, model, signal) =>
      global(
        `/providers/${enc(id)}/controls${model ? `?model=${enc(model)}` : ""}`,
        isVoiceProviderControls,
        json("GET", undefined, signal),
      ),
    voices: (id, query, signal) => {
      const params = new URLSearchParams();
      for (const [filter, value] of Object.entries(query.filters)) {
        if (value.trim() !== "") params.set(filter, value.trim());
      }
      if (query.model) params.set("model", query.model);
      if (query.pageToken) params.set("pageToken", query.pageToken);
      const search = params.toString();
      return global(
        `/providers/${enc(id)}/voices${search ? `?${search}` : ""}`,
        isVoiceCatalogPage,
        json("GET", undefined, signal),
      );
    },
    designVoice: (id, body) =>
      global(`/providers/${enc(id)}/voices`, isDesignVoiceResult, json("POST", body)),
    presets: async (signal) =>
      (await global("/presets", isPresetsAnswer, json("GET", undefined, signal))).presets,
    createPreset: async (body) =>
      (await global("/presets", isPresetAnswer, json("POST", body))).preset,
    updatePreset: async (presetId, body) =>
      (await global(`/presets/${enc(presetId)}`, isPresetAnswer, json("PUT", body))).preset,
    deletePreset: async (presetId) => {
      await global(`/presets/${enc(presetId)}`, isOkAnswer, json("DELETE"));
    },
    sample: (body, signal) => global("/sample", isVoiceSampleResult, json("POST", body, signal)),
    audioUrl: (hash) => `${VOICE_URL}/audio/${enc(hash)}`,
    dialects: async (signal) =>
      (await global("/dialects", isDialectsAnswer, json("GET", undefined, signal))).dialects,

    script: (projectId, signal) =>
      project(projectId, "/script", isVoiceScriptView, json("GET", undefined, signal)),
    saveScript: (projectId, body) =>
      project(projectId, "/script", isVoiceScriptView, json("PUT", body)),
    setProjectVoice: (projectId, body) =>
      project(projectId, "/voice", isVoiceScriptView, json("PUT", body)),
    check: (projectId, body) =>
      project(projectId, "/check", isVoiceCheckResult, json("POST", body)),
    synthesize: (projectId, body, signal) =>
      project(projectId, "/synthesize", isVoiceSynthesisResult, json("POST", body, signal)),
    progress: (projectId, requestId) =>
      project(projectId, `/requests/${enc(requestId)}`, isVoiceSynthesisProgress),
    cancel: async (projectId, requestId) => {
      await project(
        projectId,
        `/requests/${enc(requestId)}/cancel`,
        isCancelAnswer,
        json("POST", {}),
      );
    },
    selectTake: (projectId, lineId, body) =>
      project(projectId, `/lines/${enc(lineId)}/take`, isVoiceScriptView, json("PUT", body)),
  };
}
