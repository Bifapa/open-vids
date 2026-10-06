import { vi, type Mock } from "vitest";
import {
  VOICE_DIALECTS,
  type VoiceAudioRef,
  type VoiceCatalogEntry,
  type VoiceCatalogPage,
  type VoiceControl,
  type VoiceModelInfo,
  type VoicePreset,
  type VoiceProviderControls,
  type VoiceProviderInfo,
  type VoiceScriptView,
} from "@hyperframes/agent-protocol";
import { createVoiceStore, type VoiceStore } from "./voiceStore";
import type { VoiceClient } from "./voiceClient";

export function audioRef(overrides: Partial<VoiceAudioRef> = {}): VoiceAudioRef {
  return {
    url: "/api/voice/audio/" + "a".repeat(64),
    hash: "a".repeat(64),
    durationSeconds: 2.4,
    mimeType: "audio/wav",
    ...overrides,
  };
}

export function providerInfo(overrides: Partial<VoiceProviderInfo> = {}): VoiceProviderInfo {
  return {
    id: "gemini",
    connector: "gemini",
    name: "Gemini",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta",
    model: "gemini-3.8-flash-tts",
    hasKey: true,
    keyRequired: true,
    configured: true,
    voice: "",
    agentRules: "",
    notes: [],
    ...overrides,
  };
}

/** Every provider of the product, none configured: what the server answers on a fresh install. */
export function freshProviders(): VoiceProviderInfo[] {
  const bare = { hasKey: false, configured: false };
  return [
    providerInfo({ ...bare, notes: ["free_tier_terms"] }),
    providerInfo({
      ...bare,
      id: "openai",
      connector: "openai_compatible",
      name: "OpenAI",
      model: "gpt-4o-mini-tts",
    }),
    providerInfo({
      ...bare,
      id: "openrouter",
      connector: "openai_compatible",
      name: "OpenRouter",
      model: "google/gemini-3.8-flash-tts",
      notes: ["catalog_needs_google_key"],
    }),
    providerInfo({
      ...bare,
      id: "elevenlabs",
      connector: "elevenlabs",
      name: "ElevenLabs",
      model: "eleven_v4",
    }),
    providerInfo({
      ...bare,
      id: "custom",
      connector: "openai_compatible",
      name: "Custom server",
      baseUrl: "",
      model: "",
      keyRequired: false,
    }),
  ];
}

export function modelInfo(overrides: Partial<VoiceModelInfo> = {}): VoiceModelInfo {
  return {
    id: "gemini-3.8-flash-tts",
    name: "Gemini 3.8 Flash TTS",
    dialect: "gemini-tts",
    dialectApproximate: false,
    usdPerMinute: 0.0135,
    ...overrides,
  };
}

/** Gemini's controls: a catalog (with a language filter), voice design, and a style field. */
export const GEMINI_CONTROLS: VoiceControl[] = [
  {
    kind: "catalog",
    preview: "synthesize",
    filters: [
      { id: "language_code", options: null },
      { id: "gender", options: ["female", "male", "neutral"] },
    ],
  },
  { kind: "voice_design", maxChars: 1000 },
  { kind: "style", target: "style", maxChars: 200 },
];

/** ElevenLabs' controls: a catalog with free demos, sliders and a switch, and no style field. */
export const ELEVEN_CONTROLS: VoiceControl[] = [
  { kind: "catalog", preview: "audio_url", filters: [{ id: "search", options: null }] },
  { kind: "slider", id: "stability", min: 0, max: 1, step: 0.05, default: 0.5 },
  { kind: "slider", id: "similarity_boost", min: 0, max: 1, step: 0.05, default: 0.75 },
  { kind: "toggle", id: "use_speaker_boost", default: true },
];

export function providerControls(
  overrides: Partial<VoiceProviderControls> = {},
): VoiceProviderControls {
  return {
    provider: providerInfo(),
    models: [
      modelInfo(),
      modelInfo({ id: "gemini-3.8-flash-lite-tts", name: "Flash-Lite", usdPerMinute: 0.009 }),
    ],
    model: "gemini-3.8-flash-tts",
    controls: GEMINI_CONTROLS,
    dialect: VOICE_DIALECTS["gemini-tts"],
    ...overrides,
  };
}

export function catalogEntry(overrides: Partial<VoiceCatalogEntry> = {}): VoiceCatalogEntry {
  return {
    id: "Kore",
    name: "Kore",
    description: "Firm",
    labels: { gender: "female", accent: "neutral" },
    languages: ["en-US"],
    previewUrl: null,
    kind: "prebuilt",
    ...overrides,
  };
}

