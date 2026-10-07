import { createHash } from "node:crypto";
import {
  dialectForModel,
  VOICE_DIALECTS,
  VOICE_LIMITS,
  type DesignVoiceRequest,
  type DesignVoiceResult,
  type UpdateVoiceProviderRequest,
  type VoiceAudioRef,
  type VoiceCatalogPage,
  type VoiceConnector,
  type VoiceControl,
  type VoiceKeyCheckResult,
  type VoiceModelInfo,
  type VoicePreset,
  type VoicePresetDraft,
  type VoicePresetSample,
  type VoiceProviderControls,
  type VoiceProviderId,
  type VoiceProviderInfo,
  type VoiceSampleRequest,
  type VoiceSampleResult,
} from "@hyperframes/agent-protocol";
import type { FfprobeRunner } from "../helpers/mediaMetadata.js";
import { normalizeAudio } from "./audio.js";
import { isCacheHash, VoiceCache, type CacheEntry } from "./cache.js";
import { elevenLabsConnector } from "./connectors/elevenlabs.js";
import { geminiConnector } from "./connectors/gemini.js";
import { openaiCompatibleConnector } from "./connectors/openaiCompatible.js";
import { isVoiceFailure, scrubFailure, scrubSecret, VoiceFailure } from "./errors.js";
import { VoicePricing } from "./pricing.js";
import { voiceDir } from "./paths.js";
import { VoiceKeyStore } from "./store/keys.js";
import { VoicePresetStore } from "./store/presets.js";
import { VoiceProviderStore } from "./store/providers.js";
import type {
  ConnectorAudio,
  ConnectorContext,
  EngineAudio,
  EngineSynthesisInput,
  VoiceConnectorImpl,
  VoiceFetch,
} from "./types.js";

/** The engine as the project layer sees it. */
export interface VoiceEngine {
  /** One synthesis: the cache first, the provider when the request was never made. */
  synthesize(input: EngineSynthesisInput): Promise<EngineAudio>;
  /** The request's hash and its cache entry when there is one; no network, nothing paid. */
  peek(input: Omit<EngineSynthesisInput, "signal">): { hash: string; audio: EngineAudio | null };
  provider(id: VoiceProviderId): VoiceProviderInfo;
  preset(id: string): Promise<VoicePreset | null>;
  /** USD for `chars` of text and `seconds` of speech; null when the price is unknown. */
  estimateCost(
    providerId: VoiceProviderId,
    model: string,
    usage: { chars: number; seconds: number },
  ): number | null;
  /** Absolute path of a cached file, or null. */
  audioPath(hash: string): string | null;
  /**
   * The models of a provider with their list prices. OpenRouter's prices come from its listing: call this before
   * {@link VoiceEngine.estimateCost} for it.
   */
  models(providerId: VoiceProviderId, signal?: AbortSignal): Promise<VoiceModelInfo[]>;
}

export interface VoiceEngineOptions {
  /** The voice directory (default {@link voiceDir}). */
  dir?: string;
  fetch?: VoiceFetch;
  now?: () => number;
  /** The ffprobe runner of the duration probe. */
  probe?: FfprobeRunner;
  /** Connectors by wire protocol, for tests. */
  connectors?: Partial<Record<VoiceConnector, VoiceConnectorImpl>>;
}

/** How long a provider's model list is reused. */
const MODELS_TTL_MS = 10 * 60 * 1_000;
const KEY_PATTERN = /^[\x21-\x7e]{1,4096}$/;
const CHECK_PHRASE = "Your voice connection works.";
/** The voice a key check speaks when the provider has a fixed one. */
const CHECK_VOICES: Partial<Record<VoiceProviderId, string>> = { gemini: "Kore", openai: "alloy" };

const VENDOR_HINT: Record<VoiceProviderId, "gemini" | "openai" | "elevenlabs" | null> = {
  gemini: "gemini",
  openai: "openai",
  openrouter: null,
  elevenlabs: "elevenlabs",
  custom: null,
};

interface Prepared {
  hash: string;
  provider: VoiceProviderInfo;
  model: string;
  input: EngineSynthesisInput;
  style: string;
  settings: Record<string, number | boolean>;
}

interface Job {
  promise: Promise<EngineAudio>;
  controller: AbortController;
  waiters: number;
}

