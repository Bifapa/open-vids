/**
 * Voiceover: the OpenVids-owned contract for cloud text-to-speech with the user's own key.
 *
 * - **Providers** are global (per user) and fixed: Gemini (direct), OpenAI, OpenRouter, ElevenLabs and one custom
 *   OpenAI-compatible server. Their settings live in `~/.openvids/voice/providers.json`, their keys in
 *   `~/.openvids/voice/api-keys.json` (override `$OPENVIDS_VOICE_DIR`; owner-only, atomic, never served back). The
 *   Studio server and the Projects page (Rust) read and write the same files.
 * - A provider describes what it can do as **controls** ({@link VoiceControl}): the voice-setup window is built from
 *   them, so a new provider needs no new interface code. What a provider cannot do is simply absent.
 * - A **preset** ({@link VoicePreset}) is a configured voice: provider + model + voice + style + settings + the sample
 *   the user listened to. Global presets live in `~/.openvids/voice/presets.json`; a project carries a copy of its
 *   voice in `.hyperframes/voice/takes.json`, so the project keeps working without the library.
 * - A project's **script** ({@link VoiceScript}, `.hyperframes/voice/takes.json`, history-tracked) holds the lines:
 *   the source text (captions), the speaker text (what the model reads, tags included), takes and the chosen take.
 *   A take points at an audio file under `assets/voice/` AND a range in it, so one file generated for a whole scene
 *   serves several lines.
 * - Agents never send an address or a key: they pick a preset the user configured and send lines.
 */

import { isRecord, type Parsed } from "./validate.js";
import { type VoiceDialect, type VoiceDialectId, type VoiceScriptIssue } from "./voiceDialects.js";
import { SPECIALIST_IDS, type AgentId } from "./types.js";

// ── Providers ────────────────────────────────────────────────────────────────

export const VOICE_PROVIDER_IDS = [
  "gemini",
  "openai",
  "openrouter",
  "elevenlabs",
  "custom",
] as const;
export type VoiceProviderId = (typeof VOICE_PROVIDER_IDS)[number];

/** The wire protocol a provider speaks. */
export const VOICE_CONNECTORS = ["gemini", "openai_compatible", "elevenlabs"] as const;
export type VoiceConnector = (typeof VOICE_CONNECTORS)[number];

export function isVoiceProviderId(value: unknown): value is VoiceProviderId {
  return typeof value === "string" && VOICE_PROVIDER_IDS.some((id) => id === value);
}

/** A provider as Studio and the agents see it. The key itself never leaves the server. */
export interface VoiceProviderInfo {
  id: VoiceProviderId;
  connector: VoiceConnector;
  name: string;
  /** The API base the connector calls (fixed for the built-in providers; the user's for `custom`). */
  baseUrl: string;
  /** The model this provider uses unless a preset names another. */
  model: string;
  hasKey: boolean;
  /** The custom server may run without a key. */
  keyRequired: boolean;
  /** Ready to synthesize: a key when one is required, and for `custom` an address and a model. */
  configured: boolean;
  /** `custom`: the voice name the server expects, typed by the user. */
  voice: string;
  /** The user's "Rules for the agent", appended to the model's dialect. */
  agentRules: string;
  /** Gemini through OpenRouter: the voice catalog and voice design need a Google key. */
  notes: VoiceProviderNote[];
}

export type VoiceProviderNote = "catalog_needs_google_key" | "free_tier_terms";

/** What the user may change on a provider (never the base URL of a built-in one). */
export interface UpdateVoiceProviderRequest {
  model?: string;
  /**
   * `custom` only. Loopback is allowed. Written by the desktop app's Settings (Rust) only: Studio's route refuses it
   * (`desktop_only`), because composition code runs on Studio's origin.
   */
  baseUrl?: string;
  /** `custom` only. */
  voice?: string;
  agentRules?: string;
}

