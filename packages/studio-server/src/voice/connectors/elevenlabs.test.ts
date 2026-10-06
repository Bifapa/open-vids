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
import { elevenLabsConnector as connector } from "./elevenlabs.js";

const info = provider({ id: "elevenlabs" });
const voice = { id: "21m00Tcm4TlvDq8ikWAM", name: "Rachel", kind: "prebuilt" as const };
const base = { voice, style: "", text: "Hello [whispers] there" };

async function failureOf(run: Promise<unknown>): Promise<VoiceFailure> {
  try {
    await run;
  } catch (error) {
    if (isVoiceFailure(error)) return error;
    throw error;
  }
  throw new Error("expected a VoiceFailure");
}

describe("elevenlabs connector", () => {
  it("requests 24 kHz WAV with xi-api-key and only the settings v4 takes", async () => {
    const wav = silentWav();
    const net = mockFetch(() => audioResponse(wav));
    const audio = await connector.synthesize(context(info, net.fetch), {
      ...base,
      model: "eleven_v4",
      settings: {
        stability: 0.4,
        similarity_boost: 0.8,
        style: 0.3,
        speed: 1.1,
        use_speaker_boost: true,
      },
      previousText: "Before.",
      nextText: "After.",
      language: "ru-RU",
    });
    const call = net.calls[0];
    expect(call?.url).toBe(
      "https://api.elevenlabs.io/v1/text-to-speech/21m00Tcm4TlvDq8ikWAM?output_format=wav_24000",
    );
    expect(call?.headers["xi-api-key"]).toBe(SECRET);
    expect(call?.body).toEqual({
      text: "Hello [whispers] there",
      model_id: "eleven_v4",
      language_code: "ru",
      voice_settings: { stability: 0.4, similarity_boost: 0.8 },
      previous_text: "Before.",
      next_text: "After.",
    });
    expect(audio.format).toBe("wav");
  });

  it("sends only stability for v3 and no neighbouring text", async () => {
    const net = mockFetch(() => audioResponse(silentWav()));
    await connector.synthesize(context(info, net.fetch), {
      ...base,
      model: "eleven_v3",
      settings: { stability: 0.5, similarity_boost: 0.8, speed: 1.1 },
      previousText: "Before.",
      nextText: "After.",
    });
    expect(net.calls[0]?.body).toEqual({
      text: "Hello [whispers] there",
      model_id: "eleven_v3",
      voice_settings: { stability: 0.5 },
    });
  });

  it("sends the whole v2 family of settings and no language for multilingual_v2", async () => {
    const net = mockFetch(() => audioResponse(silentWav()));
    await connector.synthesize(context(info, net.fetch), {
      ...base,
      model: "eleven_multilingual_v2",
      settings: {
        stability: 0.5,
        similarity_boost: 0.75,
        style: 0,
        use_speaker_boost: true,
        speed: 1,
      },
      language: "en",
    });
    expect(net.calls[0]?.body).toEqual({
      text: "Hello [whispers] there",
      model_id: "eleven_multilingual_v2",
      voice_settings: {
        stability: 0.5,
        similarity_boost: 0.75,
        style: 0,
        use_speaker_boost: true,
        speed: 1,
      },
    });
  });

  it("omits voice_settings when there are none", async () => {
    const net = mockFetch(() => audioResponse(silentWav()));
    await connector.synthesize(context(info, net.fetch), {
      ...base,
      model: "eleven_v4",
      settings: {},
    });
    expect(net.calls[0]?.body).not.toHaveProperty("voice_settings");
  });

  it("falls back to mp3_44100_128 when the WAV format is refused, and reads character-cost", async () => {
    const mp3 = new Uint8Array([0x49, 0x44, 0x33, 4, 0, 0, 0, 0, 0, 0, 0xff, 0xfb, 0x90, 0]);
    const net = mockFetch((call) =>
      call.url.includes("wav_24000")
        ? jsonResponse(
            {
              detail: {
                type: "validation_error",
                code: "invalid_output_format",
                message: "wav_24000 needs a higher tier",
              },
            },
            400,
          )
        : new Response(mp3, {
            status: 200,
            headers: { "content-type": "audio/mpeg", "character-cost": "22" },
          }),
    );
    const audio = await connector.synthesize(context(info, net.fetch), {
      ...base,
      model: "eleven_v4",
      settings: {},
    });
    expect(net.calls.map((call) => new URL(call.url).searchParams.get("output_format"))).toEqual([
      "wav_24000",
      "mp3_44100_128",
    ]);
    expect(audio).toMatchObject({ format: "mp3", usage: { characters: 22 } });
  });

  it("does not fall back on unrelated errors", async () => {
    const net = mockFetch(() =>
      jsonResponse(
        { detail: { type: "validation_error", code: "text_too_long", message: "too long" } },
        400,
      ),
    );
    const failure = await failureOf(
      connector.synthesize(context(info, net.fetch), { ...base, model: "eleven_v4", settings: {} }),
    );
    expect(failure).toMatchObject({ code: "provider_error", message: "too long" });
    expect(net.calls).toHaveLength(1);
  });

  it("maps errors from an object or an array detail", async () => {
    const run = (status: number, body: unknown) =>
      failureOf(
        connector.checkKey(context(info, mockFetch(() => jsonResponse(body, status)).fetch)),
      );
    expect(
      (
        await run(401, {
          detail: { status: "invalid_api_key", message: `Invalid API key ${SECRET}` },
        })
      ).code,
    ).toBe("invalid_key");
    expect(
      (
        await run(402, {
          detail: { type: "payment_required", code: "insufficient_credits", message: "no credits" },
        })
      ).code,
    ).toBe("quota_exhausted");
    // `quota_exceeded` arrives under 400/401 in the help center: still out of credits, not a bad key.
    expect((await run(401, { detail: { status: "quota_exceeded", message: "quota" } })).code).toBe(
      "quota_exhausted",
    );
    expect(
      (
        await run(429, {
          detail: { type: "rate_limit_error", code: "concurrent_limit_exceeded", message: "busy" },
        })
      ).code,
    ).toBe("rate_limited");
    const invalid = await run(422, {
      detail: [{ loc: ["body", "text"], msg: "field required", type: "missing" }],
    });
    expect(invalid).toMatchObject({ code: "provider_error", message: "field required" });
    const failure = await run(401, {
      detail: { status: "invalid_api_key", message: `Invalid ${SECRET}` },
    });
    expect(JSON.stringify(failure)).not.toContain(SECRET);
  });

  it("accepts a key restricted to some features (403 on the subscription, models readable)", async () => {
    const net = mockFetch((call) =>
      call.url.endsWith("/v1/user/subscription")
        ? jsonResponse(
            { detail: { code: "insufficient_permissions", message: "missing user_read" } },
            403,
          )
        : jsonResponse([]),
    );
    await expect(connector.checkKey(context(info, net.fetch))).resolves.toBeUndefined();
    expect(net.calls.map((call) => new URL(call.url).pathname)).toEqual([
      "/v1/user/subscription",
      "/v1/models",
    ]);
  });

  it("lists text-to-speech models with their character limits", async () => {
    const net = mockFetch(() =>
      jsonResponse([
        {
          model_id: "eleven_v4",
          name: "Eleven v4",
          can_do_text_to_speech: true,
          maximum_text_length_per_request: 4000,
        },
        { model_id: "eleven_multilingual_sts_v2", name: "STS", can_do_text_to_speech: false },
        {
          model_id: "eleven_flash_v2_5",
          name: "Flash",
          can_do_text_to_speech: true,
          maximum_text_length_per_request: 40000,
        },
      ]),
    );
    const models = await connector.models(context(info, net.fetch));
    expect(models.map((model) => model.id)).toEqual(["eleven_v4", "eleven_flash_v2_5"]);
    expect(models[0]).toMatchObject({ dialect: "elevenlabs-v3", maxChars: 4000 });
    expect(models[1]?.dialect).toBe("elevenlabs-v2");
    expect(models[1]).not.toHaveProperty("maxChars");
  });

  it("falls back to the documented models without a key or when the listing fails, but not on a bad key", async () => {
    const offline = mockFetch(() => jsonResponse({}, 500));
    expect(
      (await connector.models(context(info, offline.fetch))).map((model) => model.id),
    ).toContain("eleven_v4");
    const noKey = mockFetch(() => jsonResponse([]));
    await connector.models(context(info, noKey.fetch, { apiKey: null }));
    expect(noKey.calls).toHaveLength(0);
    const bad = mockFetch(() =>
      jsonResponse({ detail: { status: "invalid_api_key", message: "no" } }, 401),
    );
    expect((await failureOf(connector.models(context(info, bad.fetch)))).code).toBe("invalid_key");
  });

  it("lists voices with filters, paging and preview urls", async () => {
    const net = mockFetch(() =>
      jsonResponse({
        voices: [
          {
            voice_id: "v1",
            name: "Rachel",
            category: "premade",
            description: "Calm",
            labels: { accent: "american", gender: "female" },
            preview_url: "https://storage.googleapis.com/x.mp3",
            verified_languages: [{ language: "en", locale: "en-US" }],
          },
          { voice_id: "v2", name: "Clone", category: "cloned", labels: {}, preview_url: null },
        ],
        has_more: true,
        next_page_token: "next",
      }),
    );
    const page = await connector.voices?.(
      context(info, net.fetch),
      { search: "ra", language: "ru-RU", use_case: "narration", category: "premade" },
      "tok",
    );
    const url = new URL(net.calls[0]?.url ?? "");
    expect(url.pathname).toBe("/v2/voices");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      page_size: "30",
      include_total_count: "false",
      search: "ra",
      language: "ru",
      use_cases: "narration",
      category: "premade",
      next_page_token: "tok",
    });
    expect(page?.nextPageToken).toBe("next");
    expect(page?.voices[0]).toMatchObject({
      id: "v1",
      kind: "prebuilt",
      previewUrl: "https://storage.googleapis.com/x.mp3",
      languages: ["en-US"],
      labels: { accent: "american", gender: "female", category: "premade" },
    });
    expect(page?.voices[1]).toMatchObject({ kind: "custom", previewUrl: null });
  });

  it("builds the controls per model family", () => {
    const summary = (model: string) =>
      connector
        .controls(info, model)
        .map((control) =>
          control.kind === "slider" || control.kind === "toggle" ? control.id : control.kind,
        );
    expect(summary("eleven_v4")).toEqual(["catalog", "stability", "similarity_boost"]);
    expect(summary("eleven_v3")).toEqual(["catalog", "stability"]);
    expect(summary("eleven_multilingual_v2")).toEqual([
      "catalog",
      "stability",
      "similarity_boost",
      "style",
      "speed",
      "use_speaker_boost",
    ]);
    const v3 = connector.controls(info, "eleven_v3").find((control) => control.kind === "slider");
    expect(v3).toMatchObject({ values: [0, 0.5, 1] });
  });
});
