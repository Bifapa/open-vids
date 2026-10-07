import {
  dialectForModel,
  isRecord,
  VOICE_DIALECTS,
  VOICE_LIMITS,
  type DesignVoiceRequest,
  type VoiceCatalogEntry,
  type VoiceCatalogFilter,
  type VoiceCatalogPage,
  type VoiceControl,
  type VoiceKind,
  type VoiceModelInfo,
  type VoicePresetVoice,
  type VoiceProviderInfo,
} from "@hyperframes/agent-protocol";
import { notAudio, VoiceFailure } from "../errors.js";
import type {
  ConnectorAudio,
  ConnectorContext,
  ConnectorSynthesisInput,
  VoiceConnectorImpl,
} from "../types.js";
import {
  failureFor,
  parseDurationSeconds,
  pickString,
  readFailureBody,
  readJson,
  retryAfterFromHeaders,
  send,
  SYNTHESIS_TIMEOUT_MS,
} from "./http.js";

/**
 * Google Gemini speech through the Interactions API (https://ai.google.dev/gemini-api/docs/speech-generation) and
 * the Voices API (https://ai.google.dev/api/voices). Built from the official docs; no live key was available, so
 * the places where the docs are silent parse defensively and say so.
 */

const CATALOG_PAGE_SIZE = 50;
/** A catalog language filter without a region ("ru") is matched here, so it needs bigger pages. */
const WIDE_PAGE_SIZE = 200;
const WIDE_PAGE_LIMIT = 5;
const WIDE_PAGE_TARGET = 20;

const MODELS: Array<{ id: string; name: string }> = [
  { id: "gemini-3.8-flash-tts", name: "Gemini 3.8 Flash TTS" },
  { id: "gemini-3.8-flash-lite-tts", name: "Gemini 3.8 Flash-Lite TTS" },
];

/** The filters of `GET /voices`; the values are the documented ones. */
const CATALOG_FILTERS: VoiceCatalogFilter[] = [
  { id: "language_code", options: null },
  { id: "region_code", options: null },
  { id: "accent", options: null },
  { id: "gender", options: ["female", "male", "neutral"] },
  { id: "pitch", options: ["low", "medium", "high"] },
  { id: "persona", options: null },
  { id: "context", options: null },
  { id: "type", options: ["prebuilt", "prompted"] },
  { id: "search", options: null },
];
/** Voice design is documented for the 3.8 models only. */
const DESIGN_MODEL = /^gemini-3\.8-/;

function headers(ctx: ConnectorContext): Record<string, string> {
  return ctx.apiKey ? { "x-goog-api-key": ctx.apiKey } : {};
}

