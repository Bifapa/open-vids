import {
  dialectForModel,
  isRecord,
  VOICE_DIALECTS,
  type VoiceCatalogEntry,
  type VoiceCatalogFilter,
  type VoiceCatalogPage,
  type VoiceControl,
  type VoiceKind,
  type VoiceProviderInfo,
} from "@hyperframes/agent-protocol";
import { VoiceFailure } from "../errors.js";
import type {
  ConnectorAudio,
  ConnectorContext,
  ConnectorModel,
  ConnectorSynthesisInput,
  VoiceConnectorImpl,
} from "../types.js";
import {
  audioFromResponse,
  failureFor,
  pickString,
  readFailureBody,
  readJson,
  retryAfterFromHeaders,
  send,
  SYNTHESIS_TIMEOUT_MS,
} from "./http.js";

/**
 * ElevenLabs text-to-speech (https://elevenlabs.io/docs/api-reference/text-to-speech/convert), models, voices and
 * the subscription endpoint. Built from the official docs; no live key was available.
 */

/** Which voice settings a model family takes; unsupported settings are left out, not sent. */
type Family = "v4" | "v3" | "v2";

const SETTING_KEYS: Record<Family, readonly string[]> = {
  v4: ["stability", "similarity_boost"],
  v3: ["stability"],
  v2: ["stability", "similarity_boost", "style", "use_speaker_boost", "speed"],
};
/** Documented: "Values below 1.0 … a minimum of 0.7. Values above 1.0 … maximum of 1.2". */
const SPEED_RANGE = { min: 0.7, max: 1.2 };
const VOICES_PAGE_SIZE = 30;
const VOICE_FILTERS: VoiceCatalogFilter[] = [
  { id: "search", options: null },
  { id: "category", options: ["premade", "cloned", "generated", "professional"] },
  { id: "gender", options: null },
  { id: "age", options: null },
  { id: "accent", options: null },
  { id: "language", options: null },
  { id: "use_case", options: null },
];
/** The wire name of a filter when it differs from its id. */
const FILTER_PARAMS: Record<string, string> = { use_case: "use_cases" };
/** Models listed when the API cannot be asked (no key yet, or the listing failed). */
const STATIC_MODELS = [
  { id: "eleven_v4", name: "Eleven v4", maxChars: 10_000 },
  { id: "eleven_v3", name: "Eleven v3", maxChars: 5_000 },
  { id: "eleven_multilingual_v2", name: "Eleven Multilingual v2", maxChars: 10_000 },
  { id: "eleven_flash_v2_5", name: "Eleven Flash v2.5", maxChars: 40_000 },
];

export function elevenLabsFamily(model: string): Family {
  if (/^eleven_v4/.test(model)) return "v4";
  if (/^eleven_v3/.test(model)) return "v3";
  return "v2";
}

function headers(ctx: ConnectorContext): Record<string, string> {
  return ctx.apiKey ? { "xi-api-key": ctx.apiKey } : {};
}

interface Described {
  failure: VoiceFailure;
  code: string;
  message: string;
  status: number;
}

/** `detail` is an object (`{type, code, message, status}`) or, for validation errors, an array of `{loc, msg, type}`. */
async function describe(ctx: ConnectorContext, response: Response): Promise<Described> {
  const { text, json } = await readFailureBody(response);
  const detail = isRecord(json) ? json.detail : undefined;
  let code = "";
  let message = text;
  if (isRecord(detail)) {
    const named = pickString(detail, "code", "status");
    code = named ?? "";
    message = pickString(detail, "message") ?? text;
  } else if (Array.isArray(detail)) {
    message = detail
      .filter(isRecord)
      .map((item) => pickString(item, "msg") ?? "")
      .filter((msg) => msg.length > 0)
      .join("; ");
  }
  // Which of `quota_exceeded` (400/401 in the help center) and `insufficient_credits` (402 in the errors page) a
  // spent free key gets is NOT CONFIRMED: all of them, and 402, mean out of credits.
  const failure = failureFor(
    response.status,
    {
      message,
      quota: /quota_exceeded|insufficient_credits|payment_required/.test(code),
      invalidKey: /invalid_api_key|missing_api_key/.test(code),
      // `Retry-After` on 429 is NOT DOCUMENTED; read if present.
      retryAfterSeconds: retryAfterFromHeaders(response.headers),
    },
    ctx.apiKey,
  );
  return { failure, code, message, status: response.status };
}

