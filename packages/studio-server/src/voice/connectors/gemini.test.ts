// @vitest-environment node
import { describe, expect, it } from "vitest";
import { isVoiceFailure, type VoiceFailure } from "../errors.js";
import { context, jsonResponse, mockFetch, provider, SECRET, silentWav } from "../testSupport.js";
import { geminiConnector } from "./gemini.js";

const info = provider({ id: "gemini" });
const voice = { id: "Kore", name: "Kore", kind: "prebuilt" as const };

function interaction(bytes: Uint8Array, extra: Record<string, unknown> = {}) {
  return {
    object: "interaction",
    status: "completed",
    steps: [
      {
        type: "model_output",
        content: [
          {
            type: "audio",
            data: Buffer.from(bytes).toString("base64"),
            mime_type: "audio/wav",
            ...extra,
          },
        ],
      },
    ],
  };
}

async function failureOf(run: Promise<unknown>): Promise<VoiceFailure> {
  try {
    await run;
  } catch (error) {
    if (isVoiceFailure(error)) return error;
    throw error;
  }
  throw new Error("expected a VoiceFailure");
}

describe("gemini connector", () => {
  it("synthesizes through the Interactions API with store:false and the style as an annotation", async () => {
    const wav = silentWav(2);
    const net = mockFetch(() => jsonResponse(interaction(wav)));
    const audio = await geminiConnector.synthesize(context(info, net.fetch), {
      model: "gemini-3.8-flash-tts",
      voice,
      style: "warm and slow",
      settings: {},
      text: "Hello <short pause> there",
    });
    const call = net.calls[0];
    expect(call?.url).toBe("https://generativelanguage.googleapis.com/v1beta/interactions");
    expect(call?.method).toBe("POST");
    expect(call?.headers["x-goog-api-key"]).toBe(SECRET);
    expect(call?.body).toEqual({
      model: "gemini-3.8-flash-tts",
      store: false,
      input: [
        {
          type: "user_input",
          content: [
            {
              type: "text",
              text: "Hello <short pause> there",
              annotations: [{ type: "speech_metadata", style: "warm and slow" }],
            },
          ],
        },
      ],
      response_format: { type: "audio", mime_type: "audio/wav" },
      generation_config: { speech_config: [{ voice: "Kore" }] },
    });
    expect(audio.format).toBe("wav");
    expect(audio.bytes).toEqual(wav);
  });

  it("sends no annotation without a style and takes the LAST audio block of the model output", async () => {
    const first = silentWav(1);
    const last = silentWav(3);
    const net = mockFetch(() =>
      jsonResponse({
        steps: [
          { type: "thought", content: [{ type: "text", text: "x" }] },
          {
            type: "model_output",
            content: [{ type: "audio", data: Buffer.from(first).toString("base64") }],
          },
          {
            type: "model_output",
            content: [{ type: "audio", data: Buffer.from(last).toString("base64") }],
          },
        ],
      }),
    );
    const audio = await geminiConnector.synthesize(context(info, net.fetch), {
      model: "gemini-3.8-flash-tts",
      voice,
      style: "",
      settings: {},
      text: "Hi",
    });
    expect(JSON.stringify(net.calls[0]?.body)).not.toContain("annotations");
    expect(audio.bytes).toEqual(last);
  });

  it("reads a raw PCM block (audio/l16) at its rate", async () => {
    const pcm = new Uint8Array(4800);
    const net = mockFetch(() =>
      jsonResponse({
        steps: [
          {
            type: "model_output",
            content: [
              {
                type: "audio",
                data: Buffer.from(pcm).toString("base64"),
                mime_type: "audio/l16;rate=24000",
              },
            ],
          },
        ],
      }),
    );
    const audio = await geminiConnector.synthesize(context(info, net.fetch), {
      model: "gemini-3.8-flash-tts",
      voice,
      style: "",
      settings: {},
      text: "Hi",
    });
    expect(audio).toMatchObject({ format: "pcm", sampleRate: 24000 });
  });

  it("answers not_audio with what Google said when there is no audio block", async () => {
    const net = mockFetch(() =>
      jsonResponse({
        status: "completed",
        steps: [{ type: "model_output", content: [{ type: "text", text: "I cannot say that" }] }],
      }),
    );
    const failure = await failureOf(
      geminiConnector.synthesize(context(info, net.fetch), {
        model: "gemini-3.8-flash-tts",
        voice,
        style: "",
        settings: {},
        text: "Hi",
      }),
    );
    expect(failure.code).toBe("not_audio");
    expect(failure.params?.contentType).toBe("application/json");
    expect(String(failure.params?.body)).toContain("I cannot say that");
  });

  it("maps errors: 401 authentication → invalid_key without echoing anything", async () => {
    const net = mockFetch(() =>
      jsonResponse({ error: { code: "authentication", message: `bad key ${SECRET}` } }, 401),
    );
    const failure = await failureOf(geminiConnector.checkKey(context(info, net.fetch)));
    expect(failure.code).toBe("invalid_key");
    expect(failure.message).not.toContain(SECRET);
    expect(net.calls[0]?.url).toBe(
      "https://generativelanguage.googleapis.com/v1beta/voices?page_size=1",
    );
  });

  it("maps the legacy API_KEY_INVALID 400 to invalid_key", async () => {
    const net = mockFetch(() =>
      jsonResponse(
        {
          error: {
            code: 400,
            status: "INVALID_ARGUMENT",
            message: "API key not valid. Please pass a valid API key.",
            details: [
              { "@type": "type.googleapis.com/google.rpc.ErrorInfo", reason: "API_KEY_INVALID" },
            ],
          },
        },
        400,
      ),
    );
    expect((await failureOf(geminiConnector.checkKey(context(info, net.fetch)))).code).toBe(
      "invalid_key",
    );
  });

  it("maps 429 with a retryDelay, and a daily quota with daily:1", async () => {
    const delayed = mockFetch(() =>
      jsonResponse(
        {
          error: {
            code: 429,
            status: "RESOURCE_EXHAUSTED",
            message: "slow down",
            details: [{ "@type": "type.googleapis.com/google.rpc.RetryInfo", retryDelay: "45s" }],
          },
        },
        429,
      ),
    );
    const limited = await failureOf(geminiConnector.checkKey(context(info, delayed.fetch)));
    expect(limited.code).toBe("rate_limited");
    expect(limited.params).toEqual({ retryAfterSeconds: 45 });

    const daily = mockFetch(() =>
      jsonResponse({ error: { code: "quota_exceeded", message: "daily" } }, 429, {
        "retry-after": "7",
      }),
    );
    const spent = await failureOf(geminiConnector.checkKey(context(info, daily.fetch)));
    expect(spent.params).toEqual({ retryAfterSeconds: 7, daily: 1 });

    const perDay = mockFetch(() =>
      jsonResponse(
        {
          error: {
            code: 429,
            message: "quota",
            details: [{ violations: [{ quotaId: "GenerateRequestsPerDayPerProjectPerModel" }] }],
          },
        },
        429,
      ),
    );
    expect((await failureOf(geminiConnector.checkKey(context(info, perDay.fetch)))).params).toEqual(
      { daily: 1 },
    );
  });

  it("reads the free tier's per-minute 429 as seen live: retry time from the message, not daily", async () => {
    const body = {
      error: {
        code: "too_many_requests",
        message:
          "Rate limit exceeded for model gemini-3.8-flash-tts (limit: 3 requests per minute on Free Tier). Please retry in 11s or upgrade your tier at https://ai.dev/rate-limit.",
      },
    };
    const noHeader = mockFetch(() => jsonResponse(body, 429));
    const limited = await failureOf(geminiConnector.checkKey(context(info, noHeader.fetch)));
    expect(limited.code).toBe("rate_limited");
    expect(limited.params).toEqual({ retryAfterSeconds: 11 });
  });

  it("maps 402 to quota_exhausted and 500 to provider_error", async () => {
    const paid = mockFetch(() =>
      jsonResponse({ error: { code: "payment_required", message: "no credit" } }, 402),
    );
    expect((await failureOf(geminiConnector.checkKey(context(info, paid.fetch)))).code).toBe(
      "quota_exhausted",
    );
    const broken = mockFetch(() =>
      jsonResponse({ error: { code: "api_error", message: "oops" } }, 500),
    );
    const failure = await failureOf(geminiConnector.checkKey(context(info, broken.fetch)));
    expect(failure).toMatchObject({ code: "provider_error", params: { status: 500 } });
  });

  it("reports an unreachable server without the key", async () => {
    const failure = await failureOf(
      geminiConnector.checkKey(
        context(
          info,
          Object.assign(
            async () => {
              throw new TypeError(`fetch failed ${SECRET}`);
            },
            { preconnect: () => undefined },
          ),
        ),
      ),
    );
    expect(failure.code).toBe("provider_unreachable");
    expect(failure.message).not.toContain(SECRET);
  });

  it("lists the catalog with the documented filters and paginates", async () => {
    const net = mockFetch(() =>
      jsonResponse({
        voices: [
          {
            id: "Puck",
            display_name: "Puck",
            description: "Upbeat",
            language_code: "en-US",
            gender: "male",
            type: "prebuilt",
          },
          { id: "voice_abc", display_name: "Mine", type: "prompted" },
        ],
        next_page_token: "tok2",
      }),
    );
    const page = await geminiConnector.voices?.(
      context(info, net.fetch),
      { gender: "male", language_code: "en-US", type: "prebuilt", search: "puck" },
      "tok1",
    );
    const url = new URL(net.calls[0]?.url ?? "");
    expect(url.pathname).toBe("/v1beta/voices");
    expect(url.searchParams.get("gender")).toBe("male");
    expect(url.searchParams.get("language_code")).toBe("en-US");
    expect(url.searchParams.get("search")).toBe("puck");
    expect(url.searchParams.get("page_size")).toBe("50");
    expect(url.searchParams.get("page_token")).toBe("tok1");
    expect(page?.nextPageToken).toBe("tok2");
    expect(page?.voices[0]).toMatchObject({
      id: "Puck",
      name: "Puck",
      kind: "prebuilt",
      languages: ["en-US"],
      labels: { gender: "male" },
      previewUrl: null,
    });
    expect(page?.voices[1]?.kind).toBe("designed");
  });

  it("matches a bare language ('ru') by primary subtag on the client", async () => {
    const net = mockFetch(() =>
      jsonResponse({
        voices: [
          { id: "A", language_code: "ru-RU" },
          { id: "B", language_code: "en-US" },
          { id: "C", language_code: "RU" },
        ],
      }),
    );
    const page = await geminiConnector.voices?.(
      context(info, net.fetch),
      { language_code: "ru" },
      null,
    );
    expect(new URL(net.calls[0]?.url ?? "").searchParams.has("language_code")).toBe(false);
    expect(page?.voices.map((entry) => entry.id)).toEqual(["A", "C"]);
  });

  it("designs a prompted voice with store:true and returns its instant sample", async () => {
    const wav = silentWav(1);
    const net = mockFetch(() =>
      jsonResponse({
        id: "voice_abc123",
        display_name: "Astronomer",
        type: "prompted",
        sample_audio: { mime_type: "audio/wav", data: Buffer.from(wav).toString("base64") },
      }),
    );
    const result = await geminiConnector.designVoice?.(context(info, net.fetch), {
      name: "Astronomer",
      description: "A warm British astronomer.",
      language: "en-GB",
      gender: "male",
    });
    expect(net.calls[0]?.url).toBe("https://generativelanguage.googleapis.com/v1beta/voices");
    expect(net.calls[0]?.body).toEqual({
      store: true,
      voice: {
        type: "prompted",
        display_name: "Astronomer",
        prompted: { input: "A warm British astronomer." },
        gender: "male",
        language_code: "en-GB",
      },
    });
    expect(result?.voice).toMatchObject({
      id: "voice_abc123",
      kind: "designed",
      description: "A warm British astronomer.",
    });
    expect(result?.sample?.bytes).toEqual(wav);
  });

  it("offers voice design and style only where documented", () => {
    const kinds = (model: string) =>
      geminiConnector.controls(info, model).map((control) => control.kind);
    expect(kinds("gemini-3.8-flash-tts")).toEqual(["catalog", "voice_design", "style"]);
    expect(kinds("gemini-3.1-flash-tts-preview")).toEqual(["catalog", "style"]);
  });

  it("does not follow redirects", async () => {
    const net = mockFetch(
      () => new Response(null, { status: 302, headers: { location: "https://evil.example/" } }),
    );
    const failure = await failureOf(geminiConnector.checkKey(context(info, net.fetch)));
    expect(failure.code).toBe("provider_error");
  });
});