export const VOICE_LIMITS = {
  apiKeyChars: 4_096,
  baseUrlChars: 2_048,
  modelChars: 200,
  voiceIdChars: 200,
  agentRulesChars: 4_000,
  presetNameChars: 80,
  styleChars: 1_000,
  /** A voice description for voice design (Gemini: 1–2 clear sentences). */
  voiceDescriptionChars: 1_000,
  sampleTextChars: 500,
  lineChars: 10_000,
  lines: 500,
  /** Lines one scene request may carry. */
  sceneLines: 12,
  languageChars: 35,
  suggestionChars: 600,
} as const;

// ── Controls: the declarative voice-setup window ─────────────────────────────

/**
 * One control of the voice-setup window. Labels come from locale keys derived from the ids
 * (`voice.control.<id>`, `voice.filter.<id>`), so a new provider adds strings, never components.
 */
export type VoiceControl =
  /** Pick a voice from the provider's catalog. `preview`: how a voice is auditioned before any synthesis. */
  | { kind: "catalog"; filters: VoiceCatalogFilter[]; preview: "audio_url" | "synthesize" }
  /** Type the voice name (a custom server). */
  | { kind: "voice_text"; maxChars: number }
  /** Create a voice from a description; the answer carries an instant sample. */
  | { kind: "voice_design"; maxChars: number }
  /** A number setting sent with every request (`stability`, `similarity_boost`, `speed`…). `values`: only these. */
  | {
      kind: "slider";
      id: string;
      min: number;
      max: number;
      step: number;
      default: number;
      values?: number[];
    }
  | { kind: "toggle"; id: string; default: boolean }
  /** The delivery text: Gemini `style`, OpenAI `instructions`. */
  | { kind: "style"; target: "style" | "instructions"; maxChars: number };

export interface VoiceCatalogFilter {
  id: string;
  /** Fixed choices, or null for free text. */
  options: string[] | null;
}

export interface VoiceModelInfo {
  id: string;
  name: string;
  dialect: VoiceDialectId;
  /** The model is not one its dialect was written for (nearest family). */
  dialectApproximate: boolean;
  /** List price per minute of speech, from the pricing configuration; null when unknown. */
  usdPerMinute: number | null;
  /** The provider's per-request limit when stricter than the dialect's. */
  maxChars?: number;
}

/** `GET /api/voice/providers/:id/controls?model=` */
export interface VoiceProviderControls {
  provider: VoiceProviderInfo;
  models: VoiceModelInfo[];
  /** The model the controls are for. */
  model: string;
  controls: VoiceControl[];
  dialect: VoiceDialect;
}

/** One voice of a provider's catalog. */
export interface VoiceCatalogEntry {
  id: string;
  name: string;
  description: string | null;
  /** Free-form labels (gender, accent, age, persona…) by the provider's keys. */
  labels: Record<string, string>;
  languages: string[];
  /** A sample the provider hosts (listening costs nothing); null when the voice must be synthesized to be heard. */
  previewUrl: string | null;
  kind: VoiceKind;
}

export const VOICE_KINDS = ["prebuilt", "library", "designed", "custom"] as const;
export type VoiceKind = (typeof VOICE_KINDS)[number];

/** `GET /api/voice/providers/:id/voices?<filter>=…&pageToken=` */
export interface VoiceCatalogPage {
  voices: VoiceCatalogEntry[];
  nextPageToken: string | null;
}

/** `POST /api/voice/providers/:id/voices`: design a voice from a description (Gemini). */
export interface DesignVoiceRequest {
  name: string;
  description: string;
  language?: string;
  gender?: string;
  model?: string;
}

export interface DesignVoiceResult {
  voice: VoiceCatalogEntry;
  /** The instant sample the provider returned. */
  sample: VoiceAudioRef | null;
}

// ── Presets ──────────────────────────────────────────────────────────────────

export interface VoicePresetVoice {
  id: string;
  name: string;
  kind: VoiceKind;
  language?: string;
  /** Designed voices: the description, kept so the voice can be designed again when the provider expired it. */
  description?: string;
}

/** A sound served by the Studio server: a cache entry (`/api/voice/audio/:hash`) or a project file. */
export interface VoiceAudioRef {
  /** Path under the Studio API (`/api/voice/audio/<hash>`), for the UI to play. */
  url: string;
  hash: string;
  durationSeconds: number;
  mimeType: "audio/wav" | "audio/mpeg";
}