export function catalogPage(voices: VoiceCatalogEntry[] = [catalogEntry()]): VoiceCatalogPage {
  return { voices, nextPageToken: null };
}

export function voicePreset(overrides: Partial<VoicePreset> = {}): VoicePreset {
  return {
    id: "preset1",
    name: "Warm narrator",
    providerId: "gemini",
    model: "gemini-3.8-flash-tts",
    voice: { id: "Kore", name: "Kore", kind: "prebuilt", language: "en-US" },
    style: "warm, unhurried",
    settings: {},
    sample: { text: "Hello there.", audio: audioRef(), createdAt: 1000 },
    createdAt: 1000,
    updatedAt: 1000,
    ...overrides,
  };
}

export function scriptView(overrides: Partial<VoiceScriptView> = {}): VoiceScriptView {
  return {
    language: "en",
    voice: null,
    dialect: null,
    lines: [],
    ...overrides,
  };
}

type Methods = {
  [K in keyof VoiceClient]: Mock<VoiceClient[K]>;
};

/** A voice client whose every call is a spy; `data` seeds what the reads answer. */
export interface FakeVoice {
  client: VoiceClient;
  calls: Methods;
  store: VoiceStore;
}

export interface FakeVoiceData {
  providers?: VoiceProviderInfo[];
  presets?: VoicePreset[];
  controls?: VoiceProviderControls;
  /** What the catalog answers; an `Error` makes every read fail with it. */
  catalog?: VoiceCatalogPage | Error;
  script?: VoiceScriptView;
}

export function createFakeVoice(data: FakeVoiceData = {}): FakeVoice {
  let providers = data.providers ?? [providerInfo()];
  let presets = data.presets ?? [];
  const replace = (provider: VoiceProviderInfo) => {
    providers = providers.map((known) => (known.id === provider.id ? provider : known));
    return provider;
  };
  const find = (id: string) => {
    const provider = providers.find((known) => known.id === id);
    if (!provider) throw new Error(`no provider ${id}`);
    return provider;
  };
  const calls: Methods = {
    providers: vi.fn(async () => providers),
    updateProvider: vi.fn(async (id, patch) => replace({ ...find(id), ...patch })),
    setApiKey: vi.fn(async (id) => replace({ ...find(id), hasKey: true, configured: true })),
    removeApiKey: vi.fn(async (id) => replace({ ...find(id), hasKey: false, configured: false })),
    checkProvider: vi.fn(async () => ({ ok: true as const, sample: audioRef() })),
    controls: vi.fn(async () => data.controls ?? providerControls()),
    voices: vi.fn(async () => {
      if (data.catalog instanceof Error) throw data.catalog;
      return data.catalog ?? catalogPage();
    }),
    designVoice: vi.fn(async () => ({
      voice: catalogEntry({ id: "voice_1", name: "Astronomer", kind: "designed" }),
      sample: audioRef({ hash: "b".repeat(64), url: "/api/voice/audio/" + "b".repeat(64) }),
    })),
    presets: vi.fn(async () => presets),
    createPreset: vi.fn(async ({ preset, sampleHash, sampleText }) => {
      const created = voicePreset({
        ...preset,
        id: `preset${presets.length + 1}`,
        sample:
          sampleHash && sampleText
            ? { text: sampleText, audio: audioRef({ hash: sampleHash }), createdAt: 2000 }
            : null,
      });
      presets = [...presets, created];
      return created;
    }),
    updatePreset: vi.fn(async (id, { preset }) => {
      const updated = voicePreset({ ...presets.find((known) => known.id === id), ...preset, id });
      presets = presets.map((known) => (known.id === id ? updated : known));
      return updated;
    }),
    deletePreset: vi.fn(async (id) => {
      presets = presets.filter((known) => known.id !== id);
    }),
    sample: vi.fn(async () => ({ audio: audioRef(), cached: false, usdCost: 0.0004 })),
    audioUrl: vi.fn((hash) => `/api/voice/audio/${hash}`),
    dialects: vi.fn(async () => Object.values(VOICE_DIALECTS)),
    script: vi.fn(async () => data.script ?? scriptView()),
    saveScript: vi.fn(async () => data.script ?? scriptView()),
    setProjectVoice: vi.fn(async () => data.script ?? scriptView()),
    check: vi.fn(async () => {
      throw new Error("not used");
    }),
    synthesize: vi.fn(async () => {
      throw new Error("not used");
    }),
    progress: vi.fn(async () => {
      throw new Error("not used");
    }),
    cancel: vi.fn(async () => undefined),
    selectTake: vi.fn(async () => data.script ?? scriptView()),
  };
  const client: VoiceClient = calls;
  return { client, calls, store: createVoiceStore(client) };
}
