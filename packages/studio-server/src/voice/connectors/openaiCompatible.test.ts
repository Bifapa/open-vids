// @vitest-environment node
import { describe, expect, it } from "vitest";
import { isVoiceFailure, type VoiceFailure } from "../errors.js";
import {
  audioResponse,
  context,
  jsonResponse,
  mockFetch,
  provider,
  SECRET,
  silentWav,
} from "../testSupport.js";
import { openaiCompatibleConnector as connector } from "./openaiCompatible.js";

const openai = provider({ id: "openai" });
const openrouter = provider({ id: "openrouter" });
const custom = provider({ id: "custom", voice: "af_heart" });
const voice = { id: "marin", name: "Marin", kind: "prebuilt" as const };
const base = { voice, style: "", settings: {}, text: "Hello there" };

async function failureOf(run: Promise<unknown>): Promise<VoiceFailure> {
  try {
    await run;
  } catch (error) {
    if (isVoiceFailure(error)) return error;
    throw error;
  }
  throw new Error("expected a VoiceFailure");
}

describe("openai_compatible connector: OpenAI", () => {
  it("posts /audio/speech with wav, instructions (mini-tts) and speed", async () => {
    const wav = silentWav();
    const net = mockFetch(() => audioResponse(wav));
    const audio = await connector.synthesize(context(openai, net.fetch), {
      ...base,
      model: "gpt-4o-mini-tts",
      style: "calm and warm",
      settings: { speed: 1.25 },
    });
    expect(net.calls[0]).toMatchObject({
      url: "https://api.openai.com/v1/audio/speech",
      method: "POST",
      headers: { authorization: `Bearer ${SECRET}` },
      body: {
        model: "gpt-4o-mini-tts",
        input: "Hello there",
        voice: "marin",
        response_format: "wav",
        instructions: "calm and warm",
        speed: 1.25,
      },
    });
    expect(audio).toMatchObject({ format: "wav", bytes: wav });
  });

  it("leaves instructions out for tts-1 and drops an out-of-range speed", async () => {
    const net = mockFetch(() => audioResponse(silentWav()));
    await connector.synthesize(context(openai, net.fetch), {
      ...base,
      model: "tts-1-hd",
      style: "calm",
      settings: { speed: 9 },
    });
    const body = net.calls[0]?.body;
    expect(body).not.toHaveProperty("instructions");
    expect(body).not.toHaveProperty("speed");
  });

  it("sends a custom voice as {id}", async () => {
    const net = mockFetch(() => audioResponse(silentWav()));
    await connector.synthesize(context(openai, net.fetch), {
      ...base,
      model: "gpt-4o-mini-tts",
      voice: { id: "voice_123", name: "Mine", kind: "custom" },
    });
    expect(net.calls[0]?.body).toMatchObject({ voice: { id: "voice_123" } });
  });

  it("answers not_audio with the content type and the first 2 KB of a non-audio body", async () => {
    const html = `<html>${"x".repeat(5000)}</html>`;
    const net = mockFetch(
      () => new Response(html, { status: 200, headers: { "content-type": "text/html" } }),
    );
    const failure = await failureOf(
      connector.synthesize(context(openai, net.fetch), { ...base, model: "tts-1" }),
    );
    expect(failure.code).toBe("not_audio");
    expect(failure.params?.contentType).toBe("text/html");
    expect(String(failure.params?.body)).toHaveLength(2048);
    expect(String(failure.params?.body).startsWith("<html>")).toBe(true);
  });

  it("rejects bytes that are not audio even without a content type", async () => {
    const net = mockFetch(() => new Response("nope, not audio", { status: 200 }));
    const failure = await failureOf(
      connector.synthesize(context(openai, net.fetch), { ...base, model: "tts-1" }),
    );
    expect(failure.code).toBe("not_audio");
    expect(failure.params?.body).toBe("nope, not audio");
  });

  it("maps a 401 (text/plain JSON body, key echoed) to invalid_key without the key", async () => {
    const net = mockFetch(
      () =>
        new Response(
          JSON.stringify({
            error: {
              message: `Incorrect API key provided: ${SECRET}.`,
              type: "invalid_request_error",
              code: "invalid_api_key",
            },
            status: 401,
          }),
          { status: 401, headers: { "content-type": "text/plain" } },
        ),
    );
    const failure = await failureOf(connector.checkKey(context(openai, net.fetch)));
    expect(failure.code).toBe("invalid_key");
    expect(JSON.stringify(failure)).not.toContain(SECRET);
    expect(failure.message).not.toContain(SECRET);
    expect(net.calls[0]?.url).toBe("https://api.openai.com/v1/models");
  });

  it("maps credit exhaustion on 429 to quota_exhausted and a plain 429 to rate_limited with Retry-After", async () => {
    const spent = mockFetch(() =>
      jsonResponse(
        {
          error: {
            message: "You exceeded your current quota",
            type: "insufficient_quota",
            code: "credit_balance_exhausted",
          },
        },
        429,
      ),
    );
    expect((await failureOf(connector.checkKey(context(openai, spent.fetch)))).code).toBe(
      "quota_exhausted",
    );
    const limited = mockFetch(() =>
      jsonResponse(
        {
          error: {
            message: "Rate limit reached",
            type: "rate_limit_error",
            code: "rate_limit_exceeded",
          },
        },
        429,
        { "retry-after": "12" },
      ),
    );
    const failure = await failureOf(connector.checkKey(context(openai, limited.fetch)));
    expect(failure).toMatchObject({ code: "rate_limited", params: { retryAfterSeconds: 12 } });
  });

  it("lists the models and the voices each model takes", async () => {
    const net = mockFetch(() => jsonResponse({}));
    const models = await connector.models(context(openai, net.fetch));
    expect(models.map((model) => model.id)).toEqual(["gpt-4o-mini-tts", "tts-1-hd", "tts-1"]);
    expect(models[1]?.dialect).toBe("openai-tts-1");
    const all = await connector.voices?.(
      context(openai, net.fetch),
      { model: "gpt-4o-mini-tts" },
      null,
    );
    const tts1 = await connector.voices?.(context(openai, net.fetch), { model: "tts-1" }, null);
    expect(all?.voices).toHaveLength(13);
    expect(tts1?.voices).toHaveLength(9);
    const found = await connector.voices?.(
      context(openai, net.fetch),
      { model: "gpt-4o-mini-tts", search: "MAR" },
      null,
    );
    expect(found?.voices.map((entry) => entry.id)).toEqual(["marin"]);
    expect(net.calls).toHaveLength(0);
  });

  it("builds controls from the model's dialect", () => {
    const kinds = (model: string) =>
      connector
        .controls(openai, model)
        .map((control) => (control.kind === "style" ? `style:${control.target}` : control.kind));
    expect(kinds("gpt-4o-mini-tts")).toEqual(["catalog", "style:instructions", "slider"]);
    expect(kinds("tts-1")).toEqual(["catalog", "slider"]);
  });
});