export interface VoicePresetSample {
  text: string;
  audio: VoiceAudioRef;
  createdAt: number;
}

export interface VoicePreset {
  id: string;
  name: string;
  providerId: VoiceProviderId;
  model: string;
  voice: VoicePresetVoice;
  /** Gemini `style` / OpenAI `instructions`; empty when the dialect has none. */
  style: string;
  /** Slider and toggle values by control id. */
  settings: Record<string, number | boolean>;
  sample: VoicePresetSample | null;
  createdAt: number;
  updatedAt: number;
}

/** A preset before it is saved: what the setup window holds while the user tries voices. */
export type VoicePresetDraft = Omit<VoicePreset, "id" | "createdAt" | "updatedAt" | "sample"> & {
  sample?: VoicePresetSample | null;
};

/** `POST /api/voice/sample`: one synthesis of the user's own text with a draft preset (the same request as a take). */
export interface VoiceSampleRequest {
  preset: VoicePresetDraft;
  text: string;
}

export interface VoiceSampleResult {
  audio: VoiceAudioRef;
  /** Served from the cache: nothing was paid. */
  cached: boolean;
  usdCost: number | null;
}

/** `POST /api/voice/providers/:id/check`: the key works (a short phrase was synthesized). */
export interface VoiceKeyCheckResult {
  ok: true;
  sample: VoiceAudioRef | null;
}

// ── Project script ───────────────────────────────────────────────────────────

export const VOICE_SCRIPT_PATH = ".hyperframes/voice/takes.json";
export const VOICE_SCRIPT_SCHEMA = "openvids.voice-takes/1";
/** Where generated audio is written (project-relative); Studio's media library reads it as Voice. */
export const VOICE_ASSET_DIR = "assets/voice";
/** The attribute a timeline clip carries for the line it speaks. */
export const VOICE_LINE_ATTRIBUTE = "data-ov-voice-line";
/** The audio group voiceover clips join (`<hf-audio-group id="voiceover">`). */
export const VOICEOVER_AUDIO_GROUP = "voiceover";

export interface VoiceTake {
  id: string;
  /** Project-relative audio file under `assets/voice/`. */
  file: string;
  /** The line's range in the file, seconds. A scene file serves several lines. */
  start: number;
  end: number;
  /** What was sent: the speaker text and style at generation time (the line is "changed" when they differ). */
  speakerText: string;
  style: string;
  presetId: string;
  model: string;
  voiceId: string;
  /** Cache key of the request that produced the file. */
  requestHash: string;
  /**
   * Hash of the single-line request that would give this line now (voice, model, effective style, settings,
   * language, the line's own text): everything that shapes the audio, without the neighbours. A selected take is
   * current only while it equals the line's fingerprint. Absent on takes from before it existed (never current).
   */
  fingerprint?: string;
  /** Set when the file is a scene (several lines in one request). */
  scene: string | null;
  /** Word timings relative to `start`, when known (scene split, captions). */
  words?: Array<{ text: string; start: number; end: number }>;
  usdCost: number | null;
  createdAt: number;
  createdBy: { agent: AgentId | "user"; turnId: string | null };
}

export interface VoiceLine {
  id: string;
  /** The source text: what captions show. */
  text: string;
  /** What the narrator reads, in the model's dialect (tags included). */
  speakerText: string;
  /** Per-line delivery override; empty uses the preset's. */
  style: string;
  /** Per-line voice; null uses the project's voice. */
  presetId: string | null;
  takes: VoiceTake[];
  selectedTakeId: string | null;
}

export interface VoiceScript {
  schema: typeof VOICE_SCRIPT_SCHEMA;
  /** BCP-47 language of the script, when known. */
  language: string | null;
  /** The project's voice: a copy of the preset, so the project keeps working without the library. */
  voice: VoicePreset | null;
  lines: VoiceLine[];
  updatedAt: number;
}