async function fail(ctx: ConnectorContext, response: Response): Promise<VoiceFailure> {
  return (await describe(ctx, response)).failure;
}

function kindOf(category: string | null): VoiceKind {
  switch (category) {
    case "premade":
      return "prebuilt";
    case "cloned":
      return "custom";
    case "generated":
      return "designed";
    default:
      return "library";
  }
}

function entryOf(voice: unknown): VoiceCatalogEntry | null {
  if (!isRecord(voice)) return null;
  const id = pickString(voice, "voice_id");
  if (!id) return null;
  const labels: Record<string, string> = {};
  if (isRecord(voice.labels)) {
    for (const [key, value] of Object.entries(voice.labels))
      if (typeof value === "string" && value.length > 0) labels[key] = value;
  }
  const category = pickString(voice, "category");
  if (category) labels.category = category;
  const languages = new Set<string>();
  if (labels.language) languages.add(labels.language);
  if (Array.isArray(voice.verified_languages)) {
    for (const verified of voice.verified_languages) {
      if (!isRecord(verified)) continue;
      const language = pickString(verified, "locale", "language");
      if (language) languages.add(language);
    }
  }
  return {
    id,
    name: pickString(voice, "name") ?? id,
    description: pickString(voice, "description"),
    labels,
    languages: [...languages],
    previewUrl: pickString(voice, "preview_url"),
    kind: kindOf(category),
  };
}

function voiceSettings(
  family: Family,
  settings: Record<string, number | boolean>,
): Record<string, number | boolean> {
  const out: Record<string, number | boolean> = {};
  for (const key of SETTING_KEYS[family]) {
    const value = settings[key];
    if (value !== undefined) out[key] = value;
  }
  return out;
}

function outputFormatRejected(described: Described): boolean {
  return (
    [400, 403, 422].includes(described.status) &&
    (described.code === "invalid_output_format" || /output[_ ]format/i.test(described.message))
  );
}

async function speak(
  ctx: ConnectorContext,
  input: ConnectorSynthesisInput,
  format: string,
): Promise<Response> {
  const family = elevenLabsFamily(input.model);
  const body: Record<string, unknown> = { text: input.text, model_id: input.model };
  // Ignored by the model when it does not know the language; "not supported for multilingual_v2 models".
  const language = input.language?.split("-")[0]?.toLowerCase();
  if (language && input.model !== "eleven_multilingual_v2") body.language_code = language;
  const settings = voiceSettings(family, input.settings);
  if (Object.keys(settings).length > 0) body.voice_settings = settings;
  // Request stitching is not available for eleven_v3; whether it honours the text neighbours is NOT DOCUMENTED.
  if (family !== "v3") {
    if (input.previousText) body.previous_text = input.previousText;
    if (input.nextText) body.next_text = input.nextText;
  }
  return send(
    ctx,
    `${ctx.provider.baseUrl}/v1/text-to-speech/${encodeURIComponent(input.voice.id)}?output_format=${format}`,
    { method: "POST", headers: headers(ctx), body, timeoutMs: SYNTHESIS_TIMEOUT_MS },
  );
}