function sanitizeSettings(
  controls: VoiceControl[],
  settings: Record<string, number | boolean>,
): Record<string, number | boolean> {
  const out: Record<string, number | boolean> = {};
  for (const control of controls) {
    if (control.kind === "toggle") {
      const value = settings[control.id];
      if (typeof value === "boolean") out[control.id] = value;
    } else if (control.kind === "slider") {
      const value = settings[control.id];
      if (typeof value !== "number" || !Number.isFinite(value)) continue;
      let next = Math.min(control.max, Math.max(control.min, value));
      if (control.values && control.values.length > 0) {
        next = control.values.reduce(
          (best, candidate) =>
            Math.abs(candidate - next) < Math.abs(best - next) ? candidate : best,
          control.values[0] ?? next,
        );
      }
      out[control.id] = Math.round(next * 1e6) / 1e6;
    }
  }
  // Sorted keys: the settings are part of the request hash.
  return Object.fromEntries(Object.entries(out).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

export class VoiceEngineImpl implements VoiceEngine {
  readonly dir: string;
  readonly keys: VoiceKeyStore;
  readonly providers: VoiceProviderStore;
  readonly presets: VoicePresetStore;
  readonly cache: VoiceCache;
  readonly pricing: VoicePricing;
  private readonly fetchImpl: VoiceFetch;
  private readonly now: () => number;
  private readonly connectors: Record<VoiceConnector, VoiceConnectorImpl>;
  private readonly inflight = new Map<string, Job>();
  private readonly modelCache = new Map<string, { at: number; models: VoiceModelInfo[] }>();

  constructor(options: VoiceEngineOptions = {}) {
    this.dir = options.dir ?? voiceDir();
    this.now = options.now ?? Date.now;
    this.fetchImpl = options.fetch ?? ((input, init) => globalThis.fetch(input, init));
    this.keys = new VoiceKeyStore(this.dir);
    this.providers = new VoiceProviderStore(this.dir, this.keys);
    this.presets = new VoicePresetStore(this.dir, this.now);
    this.cache = new VoiceCache(this.dir, options.probe);
    this.pricing = new VoicePricing(this.dir, this.now);
    this.connectors = {
      gemini: options.connectors?.gemini ?? geminiConnector,
      openai_compatible: options.connectors?.openai_compatible ?? openaiCompatibleConnector,
      elevenlabs: options.connectors?.elevenlabs ?? elevenLabsConnector,
    };
  }

  // ── Providers and keys ─────────────────────────────────────────────────────

  listProviders(): VoiceProviderInfo[] {
    return (["gemini", "openai", "openrouter", "elevenlabs", "custom"] as const).map((id) =>
      this.providers.info(id),
    );
  }

  provider(id: VoiceProviderId): VoiceProviderInfo {
    return this.providers.info(id);
  }

  /**
   * Applies a provider update from Studio. The custom server's address is not Studio's to write: composition code
   * runs on Studio's origin and could point it at its own server to read the key. Only the desktop app's Settings
   * (the shell, token-guarded) writes `baseUrl`.
   */
  updateProvider(id: VoiceProviderId, request: UpdateVoiceProviderRequest): VoiceProviderInfo {
    if (request.baseUrl !== undefined)
      throw new VoiceFailure(
        "desktop_only",
        "The custom server address can only be changed from the desktop app's Settings.",
        { key: "baseUrl" },
      );
    const info = this.providers.update(id, request);
    this.dropModels(id);
    return info;
  }

  /** Stores a key (trimmed, printable ASCII, 1–4096 characters). The key is never answered back. */
  setKey(id: VoiceProviderId, key: string): VoiceProviderInfo {
    const trimmed = key.trim();
    if (trimmed.length > VOICE_LIMITS.apiKeyChars || !KEY_PATTERN.test(trimmed))
      throw new VoiceFailure(
        "invalid_request",
        "The API key is empty or has characters a key cannot have.",
      );
    this.keys.set(id, trimmed);
    this.dropModels(id);
    return this.providers.info(id);
  }

  removeKey(id: VoiceProviderId): VoiceProviderInfo {
    this.keys.remove(id);
    this.dropModels(id);
    return this.providers.info(id);
  }

  private dropModels(id: VoiceProviderId): void {
    for (const key of [...this.modelCache.keys()])
      if (key.startsWith(`${id}|`)) this.modelCache.delete(key);
  }

  private connector(provider: VoiceProviderInfo): VoiceConnectorImpl {
    return this.connectors[provider.connector];
  }

  private context(provider: VoiceProviderInfo, signal: AbortSignal): ConnectorContext {
    return { provider, apiKey: this.keys.get(provider.id), signal, fetch: this.fetchImpl };
  }

  private requireConfigured(provider: VoiceProviderInfo): void {
    if (!provider.configured)
      throw new VoiceFailure(
        "not_configured",
        provider.id === "custom"
          ? "The custom server needs an address and a model."
          : `${provider.name} needs an API key.`,
        { providerId: provider.id },
      );
  }

  /** Runs a connector call; whatever it throws leaves with the key scrubbed out. */
  private async guarded<T>(ctx: ConnectorContext, run: () => Promise<T>): Promise<T> {
    try {
      return await run();
    } catch (error) {
      if (isVoiceFailure(error)) throw scrubFailure(error, ctx.apiKey);
      const message = error instanceof Error ? error.message : "The provider call failed.";
      throw new VoiceFailure("provider_error", scrubSecret(message, ctx.apiKey));
    }
  }

  // ── Models and controls ────────────────────────────────────────────────────

  async models(
    providerId: VoiceProviderId,
    signal: AbortSignal = new AbortController().signal,
  ): Promise<VoiceModelInfo[]> {
    const provider = this.providers.info(providerId);
    const cacheKey = `${providerId}|${provider.baseUrl}|${provider.model}|${provider.hasKey}`;
    const cached = this.modelCache.get(cacheKey);
    if (cached && this.now() - cached.at < MODELS_TTL_MS) return cached.models;
    const ctx = this.context(provider, signal);
    const listed = await this.guarded(ctx, () => this.connector(provider).models(ctx));
    const day = this.now();
    const models: VoiceModelInfo[] = listed.map(({ listedPrice, ...model }) => {
      if (listedPrice)
        this.pricing.setListed(providerId, model.id, listedPrice, `${provider.baseUrl}/models`);
      return { ...model, usdPerMinute: this.pricing.usdPerMinute(providerId, model.id, day) };
    });
    // The model the user configured is always offered, listed or not.
    if (provider.model.length > 0 && !models.some((model) => model.id === provider.model)) {
      const match = dialectForModel(provider.model, VENDOR_HINT[providerId]);
      models.push({
        id: provider.model,
        name: provider.model,
        dialect: match.dialect,
        dialectApproximate: match.approximate,
        usdPerMinute: this.pricing.usdPerMinute(providerId, provider.model, day),
      });
    }
    this.modelCache.set(cacheKey, { at: this.now(), models });
    return models;
  }

  /** The setup-window controls for a model (default: the provider's model). */
  async controls(
    providerId: VoiceProviderId,
    requestedModel: string | undefined,
    signal: AbortSignal = new AbortController().signal,
  ): Promise<VoiceProviderControls> {
    const provider = this.providers.info(providerId);
    const model = requestedModel && requestedModel.length > 0 ? requestedModel : provider.model;
    const models = [...(await this.models(providerId, signal))];
    if (!models.some((entry) => entry.id === model)) {
      const match = dialectForModel(model, VENDOR_HINT[providerId]);
      models.push({
        id: model,
        name: model,
        dialect: match.dialect,
        dialectApproximate: match.approximate,
        usdPerMinute: this.pricing.usdPerMinute(providerId, model),
      });
    }
    const info = models.find((entry) => entry.id === model);
    const dialect =
      VOICE_DIALECTS[info?.dialect ?? dialectForModel(model, VENDOR_HINT[providerId]).dialect];
    return {
      provider,
      models,
      model,
      controls: this.connector(provider).controls(provider, model),
      dialect,
    };
  }

  // ── Catalog and voice design ───────────────────────────────────────────────

  /** `filters.model` (reserved) names the model whose voices are wanted, for providers whose voices depend on it. */
  async voices(
    providerId: VoiceProviderId,
    filters: Record<string, string>,
    pageToken: string | null,
    signal: AbortSignal,
  ): Promise<VoiceCatalogPage> {
    const provider = this.providers.info(providerId);
    const connector = this.connector(provider);
    const model = filters.model && filters.model.length > 0 ? filters.model : provider.model;
    if (!connector.voices || !connector.controls(provider, model).some((c) => c.kind === "catalog"))
      throw new VoiceFailure("unsupported", `${provider.name} has no voice catalog.`);
    this.requireConfigured(provider);
    const ctx = this.context(provider, signal);
    return this.guarded(ctx, () => {
      if (!connector.voices) throw new VoiceFailure("unsupported", "No voice catalog.");
      return connector.voices(ctx, filters, pageToken);
    });
  }

  /** Voice design (Gemini): the new voice and its instant sample, which goes into the cache like a synthesis. */
  async designVoice(
    providerId: VoiceProviderId,
    request: DesignVoiceRequest,
    signal: AbortSignal,
  ): Promise<DesignVoiceResult> {
    const provider = this.providers.info(providerId);
    const connector = this.connector(provider);
    const model = request.model ?? provider.model;
    if (
      !connector.designVoice ||
      !connector.controls(provider, model).some((c) => c.kind === "voice_design")
    )
      throw new VoiceFailure("unsupported", `${provider.name} cannot design voices for ${model}.`);
    this.requireConfigured(provider);
    const ctx = this.context(provider, signal);
    const designed = await this.guarded(ctx, () => {
      if (!connector.designVoice) throw new VoiceFailure("unsupported", "No voice design.");
      return connector.designVoice(ctx, request);
    });
    let sample: VoiceAudioRef | null = null;
    if (designed.sample) {
      const hash = this.hashOf({
        providerId,
        baseUrl: provider.baseUrl,
        model,
        voiceId: designed.voice.id,
        style: "",
        settings: {},
        text: "",
        previousText: "",
        nextText: "",
        language: "",
      });
      const entry = await this.store(hash, designed.sample, providerId, model, 0, null);
      sample = this.cache.ref(entry);
    }
    return {
      voice: {
        id: designed.voice.id,
        name: designed.voice.name,
        description: request.description,
        labels: request.gender ? { gender: request.gender } : {},
        languages: designed.voice.language ? [designed.voice.language] : [],
        previewUrl: null,
        kind: "designed",
      },
      sample,
    };
  }

  // ── Key check ──────────────────────────────────────────────────────────────

  /**
   * Proves the key with the provider's cheap call, then speaks a short phrase with a voice of the provider so the
   * user hears the connection work. A sample that fails after a good key does not fail the check.
   */
  async checkKey(providerId: VoiceProviderId, signal: AbortSignal): Promise<VoiceKeyCheckResult> {
    const provider = this.providers.info(providerId);
    this.requireConfigured(provider);
    const ctx = this.context(provider, signal);
    await this.guarded(ctx, () => this.connector(provider).checkKey(ctx));
    try {
      const voiceId = await this.checkVoice(provider, signal);
      if (!voiceId) return { ok: true, sample: null };
      const audio = await this.synthesize({
        preset: {
          providerId,
          model: provider.model,
          voice: { id: voiceId, name: voiceId, kind: "prebuilt" },
          style: "",
          settings: {},
        },
        text: CHECK_PHRASE,
        signal,
      });
      return { ok: true, sample: this.refOf(audio) };
    } catch (error) {
      if (isVoiceFailure(error) && (error.code === "cancelled" || error.code === "invalid_key"))
        throw error;
      return { ok: true, sample: null };
    }
  }

  private async checkVoice(
    provider: VoiceProviderInfo,
    signal: AbortSignal,
  ): Promise<string | null> {
    const fixed = CHECK_VOICES[provider.id];
    if (fixed) return fixed;
    if (provider.id === "custom") return provider.voice.length > 0 ? provider.voice : null;
    const page = await this.voices(provider.id, {}, null, signal);
    return page.voices[0]?.id ?? null;
  }

  // ── Presets ────────────────────────────────────────────────────────────────

  listPresets(): VoicePreset[] {
    return this.presets.list();
  }

  async preset(id: string): Promise<VoicePreset | null> {
    return this.presets.get(id);
  }

  /** The reference of a cache entry, or null when the hash names none. */
  audioRef(hash: string): VoiceAudioRef | null {
    const entry = this.cache.entry(hash);
    return entry ? this.cache.ref(entry) : null;
  }

  /**
   * A sample can only be a sound this server made: `sampleHash` must name a complete cache entry. `undefined` keeps
   * the saved sample of an update (while the voice is unchanged), `null` drops it.
   */
  private sampleOf(
    sampleHash: string | null | undefined,
    sampleText: string | undefined,
  ): VoicePresetSample | null | undefined {
    if (sampleHash === undefined || sampleHash === null) return sampleHash;
    const audio = isCacheHash(sampleHash) ? this.audioRef(sampleHash) : null;
    if (!audio)
      throw new VoiceFailure("invalid_request", "The sample is not a sound this server generated.");
    if (!sampleText || sampleText.trim().length === 0)
      throw new VoiceFailure("invalid_request", "A sample needs the text that was spoken.");
    return { text: sampleText, audio, createdAt: this.now() };
  }

  createPreset(
    draft: Omit<VoicePresetDraft, "sample">,
    options: { sampleHash?: string | null; sampleText?: string },
  ): VoicePreset {
    return this.presets.create(
      draft,
      this.sampleOf(options.sampleHash, options.sampleText) ?? null,
    );
  }

  updatePreset(
    id: string,
    draft: Omit<VoicePresetDraft, "sample">,
    options: { sampleHash?: string | null; sampleText?: string },
  ): VoicePreset {
    return this.presets.update(id, draft, this.sampleOf(options.sampleHash, options.sampleText));
  }

  deletePreset(id: string): void {
    this.presets.remove(id);
  }

  // ── Synthesis ──────────────────────────────────────────────────────────────

  estimateCost(
    providerId: VoiceProviderId,
    model: string,
    usage: { chars: number; seconds: number },
  ): number | null {
    return this.pricing.estimateUsd(providerId, model, usage.chars, usage.seconds);
  }

  audioPath(hash: string): string | null {
    return this.cache.entry(hash)?.path ?? null;
  }

  /** `POST /voice/sample`: exactly the request a take would make. */
  async sample(request: VoiceSampleRequest, signal: AbortSignal): Promise<VoiceSampleResult> {
    const audio = await this.synthesize({ preset: request.preset, text: request.text, signal });
    return { audio: this.refOf(audio), cached: audio.cached, usdCost: audio.usdCost };
  }

  private refOf(audio: EngineAudio): VoiceAudioRef {
    return {
      url: `/api/voice/audio/${audio.hash}`,
      hash: audio.hash,
      durationSeconds: audio.durationSeconds,
      mimeType: audio.mimeType,
    };
  }

  private hashOf(request: {
    providerId: string;
    baseUrl: string;
    model: string;
    voiceId: string;
    style: string;
    settings: Record<string, number | boolean>;
    text: string;
    previousText: string;
    nextText: string;
    language: string;
  }): string {
    // Key order is the contract: {v, providerId, baseUrl, model, voiceId, style, settings, text, previousText,
    // nextText, language}; `settings` has its keys sorted.
    const canonical = JSON.stringify({
      v: 1,
      providerId: request.providerId,
      baseUrl: request.baseUrl,
      model: request.model,
      voiceId: request.voiceId,
      style: request.style,
      settings: request.settings,
      text: request.text,
      previousText: request.previousText,
      nextText: request.nextText,
      language: request.language,
    });
    return createHash("sha256").update(canonical).digest("hex");
  }

  private prepare(
    input: Omit<EngineSynthesisInput, "signal"> & { signal?: AbortSignal },
  ): Omit<Prepared, "input"> {
    const provider = this.providers.info(input.preset.providerId);
    const model = input.preset.model.length > 0 ? input.preset.model : provider.model;
    const text = input.text.trim();
    if (text.length === 0) throw new VoiceFailure("invalid_request", "There is no text to speak.");
    const controls = this.connector(provider).controls(provider, model);
    const styleControl = controls.find((control) => control.kind === "style");
    const requestedStyle = (input.style?.trim() || input.preset.style.trim()).trim();
    if (styleControl && requestedStyle.length > styleControl.maxChars)
      throw new VoiceFailure(
        "invalid_request",
        `The style is longer than ${styleControl.maxChars} characters.`,
      );
    // A model with no style field ignores the style, so it must not split the cache.
    const style = styleControl ? requestedStyle : "";
    const settings = sanitizeSettings(controls, input.preset.settings);
    const hash = this.hashOf({
      providerId: provider.id,
      baseUrl: provider.baseUrl,
      model,
      voiceId: input.preset.voice.id,
      style,
      settings,
      text,
      previousText: input.previousText ?? "",
      nextText: input.nextText ?? "",
      language: input.language ?? "",
    });
    return { hash, provider, model, style, settings };
  }

  peek(input: Omit<EngineSynthesisInput, "signal">): { hash: string; audio: EngineAudio | null } {
    const { hash } = this.prepare(input);
    const entry = this.cache.entry(hash);
    return { hash, audio: entry ? this.audioOf(entry, true) : null };
  }

  private audioOf(entry: CacheEntry, cached: boolean): EngineAudio {
    return {
      path: entry.path,
      hash: entry.hash,
      mimeType: entry.mimeType,
      durationSeconds: entry.durationSeconds,
      cached,
      usdCost: cached ? 0 : entry.usdCost,
    };
  }

  async synthesize(input: EngineSynthesisInput): Promise<EngineAudio> {
    const prepared: Prepared = { ...this.prepare(input), input };
    const hit = input.fresh === true ? null : this.cache.entry(prepared.hash);
    if (hit) return this.audioOf(hit, true);
    this.requireConfigured(prepared.provider);
    // A fresh request never joins a cached-style call already in flight: it wants its own reading.
    const key = input.fresh === true ? `fresh\0${prepared.hash}` : prepared.hash;
    return this.join(key, input.signal, (signal) => this.generate(prepared, signal));
  }

  /** Identical requests in flight share one provider call; it is cancelled when every caller has given up. */
  private join(
    hash: string,
    signal: AbortSignal,
    run: (signal: AbortSignal) => Promise<EngineAudio>,
  ): Promise<EngineAudio> {
    let job = this.inflight.get(hash);
    if (!job || job.controller.signal.aborted) {
      const controller = new AbortController();
      const started: Job = {
        controller,
        waiters: 0,
        promise: run(controller.signal).finally(() => {
          if (this.inflight.get(hash) === started) this.inflight.delete(hash);
        }),
      };
      this.inflight.set(hash, started);
      job = started;
    }
    const shared = job;
    shared.waiters += 1;
    return new Promise<EngineAudio>((resolve, reject) => {
      const onAbort = (): void => {
        shared.waiters -= 1;
        if (shared.waiters === 0) shared.controller.abort();
        reject(new VoiceFailure("cancelled", "The request was cancelled."));
      };
      if (signal.aborted) {
        onAbort();
        return;
      }
      signal.addEventListener("abort", onAbort, { once: true });
      shared.promise.then(
        (audio) => {
          signal.removeEventListener("abort", onAbort);
          resolve(audio);
        },
        (error: unknown) => {
          signal.removeEventListener("abort", onAbort);
          reject(error);
        },
      );
    });
  }

  private async generate(prepared: Prepared, signal: AbortSignal): Promise<EngineAudio> {
    const { provider, model, input } = prepared;
    const ctx = this.context(provider, signal);
    const raw = await this.guarded(ctx, () =>
      this.connector(provider).synthesize(ctx, {
        model,
        voice: input.preset.voice,
        style: prepared.style,
        settings: prepared.settings,
        text: input.text.trim(),
        ...(input.previousText && { previousText: input.previousText }),
        ...(input.nextText && { nextText: input.nextText }),
        ...(input.language && { language: input.language }),
      }),
    );
    const entry = await this.store(
      prepared.hash,
      raw,
      provider.id,
      model,
      input.text.trim().length,
      ctx.apiKey,
    );
    return this.audioOf(entry, false);
  }

  /** Normalises provider audio and writes it to the cache; a provider's non-audio answer becomes `not_audio`. */
  private async store(
    hash: string,
    raw: ConnectorAudio,
    providerId: VoiceProviderId,
    model: string,
    chars: number,
    apiKey: string | null,
  ): Promise<CacheEntry> {
    try {
      const normalized = normalizeAudio(raw);
      const at = this.now();
      return await this.cache.store(hash, normalized, {
        providerId,
        model,
        now: at,
        cost: (seconds) => this.pricing.estimateUsd(providerId, model, chars, seconds, at),
      });
    } catch (error) {
      if (isVoiceFailure(error)) throw scrubFailure(error, apiKey);
      throw error;
    }
  }
}

export function createVoiceEngine(options: VoiceEngineOptions = {}): VoiceEngineImpl {
  return new VoiceEngineImpl(options);
}