/** A line as the UI and the agents read it: the stored line plus what is derived when read. */
export interface VoiceLineView extends VoiceLine {
  /** The speaker text or style changed after the selected take was generated. */
  textChanged: boolean;
  /** The selected take's length, seconds. */
  durationSeconds: number | null;
  /** Ids of timeline clips that speak this line (`data-ov-voice-line`). */
  clipIds: string[];
}

/** `GET /api/projects/:id/voice/script` */
export interface VoiceScriptView {
  language: string | null;
  voice: VoicePreset | null;
  dialect: VoiceDialect | null;
  lines: VoiceLineView[];
}

/** A line as an agent or the UI sends it; an `id` keeps the line's takes when the text is unchanged. */
export interface VoiceLineInput {
  id?: string;
  text: string;
  speakerText?: string;
  style?: string;
}

/** `PUT /api/projects/:id/voice/script`: replaces the lines (takes of lines that kept their id survive). */
export interface SaveVoiceScriptRequest {
  language?: string | null;
  lines: VoiceLineInput[];
}

/** `PUT /api/projects/:id/voice/voice`: the project's voice (copied from a preset), or none. */
export interface SetProjectVoiceRequest {
  presetId: string | null;
}

/** `POST /api/projects/:id/voice/check`: dialect check + estimate, nothing paid. */
export interface VoiceCheckRequest {
  lineIds?: string[];
  presetId?: string;
  /** Estimate a forced regeneration (`VoiceSynthesisRequest.force`): the lines count as paid, never as cached. */
  force?: boolean;
}

export interface VoiceEstimate {
  lines: number;
  /** Lines already generated with the same request (cache or take): free. */
  cachedLines: number;
  requests: number;
  seconds: number;
  usdCost: number | null;
  /** Lines grouped into scene requests. */
  scene: boolean;
  /** Pace used, characters per second (from the preset's sample, else a default). */
  charsPerSecond: number;
}

export interface VoiceCheckResult {
  ok: boolean;
  issues: VoiceScriptIssue[];
  estimate: VoiceEstimate;
  dialect: VoiceDialect;
}

/** `POST /api/projects/:id/voice/synthesize` */
export interface VoiceSynthesisRequest {
  /** For cancel (`POST …/voice/requests/:requestId/cancel`) and progress (`GET …/voice/requests/:requestId`). */
  requestId: string;
  /** Default: every line without a current take. */
  lineIds?: string[];
  presetId?: string;
  /** Group lines into scene requests when the dialect allows; default true for Gemini. */
  scene?: boolean;
  /**
   * Regenerate: generate the lines again even when a current take exists, and bypass the voice cache for them (the
   * provider is asked again, its new reading replaces the cache entry and becomes a new take; earlier takes keep
   * their own project files). TTS is not deterministic, so this gives a different reading.
   */
  force?: boolean;
  /** Who asks, for provenance and history. */
  agent?: AgentId | "user";
  turnId?: string | null;
}

export interface VoiceSynthesisLineResult {
  lineId: string;
  take: VoiceTake;
  /** Served from the cache or an existing take: nothing was paid for this line. */
  cached: boolean;
  /** The audio is identical to a take the line already had (a provider that read it exactly the same way). */
  duplicate: boolean;
}

export interface VoiceSynthesisResult {
  lines: VoiceSynthesisLineResult[];
  requests: number;
  usdCost: number | null;
  /** Non-fatal notes: a scene that fell back to one request per line, an approximate dialect. */
  notes: string[];
}

export interface VoiceSynthesisProgress {
  requestId: string;
  state: "running" | "done" | "failed" | "cancelled";
  done: number;
  total: number;
  /** The line being generated. */
  lineId: string | null;
  /** Set while the request waits out the provider's per-minute rate limit: when it asks again (epoch ms). */
  waitingUntil?: number;
}

/** `PUT /api/projects/:id/voice/lines/:lineId/take` */
export interface SelectVoiceTakeRequest {
  takeId: string;
}

// ── Errors ───────────────────────────────────────────────────────────────────