function array(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

/** The Interactions API answers `{error:{code:"authentication",message}}`; the legacy shape has a numeric code. */
async function fail(ctx: ConnectorContext, response: Response): Promise<VoiceFailure> {
  const { text, json } = await readFailureBody(response);
  const error = isRecord(json) && isRecord(json.error) ? json.error : {};
  const code = typeof error.code === "string" ? error.code : "";
  const status = typeof error.status === "string" ? error.status : "";
  const message = typeof error.message === "string" ? error.message : text;
  const details = array(error.details).filter(isRecord);
  // `API_KEY_INVALID` is how the legacy shape (and so possibly the voices endpoint) says a key is wrong.
  const invalidKey =
    code === "authentication" ||
    details.some((detail) => detail.reason === "API_KEY_INVALID") ||
    (response.status === 400 && /api key not valid/i.test(message));
  // The retry delay is NOT DOCUMENTED for Gemini; `google.rpc.RetryInfo.retryDelay` is parsed if the body has it.
  let retryAfter = retryAfterFromHeaders(response.headers);
  for (const detail of details) {
    const type = typeof detail["@type"] === "string" ? detail["@type"] : "";
    if (type.endsWith("RetryInfo") || detail.retryDelay !== undefined)
      retryAfter = parseDurationSeconds(detail.retryDelay) ?? retryAfter;
  }
  retryAfter = parseDurationSeconds(error.retryDelay) ?? retryAfter;
  // Seen live (2026-10-07): a per-minute 429 is `{code:"too_many_requests", message:"… (limit: 3 requests per minute
  // on Free Tier). Please retry in 11s …"}` with `Retry-After: 11`; a daily one names the day in the same message.
  if (retryAfter === undefined) {
    const seconds = /retry in (\d+(?:\.\d+)?)s/i.exec(message)?.[1];
    if (seconds !== undefined) retryAfter = Math.ceil(Number(seconds));
  }
  const daily =
    code === "quota_exceeded" ||
    /PerDay/i.test(JSON.stringify(details)) ||
    /per day|daily/i.test(message);
  return failureFor(
    response.status,
    {
      message: message || status || code,
      invalidKey,
      quota: code === "payment_required",
      daily,
      retryAfterSeconds: retryAfter,
    },
    ctx.apiKey,
  );
}

/** The audio of an interaction: the last audio block of the model's output steps. */
function audioOfInteraction(json: unknown): ConnectorAudio | null {
  if (!isRecord(json)) return null;
  let found: Record<string, unknown> | null = null;
  for (const step of array(json.steps)) {
    if (!isRecord(step) || step.type !== "model_output") continue;
    for (const block of array(step.content)) {
      if (isRecord(block) && block.type === "audio" && typeof block.data === "string")
        found = block;
    }
  }
  if (!found || typeof found.data !== "string") return null;
  return audioFromBlock(found.data, found);
}

/** A base64 audio block (`{data, mime_type, sample_rate}`) as connector audio; WAV unless the block says raw PCM. */
function audioFromBlock(data: string, block: Record<string, unknown>): ConnectorAudio {
  const bytes = new Uint8Array(Buffer.from(data, "base64"));
  const mime = (pickString(block, "mime_type", "mimeType") ?? "").toLowerCase();
  const rate = Number(
    block.sample_rate ?? block.sampleRate ?? /rate=(\d+)/.exec(mime)?.[1] ?? Number.NaN,
  );
  const sampleRate = Number.isFinite(rate) && rate > 0 ? rate : undefined;
  const format = /l16|pcm/.test(mime) ? "pcm" : /mpeg|mp3/.test(mime) ? "mp3" : "wav";
  return { bytes, format, ...(sampleRate && { sampleRate }) };
}

function kindOf(type: string | null): VoiceKind {
  if (type === "prompted") return "designed";
  if (type === "replicated") return "custom";
  return "prebuilt";
}

function labelsOf(voice: Record<string, unknown>): Record<string, string> {
  const labels: Record<string, string> = {};
  for (const [label, ...fields] of [
    ["gender", "gender"],
    ["pitch", "pitch"],
    ["accent", "accent"],
    ["persona", "persona"],
    ["context", "context"],
    ["region", "region_code", "regionCode"],
  ] as const) {
    const value = pickString(voice, ...fields);
    if (value) labels[label] = value;
  }
  return labels;
}

/** A `Voice` of the Voices API. The docs do not state the JSON casing; both are read. */
function entryOf(voice: unknown): VoiceCatalogEntry | null {
  if (!isRecord(voice)) return null;
  const id = pickString(voice, "id");
  if (!id) return null;
  const language = pickString(voice, "language_code", "languageCode");
  return {
    id,
    name: pickString(voice, "display_name", "displayName") ?? id,
    description: pickString(voice, "description"),
    labels: labelsOf(voice),
    languages: language ? [language] : [],
    previewUrl: null,
    kind: kindOf(pickString(voice, "type")),
  };
}

function primarySubtag(language: string): string {
  return (language.split("-")[0] ?? language).toLowerCase();
}

export const geminiConnector: VoiceConnectorImpl = {
  async models() {
    return MODELS.map((model): Omit<VoiceModelInfo, "usdPerMinute"> => {
      const match = dialectForModel(model.id, "gemini");
      return {
        id: model.id,
        name: model.name,
        dialect: match.dialect,
        dialectApproximate: match.approximate,
      };
    });
  },

  controls(_provider: VoiceProviderInfo, model: string): VoiceControl[] {
    const dialect = VOICE_DIALECTS[dialectForModel(model, "gemini").dialect];
    const controls: VoiceControl[] = [
      { kind: "catalog", filters: CATALOG_FILTERS, preview: "synthesize" },
    ];
    if (DESIGN_MODEL.test(model))
      controls.push({ kind: "voice_design", maxChars: VOICE_LIMITS.voiceDescriptionChars });
    if (dialect.style === "style")
      controls.push({ kind: "style", target: "style", maxChars: dialect.styleMaxChars });
    return controls;
  },

  async voices(ctx, filters, pageToken): Promise<VoiceCatalogPage> {
    const language = filters.language_code?.trim() ?? "";
    // `language_code` filters by exact BCP-47 ("ru-RU"); a bare language ("ru") is matched by primary subtag here.
    const wide = language.length > 0 && !language.includes("-");
    const params = new URLSearchParams();
    for (const filter of CATALOG_FILTERS) {
      const value = filters[filter.id]?.trim();
      if (!value || (filter.id === "language_code" && wide)) continue;
      params.append(filter.id, value);
    }
    params.set("page_size", String(wide ? WIDE_PAGE_SIZE : CATALOG_PAGE_SIZE));

    const voices: VoiceCatalogEntry[] = [];
    let token = pageToken;
    for (let page = 0; page < (wide ? WIDE_PAGE_LIMIT : 1); page += 1) {
      const query = new URLSearchParams(params);
      if (token) query.set("page_token", token);
      const response = await send(ctx, `${ctx.provider.baseUrl}/voices?${query}`, {
        headers: headers(ctx),
      });
      if (!response.ok) throw await fail(ctx, response);
      const json = await readJson(response);
      const body = isRecord(json) ? json : {};
      for (const voice of array(body.voices)) {
        const entry = entryOf(voice);
        if (!entry) continue;
        if (
          wide &&
          !entry.languages.some((code) => primarySubtag(code) === primarySubtag(language))
        )
          continue;
        voices.push(entry);
      }
      token = pickString(body, "next_page_token", "nextPageToken");
      if (!token || voices.length >= WIDE_PAGE_TARGET) break;
    }
    return { voices, nextPageToken: token };
  },

  async designVoice(
    ctx,
    request: DesignVoiceRequest,
  ): Promise<{ voice: VoicePresetVoice & { previewUrl?: null }; sample: ConnectorAudio | null }> {
    const voice: Record<string, unknown> = {
      type: "prompted",
      display_name: request.name,
      prompted: { input: request.description },
    };
    if (request.model) voice.model = request.model;
    if (request.gender) voice.gender = request.gender;
    if (request.language) voice.language_code = request.language;
    const response = await send(ctx, `${ctx.provider.baseUrl}/voices`, {
      method: "POST",
      headers: headers(ctx),
      // `store` must be true for a prompted voice (the API refuses otherwise).
      body: { store: true, voice },
      timeoutMs: SYNTHESIS_TIMEOUT_MS,
    });
    if (!response.ok) throw await fail(ctx, response);
    const json = await readJson(response);
    const created = isRecord(json) ? json : {};
    const id = pickString(created, "id");
    if (!id)
      throw new VoiceFailure("provider_error", "The provider did not return the new voice's id.");
    const sampleBlock = created.sample_audio ?? created.sampleAudio;
    const sample =
      isRecord(sampleBlock) && typeof sampleBlock.data === "string"
        ? audioFromBlock(sampleBlock.data, sampleBlock)
        : null;
    return {
      voice: {
        id,
        name: pickString(created, "display_name", "displayName") ?? request.name,
        kind: "designed",
        description: request.description,
        ...(request.language && { language: request.language }),
      },
      sample,
    };
  },

  async synthesize(ctx, input: ConnectorSynthesisInput): Promise<ConnectorAudio> {
    const part: Record<string, unknown> = { type: "text", text: input.text };
    if (input.style.trim().length > 0)
      part.annotations = [{ type: "speech_metadata", style: input.style }];
    const response = await send(ctx, `${ctx.provider.baseUrl}/interactions`, {
      method: "POST",
      headers: headers(ctx),
      body: {
        model: input.model,
        // The request and its audio are not kept on Google's side.
        store: false,
        input: [{ type: "user_input", content: [part] }],
        response_format: { type: "audio", mime_type: "audio/wav" },
        generation_config: { speech_config: [{ voice: input.voice.id }] },
      },
      timeoutMs: SYNTHESIS_TIMEOUT_MS,
    });
    if (!response.ok) throw await fail(ctx, response);
    const bytes = new Uint8Array(await response.arrayBuffer());
    const contentType = response.headers.get("content-type") ?? "";
    let json: unknown;
    try {
      json = JSON.parse(new TextDecoder().decode(bytes));
    } catch {
      throw notAudio(contentType, bytes);
    }
    const audio = audioOfInteraction(json);
    // A completed interaction without an audio block (a content block, a refusal): show what Google said.
    if (!audio) throw notAudio(contentType, bytes);
    return audio;
  },

  async checkKey(ctx) {
    const response = await send(ctx, `${ctx.provider.baseUrl}/voices?page_size=1`, {
      headers: headers(ctx),
    });
    if (!response.ok) throw await fail(ctx, response);
  },
};