export const elevenLabsConnector: VoiceConnectorImpl = {
  async models(ctx): Promise<ConnectorModel[]> {
    const info = (id: string, name: string, maxChars?: number): ConnectorModel => {
      const match = dialectForModel(id, "elevenlabs");
      return {
        id,
        name,
        dialect: match.dialect,
        dialectApproximate: match.approximate,
        ...(maxChars && maxChars < VOICE_DIALECTS[match.dialect].maxChars && { maxChars }),
      };
    };
    const fallback = STATIC_MODELS.map((model) => info(model.id, model.name, model.maxChars));
    if (!ctx.apiKey) return fallback;
    try {
      const response = await send(ctx, `${ctx.provider.baseUrl}/v1/models`, {
        headers: headers(ctx),
      });
      if (!response.ok) throw await fail(ctx, response);
      const json = await readJson(response);
      const models: ConnectorModel[] = [];
      for (const model of Array.isArray(json) ? json : []) {
        if (!isRecord(model) || model.can_do_text_to_speech !== true) continue;
        const id = pickString(model, "model_id");
        if (!id) continue;
        const limit = model.maximum_text_length_per_request;
        models.push(
          info(
            id,
            pickString(model, "name") ?? id,
            typeof limit === "number" && limit > 0 ? limit : undefined,
          ),
        );
      }
      return models.length > 0 ? models : fallback;
    } catch (error) {
      // A wrong key is the user's to fix; any other trouble leaves the documented models usable.
      if (error instanceof VoiceFailure && error.code === "invalid_key") throw error;
      if (error instanceof VoiceFailure && error.code === "cancelled") throw error;
      return fallback;
    }
  },

  controls(_provider: VoiceProviderInfo, model: string): VoiceControl[] {
    const family = elevenLabsFamily(model);
    const controls: VoiceControl[] = [
      { kind: "catalog", filters: VOICE_FILTERS, preview: "audio_url" },
    ];
    const dialect = VOICE_DIALECTS[dialectForModel(model, "elevenlabs").dialect];
    if (dialect.style !== "none")
      controls.push({ kind: "style", target: dialect.style, maxChars: dialect.styleMaxChars });
    if (family === "v3") {
      // The docs do not state the range for v3; the three presets the vendor's UI offers are the safe values.
      controls.push({
        kind: "slider",
        id: "stability",
        min: 0,
        max: 1,
        step: 0.5,
        default: 0.5,
        values: [0, 0.5, 1],
      });
      return controls;
    }
    controls.push(
      { kind: "slider", id: "stability", min: 0, max: 1, step: 0.05, default: 0.5 },
      { kind: "slider", id: "similarity_boost", min: 0, max: 1, step: 0.05, default: 0.75 },
    );
    if (family === "v2")
      controls.push(
        { kind: "slider", id: "style", min: 0, max: 1, step: 0.05, default: 0 },
        {
          kind: "slider",
          id: "speed",
          min: SPEED_RANGE.min,
          max: SPEED_RANGE.max,
          step: 0.05,
          default: 1,
        },
        { kind: "toggle", id: "use_speaker_boost", default: true },
      );
    return controls;
  },

  async voices(ctx, filters, pageToken): Promise<VoiceCatalogPage> {
    const query = new URLSearchParams({
      page_size: String(VOICES_PAGE_SIZE),
      include_total_count: "false",
    });
    for (const filter of VOICE_FILTERS) {
      let value = filters[filter.id]?.trim();
      if (!value) continue;
      // `language` takes a language code; a BCP-47 tag ("ru-RU") is cut to it.
      if (filter.id === "language") value = (value.split("-")[0] ?? value).toLowerCase();
      query.set(FILTER_PARAMS[filter.id] ?? filter.id, value);
    }
    if (pageToken) query.set("next_page_token", pageToken);
    const response = await send(ctx, `${ctx.provider.baseUrl}/v2/voices?${query}`, {
      headers: headers(ctx),
    });
    if (!response.ok) throw await fail(ctx, response);
    const json = await readJson(response);
    const body = isRecord(json) ? json : {};
    const voices: VoiceCatalogEntry[] = [];
    for (const voice of Array.isArray(body.voices) ? body.voices : []) {
      const entry = entryOf(voice);
      if (entry) voices.push(entry);
    }
    const next = pickString(body, "next_page_token");
    return { voices, nextPageToken: body.has_more === true && next ? next : null };
  },

  async synthesize(ctx, input): Promise<ConnectorAudio> {
    // 24 kHz WAV is documented without a plan restriction; an MP3 is the documented fallback.
    let response = await speak(ctx, input, "wav_24000");
    if (!response.ok) {
      const described = await describe(ctx, response);
      if (!outputFormatRejected(described)) throw described.failure;
      response = await speak(ctx, input, "mp3_44100_128");
      if (!response.ok) throw await fail(ctx, response);
    }
    const audio = await audioFromResponse(response, "wav");
    const cost = Number(response.headers.get("character-cost"));
    if (Number.isFinite(cost) && cost > 0) audio.usage = { characters: cost };
    return audio;
  },

  async checkKey(ctx) {
    const response = await send(ctx, `${ctx.provider.baseUrl}/v1/user/subscription`, {
      headers: headers(ctx),
    });
    if (response.ok) return;
    const described = await describe(ctx, response);
    // A key limited to some features is valid: 403 on the subscription is asked again on the model list, which
    // needs no credits.
    if (response.status !== 403) throw described.failure;
    const models = await send(ctx, `${ctx.provider.baseUrl}/v1/models`, { headers: headers(ctx) });
    if (!models.ok) throw await fail(ctx, models);
  },
};