export const VOICE_ERROR_CODES = [
  "invalid_request",
  "not_found",
  "not_configured",
  "invalid_key",
  "rate_limited",
  "quota_exhausted",
  "not_audio",
  "dialect_violation",
  "unsupported",
  "provider_error",
  "provider_unreachable",
  "transcription_unavailable",
  "cancelled",
  "conflict",
  /** A setting only the desktop app's own Settings may change (`params.key`); Studio's route refuses it. */
  "desktop_only",
] as const;
export type VoiceErrorCode = (typeof VOICE_ERROR_CODES)[number];

/**
 * The wire error. `rate_limited` carries `retryAfterSeconds` when the provider said, and `daily: 1` when the quota
 * is a daily one; `not_audio` carries `contentType` and `body` (the first 2 KB of what the server answered, as is);
 * `dialect_violation` carries the issues; keys never appear in any message.
 */
export interface VoiceErrorBody {
  error: {
    code: VoiceErrorCode;
    message: string;
    params?: Record<string, string | number>;
    issues?: VoiceScriptIssue[];
  };
}

export function isVoiceErrorCode(value: unknown): value is VoiceErrorCode {
  return typeof value === "string" && VOICE_ERROR_CODES.some((code) => code === value);
}

// ── Chat: voice setup and pilot ──────────────────────────────────────────────

/**
 * `request_voice_setup`: the agent asks the user to pick the project's voice. The chat shows a card: the project's
 * voice when it has one ("Use" / "Change"), a connect step when no provider is configured, else the setup window. The
 * call waits; the end of the turn expires it.
 */
export const VOICE_SETUP_STATES = ["pending", "answered", "declined", "expired"] as const;
export type VoiceSetupState = (typeof VOICE_SETUP_STATES)[number];

export interface VoiceSetupRequest {
  id: string;
  agent: AgentId;
  /** BCP-47 language of the script, to filter the catalog. */
  language: string | null;
  /** The phrase every sample speaks: the script's first sentence. */
  sampleText: string;
  /** The agent's proposal for the voice's character ("warm, mid-30s, calm"). */
  suggestion: string;
  state: VoiceSetupState;
  /** The chosen preset (answered). */
  presetId?: string;
  presetName?: string;
  requestedAt: number;
  answeredAt?: number;
}

export interface VoiceSetupPart {
  type: "voice-setup";
  id: string;
  setup: VoiceSetupRequest;
}

/** `POST …/turns/:turnId/voice-setups/:id` */
export type AnswerVoiceSetupRequest = { presetId: string } | { decline: true };

/**
 * The pilot line of a generation: played in the chat; the rest is generated only after "Continue". "Change" sends
 * the user's note back to the agent.
 */
export const VOICE_PILOT_STATES = ["pending", "approved", "changes", "expired"] as const;
export type VoicePilotState = (typeof VOICE_PILOT_STATES)[number];

export interface VoicePilotRequest {
  id: string;
  agent: AgentId;
  lineId: string;
  text: string;
  /** The take's file and range, played through the project's file route. */
  file: string;
  start: number;
  end: number;
  /** Lines still to generate after the pilot, and their estimate. */
  remainingLines: number;
  remainingUsdCost: number | null;
  state: VoicePilotState;
  /** "Change": what the user wants different. */
  feedback?: string;
  requestedAt: number;
  answeredAt?: number;
}

export interface VoicePilotPart {
  type: "voice-pilot";
  id: string;
  pilot: VoicePilotRequest;
}

/** `POST …/turns/:turnId/voice-pilots/:id` */
export type AnswerVoicePilotRequest =
  | { decision: "approve" }
  | { decision: "change"; feedback: string };

// ── Parsers (wire bodies) ────────────────────────────────────────────────────

const fail = (message: string): { ok: false; message: string } => ({ ok: false, message });

function boundedText(value: unknown, max: number, field: string, required = false): Parsed<string> {
  if (value === undefined && !required) return { ok: true, value: "" };
  if (typeof value !== "string") return fail(`${field} must be a string`);
  if (required && value.trim().length === 0) return fail(`${field} is required`);
  if (value.length > max) return fail(`${field} is longer than ${max} characters`);
  return { ok: true, value };
}

