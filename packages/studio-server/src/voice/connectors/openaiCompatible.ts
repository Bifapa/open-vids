import {
  dialectForModel,
  isRecord,
  VOICE_DIALECTS,
  type VoiceCatalogEntry,
  type VoiceCatalogPage,
  type VoiceControl,
  type VoiceDialect,
  type VoiceProviderInfo,
} from "@hyperframes/agent-protocol";
import { VoiceFailure } from "../errors.js";
import type { VoicePriceTerms } from "../pricing.js";
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
 * OpenAI (`/audio/speech`, https://developers.openai.com/api/reference/resources/audio/subresources/speech/methods/create),
 * OpenRouter (`/audio/speech`, https://openrouter.ai/docs/guides/overview/multimodal/tts.md) and a custom
 * OpenAI-compatible server share this connector; `ctx.provider.id` picks the differences. Built from the official
 * docs; no live key was available.
 */

const OPENAI_VOICES = [
  "alloy",
  "ash",
  "ballad",
  "coral",
  "echo",
  "fable",
  "nova",
  "onyx",
  "sage",
  "shimmer",
  "verse",
  "marin",
  "cedar",
];
/** `tts-1` and `tts-1-hd` take only these (the guide: "voice availability depends on the model"). */
const OPENAI_TTS1_VOICES = [
  "alloy",
  "ash",
  "coral",
  "echo",
  "fable",
  "onyx",
  "nova",
  "sage",
  "shimmer",
];
const OPENAI_MODELS = [
  { id: "gpt-4o-mini-tts", name: "GPT-4o mini TTS" },
  { id: "tts-1-hd", name: "TTS-1 HD" },
  { id: "tts-1", name: "TTS-1" },
];
/** `input`: "The maximum length is 4096 characters." */
const OPENAI_MAX_CHARS = 4096;
/** Gemini audio runs at 25 tokens per second (https://ai.google.dev/gemini-api/docs/pricing). */
const GEMINI_AUDIO_TOKENS_PER_MINUTE = 25 * 60;
const SPEED_RANGE = { min: 0.25, max: 4 };
const VOICE_TEXT_CHARS = 200;

function headers(ctx: ConnectorContext): Record<string, string> {
  return ctx.apiKey ? { authorization: `Bearer ${ctx.apiKey}` } : {};
}

const QUOTA_CODES =
  /insufficient_quota|credit_balance_exhausted|spend_limit_exceeded|usage_limit_exceeded|insufficient credits/i;

/** OpenAI answers `{error:{message,type,code:string}}`, OpenRouter `{error:{code:number,message,metadata}}`. */
async function fail(ctx: ConnectorContext, response: Response): Promise<VoiceFailure> {
  const { text, json } = await readFailureBody(response);
  const error = isRecord(json) && isRecord(json.error) ? json.error : {};
  const message = typeof error.message === "string" ? error.message : text;
  const code = typeof error.code === "string" ? error.code : "";
  const type = typeof error.type === "string" ? error.type : "";
  return failureFor(
    response.status,
    {
      message,
      invalidKey: code === "invalid_api_key",
      quota: QUOTA_CODES.test(`${code} ${type}`),
      retryAfterSeconds: retryAfterFromHeaders(response.headers),
    },
    ctx.apiKey,
  );
}

function dialectOf(provider: VoiceProviderInfo, model: string): VoiceDialect {
  const hint = provider.id === "openai" ? "openai" : null;
  return VOICE_DIALECTS[dialectForModel(model, hint).dialect];
}

function num(value: unknown): number {
  const parsed =
    typeof value === "string" ? Number(value) : typeof value === "number" ? value : NaN;
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
}

/**
 * What an OpenRouter listing's `pricing` means: Gemini-tokenized models bill input tokens and audio tokens; "most TTS
 * models are priced per character of input text; some per second of generated audio, under `pricing.completion`".
 * Anything that fits neither reading has no listed price.
 */
function listedPrice(model: Record<string, unknown>): VoicePriceTerms | undefined {
  const pricing = isRecord(model.pricing) ? model.pricing : null;
  if (!pricing) return undefined;
  const prompt = num(pricing.prompt);
  const completion = num(pricing.completion);
  const architecture = isRecord(model.architecture) ? model.architecture : {};
  if (architecture.tokenizer === "Gemini")
    return {
      usdPer1MInputTokens: prompt * 1e6,
      usdPerMinute: completion * GEMINI_AUDIO_TOKENS_PER_MINUTE,
    };
  if (prompt === 0 && completion === 0) return { usdPer1MChars: 0 };
  if (completion === 0) return { usdPer1MChars: prompt * 1e6 };
  if (prompt === 0) return { usdPerMinute: completion * 60 };
  return undefined;
}

async function openRouterListing(ctx: ConnectorContext): Promise<Record<string, unknown>[]> {
  const response = await send(ctx, `${ctx.provider.baseUrl}/models?output_modalities=speech`);
  if (!response.ok) throw await fail(ctx, response);
  const json = await readJson(response);
  const data = isRecord(json) && Array.isArray(json.data) ? json.data : [];
  return data.filter(isRecord);
}

function entryOf(id: string): VoiceCatalogEntry {
  return {
    id,
    name: id.charAt(0).toUpperCase() + id.slice(1),
    description: null,
    labels: {},
    languages: [],
    previewUrl: null,
    kind: "prebuilt",
  };
}

function matchesSearch(entry: VoiceCatalogEntry, search: string | undefined): boolean {
  const needle = search?.trim().toLowerCase() ?? "";
  return needle.length === 0 || entry.id.toLowerCase().includes(needle);
}

function requestBody(
  provider: VoiceProviderInfo,
  input: ConnectorSynthesisInput,
): Record<string, unknown> {
  const voice = input.voice.id.length > 0 ? input.voice.id : provider.voice;
  const body: Record<string, unknown> = { model: input.model, input: input.text };
  const style = input.style.trim();
  switch (provider.id) {
    case "openai": {
      body.voice = input.voice.kind === "custom" ? { id: voice } : voice;
      body.response_format = "wav";
      // `instructions` "does not work with tts-1 or tts-1-hd".
      if (style.length > 0 && input.model.startsWith("gpt-4o-mini-tts")) body.instructions = style;
      const speed = input.settings.speed;
      if (typeof speed === "number" && speed >= SPEED_RANGE.min && speed <= SPEED_RANGE.max)
        body.speed = speed;
      break;
    }
    case "openrouter": {
      body.voice = voice;
      // OpenRouter speech answers `mp3` or `pcm` only.
      body.response_format = "mp3";
      // Gemini style travels as provider options of the matched provider. Whether options for `google-ai-studio`
      // reach a request routed to Vertex is NOT DOCUMENTED (speech routing ignores `order`/`only`).
      if (style.length > 0 && input.model.toLowerCase().startsWith("google/gemini"))
        body.provider = { options: { "google-ai-studio": { speech_metadata: { style } } } };
      break;
    }
    default: {
      body.voice = voice;
      body.response_format = "wav";
    }
  }
  return body;
}

export const openaiCompatibleConnector: VoiceConnectorImpl = {
  async models(ctx): Promise<ConnectorModel[]> {
    const { provider } = ctx;
    if (provider.id === "openai") {
      return OPENAI_MODELS.map((model) => {
        const match = dialectForModel(model.id, "openai");
        const dialect = VOICE_DIALECTS[match.dialect];
        return {
          id: model.id,
          name: model.name,
          dialect: match.dialect,
          dialectApproximate: match.approximate,
          ...(dialect.maxChars > OPENAI_MAX_CHARS && { maxChars: OPENAI_MAX_CHARS }),
        };
      });
    }
    if (provider.id === "openrouter") {
      const models: ConnectorModel[] = [];
      for (const model of await openRouterListing(ctx)) {
        const id = pickString(model, "id");
        if (!id) continue;
        const match = dialectForModel(id, null);
        const price = listedPrice(model);
        models.push({
          id,
          name: pickString(model, "name") ?? id,
          dialect: match.dialect,
          dialectApproximate: match.approximate,
          ...(price && { listedPrice: price }),
        });
      }
      return models;
    }
    // A custom server: the one model the user named (not every server lists its models).
    if (provider.model.length === 0) return [];
    return [
      {
        id: provider.model,
        name: provider.model,
        dialect: "plain",
        dialectApproximate: false,
      },
    ];
  },

  controls(provider: VoiceProviderInfo, model: string): VoiceControl[] {
    const dialect = dialectOf(provider, model);
    const controls: VoiceControl[] = [];
    const search: VoiceControl = {
      kind: "catalog",
      filters: [{ id: "search", options: null }],
      preview: "synthesize",
    };
    if (provider.id === "openai") {
      controls.push(search);
    } else if (provider.id === "openrouter") {
      controls.push(search, { kind: "voice_text", maxChars: VOICE_TEXT_CHARS });
    } else {
      controls.push({ kind: "voice_text", maxChars: VOICE_TEXT_CHARS });
    }
    if (dialect.style !== "none")
      controls.push({ kind: "style", target: dialect.style, maxChars: dialect.styleMaxChars });
    // `speed` 0.25-4 is documented for the endpoint; which models honour it is NOT DOCUMENTED.
    if (provider.id === "openai")
      controls.push({
        kind: "slider",
        id: "speed",
        min: SPEED_RANGE.min,
        max: SPEED_RANGE.max,
        step: 0.05,
        default: 1,
      });
    return controls;
  },

  async voices(ctx, filters): Promise<VoiceCatalogPage> {
    const model = filters.model && filters.model.length > 0 ? filters.model : ctx.provider.model;
    let ids: string[] = [];
    if (ctx.provider.id === "openai")
      ids = model.startsWith("tts-1") ? OPENAI_TTS1_VOICES : OPENAI_VOICES;
    else if (ctx.provider.id === "openrouter") {
      // `supported_voices` is `string[] | null`; absent for models with free-form voices.
      const listed = (await openRouterListing(ctx)).find((entry) => entry.id === model);
      const supported =
        listed && Array.isArray(listed.supported_voices) ? listed.supported_voices : [];
      ids = supported.filter((voice): voice is string => typeof voice === "string");
    }
    const voices = ids.map(entryOf).filter((entry) => matchesSearch(entry, filters.search));
    return { voices, nextPageToken: null };
  },

  async synthesize(ctx, input): Promise<ConnectorAudio> {
    const response = await send(ctx, `${ctx.provider.baseUrl}/audio/speech`, {
      method: "POST",
      headers: headers(ctx),
      body: requestBody(ctx.provider, input),
      timeoutMs: SYNTHESIS_TIMEOUT_MS,
    });
    if (!response.ok) throw await fail(ctx, response);
    return audioFromResponse(response, ctx.provider.id === "openrouter" ? "mp3" : "wav");
  },

  async checkKey(ctx) {
    const url =
      ctx.provider.id === "openrouter"
        ? `${ctx.provider.baseUrl}/key`
        : `${ctx.provider.baseUrl}/models`;
    const response = await send(ctx, url, { headers: headers(ctx) });
    if (response.ok) return;
    // A custom server need not implement `/models`: only a refused key or a broken server fails the check.
    if (
      ctx.provider.id === "custom" &&
      ![401, 403].includes(response.status) &&
      response.status < 500
    )
      return;
    throw await fail(ctx, response);
  },
};
