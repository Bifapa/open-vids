import { setTimeout as delay } from "node:timers/promises";
import { randomUUID } from "node:crypto";
import {
  isRecord,
  type SaveVoiceScriptRequest,
  type SetProjectVoiceRequest,
  type VoiceCheckRequest,
  type VoiceCheckResult,
  type VoiceDialect,
  type VoicePreset,
  type VoiceProviderInfo,
  type VoiceScriptView,
  type VoiceSynthesisProgress,
  type VoiceSynthesisRequest,
  type VoiceSynthesisResult,
} from "@hyperframes/agent-protocol";
import type { ProjectScope } from "../checkpointHost.js";
import {
  isVoiceCheckResult,
  isVoiceDialect,
  isVoicePreset,
  isVoiceProviderInfo,
  isVoiceScriptView,
  isVoiceSynthesisProgress,
  isVoiceSynthesisResult,
} from "./guards.js";
import { VoiceToolError, type VoiceHost } from "./host.js";
import { invalidResponse, VoiceTransport, type RequestOptions } from "./transport.js";

/**
 * How long each call may take before the runtime stops waiting. A synthesis calls the user's provider once per line or
 * scene (up to 500 lines), so it gets a long bound; everything else is a local read or write on Studio.
 */
export const VOICE_TIMEOUTS_MS = {
  read: 30_000,
  /** The dialect check and estimate read the cache and the pricing table. */
  check: 60_000,
  synthesize: 30 * 60_000,
} as const;

/** How often a running synthesis's progress is read. */
const PROGRESS_POLL_MS = 2_000;

export interface HttpVoiceHostOptions {
  /** Overrides {@link VOICE_TIMEOUTS_MS}. */
  timeoutsMs?: Partial<Record<keyof typeof VOICE_TIMEOUTS_MS, number>>;
  /** Overrides the write settle bound (`VOICE_SETTLE_MS`). */
  settleMs?: number;
  /** Overrides how often a running synthesis is polled for progress. */
  progressPollMs?: number;
}

/** Studio's voice HTTP API for one project (and the user's global providers, presets and dialects). */
export class HttpVoiceHost implements VoiceHost {
  private readonly global: string;
  private readonly project: string;
  private readonly timeoutsMs: Record<keyof typeof VOICE_TIMEOUTS_MS, number>;
  private readonly progressPollMs: number;
  private readonly transport: VoiceTransport;

  constructor(scope: ProjectScope, options: HttpVoiceHostOptions = {}) {
    this.global = `${scope.studioOrigin}/api/voice`;
    this.project = `${scope.studioOrigin}/api/projects/${encodeURIComponent(scope.projectId)}/voice`;
    this.timeoutsMs = { ...VOICE_TIMEOUTS_MS, ...options.timeoutsMs };
    this.progressPollMs = options.progressPollMs ?? PROGRESS_POLL_MS;
    this.transport = new VoiceTransport(options.settleMs);
  }

  async presets(signal: AbortSignal): Promise<VoicePreset[]> {
    const payload = await this.read("GET", `${this.global}/presets`, signal);
    if (
      !isRecord(payload) ||
      !Array.isArray(payload.presets) ||
      !payload.presets.every(isVoicePreset)
    )
      throw invalidResponse("preset list");
    return payload.presets;
  }

  async getPreset(id: string, signal: AbortSignal): Promise<VoicePreset | null> {
    return (await this.presets(signal)).find((preset) => preset.id === id) ?? null;
  }

  async providers(signal: AbortSignal): Promise<VoiceProviderInfo[]> {
    const payload = await this.read("GET", `${this.global}/providers`, signal);
    if (
      !isRecord(payload) ||
      !Array.isArray(payload.providers) ||
      !payload.providers.every(isVoiceProviderInfo)
    )
      throw invalidResponse("provider list");
    return payload.providers;
  }