export function parseUpdateVoiceProviderRequest(body: unknown): Parsed<UpdateVoiceProviderRequest> {
  if (!isRecord(body)) return fail("body must be an object");
  const out: UpdateVoiceProviderRequest = {};
  const fields: Array<[keyof UpdateVoiceProviderRequest, number]> = [
    ["model", VOICE_LIMITS.modelChars],
    ["baseUrl", VOICE_LIMITS.baseUrlChars],
    ["voice", VOICE_LIMITS.voiceIdChars],
    ["agentRules", VOICE_LIMITS.agentRulesChars],
  ];
  for (const [field, max] of fields) {
    if (body[field] === undefined) continue;
    const text = boundedText(body[field], max, field);
    if (!text.ok) return text;
    out[field] = text.value.trim();
  }
  if (out.baseUrl !== undefined && out.baseUrl.length > 0) {
    let url: URL;
    try {
      url = new URL(out.baseUrl);
    } catch {
      return fail("baseUrl is not a URL");
    }
    if (url.protocol !== "http:" && url.protocol !== "https:")
      return fail("baseUrl must be http(s)");
    if (url.username || url.password) return fail("baseUrl must not carry credentials");
    if (url.search || url.hash || /[?#]/.test(out.baseUrl))
      return fail("baseUrl must not carry a query string or a fragment");
  }
  return { ok: true, value: out };
}

function parseSettings(value: unknown): Parsed<Record<string, number | boolean>> {
  if (value === undefined) return { ok: true, value: {} };
  if (!isRecord(value)) return fail("settings must be an object");
  const settings: Record<string, number | boolean> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (!/^[a-z][a-z0-9_]{0,40}$/.test(key)) return fail(`settings.${key} is not a control id`);
    if (typeof entry === "boolean" || (typeof entry === "number" && Number.isFinite(entry)))
      settings[key] = entry;
    else return fail(`settings.${key} must be a number or a boolean`);
  }
  return { ok: true, value: settings };
}

function parsePresetVoice(value: unknown): Parsed<VoicePresetVoice> {
  if (!isRecord(value)) return fail("voice must be an object");
  const id = boundedText(value.id, VOICE_LIMITS.voiceIdChars, "voice.id", true);
  if (!id.ok) return id;
  const name = boundedText(
    value.name ?? value.id,
    VOICE_LIMITS.presetNameChars,
    "voice.name",
    true,
  );
  if (!name.ok) return name;
  const kind = VOICE_KINDS.find((k) => k === value.kind);
  if (!kind) return fail("voice.kind is unknown");
  const voice: VoicePresetVoice = { id: id.value.trim(), name: name.value.trim(), kind };
  if (typeof value.language === "string" && value.language.length <= VOICE_LIMITS.languageChars)
    voice.language = value.language;
  if (value.description !== undefined) {
    const description = boundedText(
      value.description,
      VOICE_LIMITS.voiceDescriptionChars,
      "voice.description",
    );
    if (!description.ok) return description;
    if (description.value.trim().length > 0) voice.description = description.value.trim();
  }
  return { ok: true, value: voice };
}

/** A preset draft as the setup window sends it (sample excluded: the server attaches samples it made itself). */
export function parseVoicePresetDraft(body: unknown): Parsed<Omit<VoicePresetDraft, "sample">> {
  if (!isRecord(body)) return fail("preset must be an object");
  const name = boundedText(body.name, VOICE_LIMITS.presetNameChars, "name", true);
  if (!name.ok) return name;
  if (!isVoiceProviderId(body.providerId)) return fail("providerId is unknown");
  const model = boundedText(body.model, VOICE_LIMITS.modelChars, "model", true);
  if (!model.ok) return model;
  const voice = parsePresetVoice(body.voice);
  if (!voice.ok) return voice;
  const style = boundedText(body.style, VOICE_LIMITS.styleChars, "style");
  if (!style.ok) return style;
  const settings = parseSettings(body.settings);
  if (!settings.ok) return settings;
  return {
    ok: true,
    value: {
      name: name.value.trim(),
      providerId: body.providerId,
      model: model.value.trim(),
      voice: voice.value,
      style: style.value.trim(),
      settings: settings.value,
    },
  };
}

export function parseVoiceSampleRequest(
  body: unknown,
): Parsed<{ preset: Omit<VoicePresetDraft, "sample">; text: string }> {
  if (!isRecord(body)) return fail("body must be an object");
  const preset = parseVoicePresetDraft(body.preset);
  if (!preset.ok) return preset;
  const text = boundedText(body.text, VOICE_LIMITS.sampleTextChars, "text", true);
  if (!text.ok) return text;
  return { ok: true, value: { preset: preset.value, text: text.value.trim() } };
}

export function parseDesignVoiceRequest(body: unknown): Parsed<DesignVoiceRequest> {
  if (!isRecord(body)) return fail("body must be an object");
  const name = boundedText(body.name, VOICE_LIMITS.presetNameChars, "name", true);
  if (!name.ok) return name;
  const description = boundedText(
    body.description,
    VOICE_LIMITS.voiceDescriptionChars,
    "description",
    true,
  );
  if (!description.ok) return description;
  const out: DesignVoiceRequest = {
    name: name.value.trim(),
    description: description.value.trim(),
  };
  for (const field of ["language", "gender", "model"] as const) {
    const value = body[field];
    if (value === undefined) continue;
    const text = boundedText(value, VOICE_LIMITS.modelChars, field);
    if (!text.ok) return text;
    if (text.value.trim().length > 0) out[field] = text.value.trim();
  }
  return { ok: true, value: out };
}

function parseLineInput(value: unknown, index: number): Parsed<VoiceLineInput> {
  if (!isRecord(value)) return fail(`lines[${index}] must be an object`);
  const text = boundedText(value.text, VOICE_LIMITS.lineChars, `lines[${index}].text`, true);
  if (!text.ok) return text;
  const line: VoiceLineInput = { text: text.value.trim() };
  if (value.id !== undefined) {
    if (typeof value.id !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(value.id))
      return fail(`lines[${index}].id must be 1–64 letters, digits, - or _`);
    line.id = value.id;
  }
  if (value.speakerText !== undefined) {
    const speaker = boundedText(
      value.speakerText,
      VOICE_LIMITS.lineChars,
      `lines[${index}].speakerText`,
      true,
    );
    if (!speaker.ok) return speaker;
    line.speakerText = speaker.value.trim();
  }
  if (value.style !== undefined) {
    const style = boundedText(value.style, VOICE_LIMITS.styleChars, `lines[${index}].style`);
    if (!style.ok) return style;
    line.style = style.value.trim();
  }
  return { ok: true, value: line };
}

export function parseSaveVoiceScriptRequest(body: unknown): Parsed<SaveVoiceScriptRequest> {
  if (!isRecord(body)) return fail("body must be an object");
  if (!Array.isArray(body.lines)) return fail("lines must be an array");
  if (body.lines.length > VOICE_LIMITS.lines) return fail(`at most ${VOICE_LIMITS.lines} lines`);
  const lines: VoiceLineInput[] = [];
  const ids = new Set<string>();
  for (const [index, value] of body.lines.entries()) {
    const line = parseLineInput(value, index);
    if (!line.ok) return line;
    if (line.value.id !== undefined) {
      if (ids.has(line.value.id)) return fail(`line id ${line.value.id} is used twice`);
      ids.add(line.value.id);
    }
    lines.push(line.value);
  }
  const out: SaveVoiceScriptRequest = { lines };
  if (body.language === null) out.language = null;
  else if (body.language !== undefined) {
    const language = boundedText(body.language, VOICE_LIMITS.languageChars, "language");
    if (!language.ok) return language;
    out.language = language.value.trim() || null;
  }
  return { ok: true, value: out };
}

function parseLineIds(value: unknown): Parsed<string[] | undefined> {
  if (value === undefined) return { ok: true, value: undefined };
  if (!Array.isArray(value) || value.length > VOICE_LIMITS.lines)
    return fail("lineIds must be an array of ids");
  const ids: string[] = [];
  for (const id of value) {
    if (typeof id !== "string" || id.length === 0 || id.length > 64)
      return fail("lineIds must be an array of ids");
    ids.push(id);
  }
  return { ok: true, value: ids };
}

export function parseVoiceCheckRequest(body: unknown): Parsed<VoiceCheckRequest> {
  const value = body === undefined || body === null ? {} : body;
  if (!isRecord(value)) return fail("body must be an object");
  const lineIds = parseLineIds(value.lineIds);
  if (!lineIds.ok) return lineIds;
  const out: VoiceCheckRequest = {};
  if (lineIds.value) out.lineIds = lineIds.value;
  if (typeof value.presetId === "string" && value.presetId.length > 0)
    out.presetId = value.presetId;
  if (typeof value.force === "boolean") out.force = value.force;
  return { ok: true, value: out };
}

export function parseVoiceSynthesisRequest(body: unknown): Parsed<VoiceSynthesisRequest> {
  if (!isRecord(body)) return fail("body must be an object");
  if (typeof body.requestId !== "string" || !/^[A-Za-z0-9_-]{8,128}$/.test(body.requestId))
    return fail("requestId is required");
  const lineIds = parseLineIds(body.lineIds);
  if (!lineIds.ok) return lineIds;
  const out: VoiceSynthesisRequest = { requestId: body.requestId };
  if (lineIds.value) out.lineIds = lineIds.value;
  if (typeof body.presetId === "string" && body.presetId.length > 0) out.presetId = body.presetId;
  if (typeof body.scene === "boolean") out.scene = body.scene;
  if (typeof body.force === "boolean") out.force = body.force;
  if (typeof body.turnId === "string" && body.turnId.length <= 128) out.turnId = body.turnId;
  // The agent is a label for provenance: the runtime sets it, Studio sends "user".
  if (body.agent === "user" || body.agent === "director" || body.agent === "jev")
    out.agent = body.agent;
  else {
    const specialist = SPECIALIST_IDS.find((id) => id === body.agent);
    if (specialist) out.agent = specialist;
  }
  return { ok: true, value: out };
}

export function parseAnswerVoiceSetupRequest(body: unknown): Parsed<AnswerVoiceSetupRequest> {
  if (!isRecord(body)) return fail("body must be an object");
  if (body.decline === true) return { ok: true, value: { decline: true } };
  if (typeof body.presetId === "string" && body.presetId.length > 0 && body.presetId.length <= 64)
    return { ok: true, value: { presetId: body.presetId } };
  return fail("presetId or decline is required");
}

export function parseAnswerVoicePilotRequest(body: unknown): Parsed<AnswerVoicePilotRequest> {
  if (!isRecord(body)) return fail("body must be an object");
  if (body.decision === "approve") return { ok: true, value: { decision: "approve" } };
  if (body.decision === "change") {
    const feedback = boundedText(body.feedback, 2_000, "feedback", true);
    if (!feedback.ok) return feedback;
    return { ok: true, value: { decision: "change", feedback: feedback.value.trim() } };
  }
  return fail("decision must be approve or change");
}

export function isVoiceSetupRequest(value: unknown): value is VoiceSetupRequest {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.agent === "string" &&
    (value.language === null || typeof value.language === "string") &&
    typeof value.sampleText === "string" &&
    typeof value.suggestion === "string" &&
    VOICE_SETUP_STATES.some((state) => state === value.state) &&
    typeof value.requestedAt === "number"
  );
}

export function isVoicePilotRequest(value: unknown): value is VoicePilotRequest {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.agent === "string" &&
    typeof value.lineId === "string" &&
    typeof value.text === "string" &&
    typeof value.file === "string" &&
    typeof value.start === "number" &&
    typeof value.end === "number" &&
    typeof value.remainingLines === "number" &&
    VOICE_PILOT_STATES.some((state) => state === value.state) &&
    typeof value.requestedAt === "number"
  );
}