describe("openai_compatible connector: OpenRouter", () => {
  it("asks for mp3 and passes the Gemini style as provider options", async () => {
    const mp3 = new Uint8Array([0x49, 0x44, 0x33, 4, 0, 0, 0, 0, 0, 0, 0xff, 0xfb]);
    const net = mockFetch(() => audioResponse(mp3, "audio/mpeg"));
    const audio = await connector.synthesize(context(openrouter, net.fetch), {
      ...base,
      model: "google/gemini-3.8-flash-tts",
      style: "whispering",
    });
    expect(net.calls[0]).toMatchObject({
      url: "https://openrouter.ai/api/v1/audio/speech",
      body: {
        model: "google/gemini-3.8-flash-tts",
        input: "Hello there",
        voice: "marin",
        response_format: "mp3",
        provider: { options: { "google-ai-studio": { speech_metadata: { style: "whispering" } } } },
      },
    });
    expect(audio.format).toBe("mp3");
  });

  it("sends no provider options for a non-Gemini model", async () => {
    const net = mockFetch(() =>
      audioResponse(new Uint8Array([0xff, 0xfb, 0x90, 0x00, 1, 2, 3, 4]), "audio/mpeg"),
    );
    await connector.synthesize(context(openrouter, net.fetch), {
      ...base,
      model: "mistralai/voxtral-mini-tts-2603",
      style: "x",
    });
    expect(net.calls[0]?.body).not.toHaveProperty("provider");
  });

  it("lists speech models from the public listing with their prices and voices", async () => {
    const net = mockFetch(() =>
      jsonResponse({
        data: [
          {
            id: "google/gemini-3.8-flash-tts",
            name: "Google: Gemini 3.8 Flash TTS",
            architecture: { tokenizer: "Gemini" },
            pricing: { prompt: "0.0000005", completion: "0.000009" },
            supported_voices: ["Kore", "Puck"],
          },
          {
            id: "hexgrad/kokoro-82m",
            name: "Kokoro",
            architecture: { tokenizer: "Other" },
            pricing: { prompt: "0.00000062", completion: "0" },
          },
          {
            id: "bytedance-seed/seed-audio-1-0",
            name: "Seed",
            architecture: {},
            pricing: { prompt: "0", completion: "0.0025" },
          },
        ],
      }),
    );
    const models = await connector.models(context(openrouter, net.fetch, { apiKey: null }));
    expect(net.calls[0]?.url).toBe("https://openrouter.ai/api/v1/models?output_modalities=speech");
    expect(net.calls[0]?.headers.authorization).toBeUndefined();
    expect(models.map((model) => model.id)).toEqual([
      "google/gemini-3.8-flash-tts",
      "hexgrad/kokoro-82m",
      "bytedance-seed/seed-audio-1-0",
    ]);
    expect(models[0]).toMatchObject({ dialect: "gemini-tts", dialectApproximate: false });
    expect(models[0]?.listedPrice?.usdPer1MInputTokens).toBeCloseTo(0.5);
    expect(models[0]?.listedPrice?.usdPerMinute).toBeCloseTo(0.0135);
    expect(models[1]?.listedPrice?.usdPer1MChars).toBeCloseTo(0.62);
    expect(models[2]?.listedPrice?.usdPerMinute).toBeCloseTo(0.15);

    const page = await connector.voices?.(
      context(openrouter, net.fetch),
      { model: "google/gemini-3.8-flash-tts" },
      null,
    );
    expect(page?.voices.map((entry) => entry.id)).toEqual(["Kore", "Puck"]);
    const none = await connector.voices?.(
      context(openrouter, net.fetch),
      { model: "hexgrad/kokoro-82m" },
      null,
    );
    expect(none?.voices).toEqual([]);
  });

  it("checks the key on /key and maps a 401", async () => {
    const net = mockFetch(() =>
      jsonResponse({ error: { message: "User not found.", code: 401 } }, 401),
    );
    const failure = await failureOf(connector.checkKey(context(openrouter, net.fetch)));
    expect(failure.code).toBe("invalid_key");
    expect(net.calls[0]?.url).toBe("https://openrouter.ai/api/v1/key");
  });

  it("maps 402 to quota_exhausted", async () => {
    const net = mockFetch(() =>
      jsonResponse(
        {
          error: {
            code: 402,
            message: "Insufficient credits. Add more using https://openrouter.ai/credits",
          },
        },
        402,
      ),
    );
    const failure = await failureOf(
      connector.synthesize(context(openrouter, net.fetch), { ...base, model: "x/y" }),
    );
    expect(failure.code).toBe("quota_exhausted");
  });
});