  async dialects(signal: AbortSignal): Promise<VoiceDialect[]> {
    const payload = await this.read("GET", `${this.global}/dialects`, signal);
    if (
      !isRecord(payload) ||
      !Array.isArray(payload.dialects) ||
      !payload.dialects.every(isVoiceDialect)
    )
      throw invalidResponse("dialect list");
    return payload.dialects;
  }

  async script(signal: AbortSignal): Promise<VoiceScriptView> {
    const payload = await this.read("GET", `${this.project}/script`, signal);
    if (!isVoiceScriptView(payload)) throw invalidResponse("voice script");
    return payload;
  }

  async saveScript(request: SaveVoiceScriptRequest, signal: AbortSignal): Promise<VoiceScriptView> {
    const payload = await this.read("PUT", `${this.project}/script`, signal, request);
    if (!isVoiceScriptView(payload)) throw invalidResponse("voice script");
    return payload;
  }

  async setProjectVoice(presetId: string | null, signal: AbortSignal): Promise<VoiceScriptView> {
    const body: SetProjectVoiceRequest = { presetId };
    const payload = await this.read("PUT", `${this.project}/voice`, signal, body);
    if (!isVoiceScriptView(payload)) throw invalidResponse("voice script");
    return payload;
  }

  async check(request: VoiceCheckRequest, signal: AbortSignal): Promise<VoiceCheckResult> {
    const payload = await this.transport.request("POST", `${this.project}/check`, {
      body: request,
      signal,
      timeoutMs: this.timeoutsMs.check,
      onTimeout: "Studio did not answer the voice check in time.",
    });
    if (!isVoiceCheckResult(payload)) throw invalidResponse("voice check");
    return payload;
  }

  async synthesize(
    request: Omit<VoiceSynthesisRequest, "requestId">,
    signal: AbortSignal,
    onProgress?: (progress: VoiceSynthesisProgress) => void,
  ): Promise<VoiceSynthesisResult> {
    const requestId = randomUUID();
    const base = `${this.project}/requests/${encodeURIComponent(requestId)}`;
    // The progress poll ends with the write, whichever way it ends.
    const done = new AbortController();
    const poll = onProgress
      ? this.pollProgress(base, AbortSignal.any([signal, done.signal]), onProgress)
      : null;
    try {
      const payload = await this.transport.write(request, {
        url: `${this.project}/synthesize`,
        requestId,
        cancelUrl: `${base}/cancel`,
        label: "voice generation",
        signal,
        timeoutMs: this.timeoutsMs.synthesize,
        onTimeout:
          "The voice generation did not finish in time and was cancelled; lines that were already generated are kept. Check the script's takes before trying again.",
      });
      if (!isVoiceSynthesisResult(payload)) throw invalidResponse("voice generation result");
      return payload;
    } finally {
      done.abort();
      await poll;
    }
  }

  private read(
    method: "GET" | "PUT",
    url: string,
    signal: AbortSignal,
    body?: unknown,
  ): Promise<unknown> {
    const options: RequestOptions = {
      signal,
      timeoutMs: this.timeoutsMs.read,
      onTimeout: "Studio did not answer in time.",
      ...(body !== undefined && { body }),
    };
    return this.transport.request(method, url, options);
  }

  /** Reads the synthesis's progress every {@link PROGRESS_POLL_MS} until `signal` aborts; a failed read is skipped. */
  private async pollProgress(
    url: string,
    signal: AbortSignal,
    onProgress: (progress: VoiceSynthesisProgress) => void,
  ): Promise<void> {
    while (!signal.aborted) {
      // The delay rejects when `signal` aborts (listener and timer are released by the runtime): that ends the poll.
      const stopped = await delay(this.progressPollMs, false, { signal }).catch(() => true);
      if (stopped || signal.aborted) return;
      try {
        const payload = await this.read("GET", url, signal);
        if (isVoiceSynthesisProgress(payload)) onProgress(payload);
      } catch (error) {
        if (!(error instanceof VoiceToolError)) throw error;
      }
    }
  }
}
