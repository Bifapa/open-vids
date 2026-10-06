/**
 * Internal seams of the voice service. Connectors speak one provider's wire protocol; the engine
 * (`engine.ts`) puts the key store, the cache and the audio normalisation around them. Project code
 * (`project/`) only ever talks to the engine.
 */

import type {
  DesignVoiceRequest,
  VoiceCatalogPage,
  VoiceControl,
  VoiceModelInfo,
  VoicePresetDraft,
  VoicePresetVoice,
  VoiceProviderInfo,
} from "@hyperframes/agent-protocol";
import type { VoicePriceTerms } from "./pricing.js";

/** What a connector needs to call its provider. The key is only ever passed here, never logged or returned. */
export interface ConnectorContext {
  provider: VoiceProviderInfo;
  /** null when the provider has no key (a custom server without one). */
  apiKey: string | null;
  signal: AbortSignal;
  fetch: typeof fetch;
}

/** One synthesis call. `text` is the speaker text (dialect tags included); `style` goes where the dialect says. */
export interface ConnectorSynthesisInput {
  model: string;
  voice: VoicePresetVoice;
  style: string;
  settings: Record<string, number | boolean>;
  text: string;
  /** Neighbouring text for providers that use it for continuity (ElevenLabs `previous_text` / `next_text`). */
  previousText?: string;
  nextText?: string;
  language?: string;
}

/** Raw bytes as the provider answered, with what is known of their format. */
export interface ConnectorAudio {
  bytes: Uint8Array;
  /** `audio/wav`, `audio/mpeg`, or `audio/pcm` (s16le mono at `sampleRate`). */
  format: "wav" | "mp3" | "pcm";
  sampleRate?: number;
  /** Provider-reported cost/usage, when it says (ElevenLabs `character-cost`, Gemini `usage`). */
  usage?: { characters?: number; inputTokens?: number; outputTokens?: number };
}

/**
 * A model a connector lists. `listedPrice`: the price list the provider published for it (OpenRouter), which the
 * engine hands to the pricing module.
 */
export type ConnectorModel = Omit<VoiceModelInfo, "usdPerMinute"> & {
  listedPrice?: VoicePriceTerms;
};

export interface VoiceConnectorImpl {
  /** Models the provider offers for speech (static list or the provider's listing). */
  models(ctx: ConnectorContext): Promise<ConnectorModel[]>;
  /** The controls of the setup window for a model. Pure: no network. */
  controls(provider: VoiceProviderInfo, model: string): VoiceControl[];
  /** The catalog, when the provider has one (`catalog` control present). */
  voices?(
    ctx: ConnectorContext,
    filters: Record<string, string>,
    pageToken: string | null,
  ): Promise<VoiceCatalogPage>;
  /** Voice design, when the provider has it (`voice_design` control present). */
  designVoice?(
    ctx: ConnectorContext,
    request: DesignVoiceRequest,
  ): Promise<{ voice: VoicePresetVoice & { previewUrl?: null }; sample: ConnectorAudio | null }>;
  synthesize(ctx: ConnectorContext, input: ConnectorSynthesisInput): Promise<ConnectorAudio>;
  /** A cheap authenticated call proving the key (no synthesis when the provider has one). */
  checkKey(ctx: ConnectorContext): Promise<void>;
}

/** The engine's synthesis answer: a normalised file in the global cache. */
export interface EngineAudio {
  /** Absolute path of the cached file (`<voice dir>/cache/<hash>.<wav|mp3>`). */
  path: string;
  hash: string;
  mimeType: "audio/wav" | "audio/mpeg";
  durationSeconds: number;
  cached: boolean;
  usdCost: number | null;
}

/** What the project service asks the engine for. */
export interface EngineSynthesisInput {
  preset: Omit<VoicePresetDraft, "name" | "sample">;
  text: string;
  style?: string;
  previousText?: string;
  nextText?: string;
  language?: string;
  signal: AbortSignal;
}