describe("openai_compatible connector: custom server", () => {
  it("runs without a key, asks for wav, and types the voice", async () => {
    const wav = silentWav();
    const net = mockFetch(() => audioResponse(wav));
    await connector.synthesize(context(custom, net.fetch, { apiKey: null }), {
      ...base,
      model: "kokoro",
      voice: { id: "af_heart", name: "af_heart", kind: "custom" },
    });
    expect(net.calls[0]?.url).toBe("http://127.0.0.1:8880/v1/audio/speech");
    expect(net.calls[0]?.headers.authorization).toBeUndefined();
    expect(net.calls[0]?.body).toEqual({
      model: "kokoro",
      input: "Hello there",
      voice: "af_heart",
      response_format: "wav",
    });
    expect(connector.controls(custom, "kokoro").map((control) => control.kind)).toEqual([
      "voice_text",
    ]);
  });

  it("accepts a server without /models, refuses a 401, and reports an unreachable one", async () => {
    const missing = mockFetch(() => new Response("not found", { status: 404 }));
    await expect(
      connector.checkKey(context(custom, missing.fetch, { apiKey: null })),
    ).resolves.toBeUndefined();
    const refused = mockFetch(() => new Response("no", { status: 401 }));
    expect((await failureOf(connector.checkKey(context(custom, refused.fetch)))).code).toBe(
      "invalid_key",
    );
    const down = Object.assign(
      async () => {
        throw new TypeError("ECONNREFUSED");
      },
      { preconnect: () => undefined },
    );
    expect((await failureOf(connector.checkKey(context(custom, down)))).code).toBe(
      "provider_unreachable",
    );
  });

  it("lists the one model the user named", async () => {
    const net = mockFetch(() => jsonResponse({}));
    expect((await connector.models(context(custom, net.fetch))).map((model) => model.id)).toEqual([
      "kokoro",
    ]);
    expect(net.calls).toHaveLength(0);
  });
});
