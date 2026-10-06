// @vitest-environment node
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { VoicePresetDraft } from "@hyperframes/agent-protocol";
import { createVoiceEngine, type VoiceEngineImpl } from "./engine.js";
import { isVoiceFailure, type VoiceFailure } from "./errors.js";
import {
  audioResponse,
  jsonResponse,
  mockFetch,
  noFfprobe,
  SECRET,
  silentWav,
  tempDir,
  type MockFetch,
} from "./testSupport.js";

let dir: string;
let cleanup: () => void;
beforeEach(() => {
  const temp = tempDir("openvids-voice-engine-");
  dir = temp.dir;
  cleanup = temp.cleanup;
});
afterEach(() => cleanup());

const NOW = Date.parse("2026-10-07T00:00:00Z");
const preset: Omit<VoicePresetDraft, "name" | "sample"> = {
  providerId: "gemini",
  model: "gemini-3.8-flash-tts",
  voice: { id: "Kore", name: "Kore", kind: "prebuilt" },
  style: "calm",
  settings: {},
};

function interaction(wav: Uint8Array) {
  return {
    status: "completed",
    steps: [
      {
        type: "model_output",
        content: [
          { type: "audio", data: Buffer.from(wav).toString("base64"), mime_type: "audio/wav" },
        ],
      },
    ],
  };
}

function engineWith(net: MockFetch, withKey = true): VoiceEngineImpl {
  const engine = createVoiceEngine({ dir, fetch: net.fetch, now: () => NOW, probe: noFfprobe });
  if (withKey) engine.setKey("gemini", SECRET);
  return engine;
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

const signal = (): AbortSignal => new AbortController().signal;

describe("VoiceEngine synthesis and cache", () => {
  it("makes the second identical request from the cache without touching the network", async () => {
    const net = mockFetch(() => jsonResponse(interaction(silentWav(2))));
    const engine = engineWith(net);
    const first = await engine.synthesize({ preset, text: "Hello there", signal: signal() });
    expect(first).toMatchObject({ cached: false, mimeType: "audio/wav" });
    expect(first.durationSeconds).toBeCloseTo(2, 4);
    // 2 s at $0.0135/min + 11 chars (3 tokens) of input at $0.50/1M.
    expect(first.usdCost).toBeCloseTo(0.00045, 5);
    expect(first.path).toBe(join(dir, "cache", `${first.hash}.wav`));

    const second = await engine.synthesize({ preset, text: "Hello there", signal: signal() });
    expect(second).toMatchObject({ cached: true, usdCost: 0, hash: first.hash, path: first.path });
    expect(net.calls).toHaveLength(1);

    // The cache holds the audio and its meta, and nothing half-written.
    expect(readdirSync(join(dir, "cache")).sort()).toEqual([
      `${first.hash}.json`,
      `${first.hash}.wav`,
    ]);
    expect(
      JSON.parse(readFileSync(join(dir, "cache", `${first.hash}.json`), "utf-8")),
    ).toMatchObject({
      schema: "openvids.voice-cache/1",
      hash: first.hash,
      mimeType: "audio/wav",
      providerId: "gemini",
      model: "gemini-3.8-flash-tts",
    });
    expect(engine.audioPath(first.hash)).toBe(first.path);
    expect(engine.peek({ preset, text: "Hello there" })).toMatchObject({
      hash: first.hash,
      audio: { cached: true },
    });
  });

  it("keys the cache by the canonical request of the spec", async () => {
    const net = mockFetch(() => jsonResponse(interaction(silentWav())));
    const engine = engineWith(net);
    const { hash } = engine.peek({
      preset: { ...preset, settings: {} },
      text: "Hello",
      previousText: "Before",
      language: "en",
    });
    const canonical = JSON.stringify({
      v: 1,
      providerId: "gemini",
      baseUrl: "https://generativelanguage.googleapis.com/v1beta",
      model: "gemini-3.8-flash-tts",
      voiceId: "Kore",
      style: "calm",
      settings: {},
      text: "Hello",
      previousText: "Before",
      nextText: "",
      language: "en",
    });
    expect(hash).toBe(createHash("sha256").update(canonical).digest("hex"));
  });

  it("splits the cache by text, voice and style, but not by what the model ignores", async () => {
    const net = mockFetch(() => jsonResponse(interaction(silentWav())));
    const engine = engineWith(net);
    const hashOf = (override: Partial<typeof preset>, text = "Hello", style?: string) =>
      engine.peek({
        preset: { ...preset, ...override },
        text,
        ...(style !== undefined && { style }),
      }).hash;
    const base = hashOf({});
    expect(hashOf({}, "Hello!")).not.toBe(base);
    expect(hashOf({ voice: { id: "Puck", name: "Puck", kind: "prebuilt" } })).not.toBe(base);
    expect(hashOf({}, "Hello", "whispering")).not.toBe(base);
    // A per-line style override wins, an empty one falls back to the preset's.
    expect(hashOf({}, "Hello", "")).toBe(base);
    // Gemini has no sliders: unknown settings are dropped, so they cannot split the cache.
    expect(hashOf({ settings: { stability: 0.3 } })).toBe(base);
  });

  it("sanitises settings to the controls of the model (clamp, snap to allowed values)", async () => {
    const net = mockFetch(() => audioResponse(silentWav()));
    const engine = engineWith(net, false);
    engine.setKey("elevenlabs", SECRET);
    const eleven = {
      ...preset,
      providerId: "elevenlabs" as const,
      model: "eleven_v3",
      voice: { id: "v", name: "v", kind: "prebuilt" as const },
      style: "",
    };
    const hashOf = (settings: Record<string, number | boolean>) =>
      engine.peek({ preset: { ...eleven, settings }, text: "Hi [whispers]" }).hash;
    expect(hashOf({ stability: 0.4 })).toBe(hashOf({ stability: 0.5 }));
    expect(hashOf({ stability: 7 })).toBe(hashOf({ stability: 1 }));
    expect(hashOf({ stability: 0.5, speed: 1.1 })).toBe(hashOf({ stability: 0.5 }));
    await engine.synthesize({
      preset: { ...eleven, settings: { stability: 0.4, speed: 1.1 } },
      text: "Hi [whispers]",
      signal: signal(),
    });
    expect(net.calls[0]?.body).toMatchObject({ voice_settings: { stability: 0.5 } });
  });

  it("refuses a provider that is not configured before any network call", async () => {
    const net = mockFetch(() => jsonResponse({}));
    const engine = engineWith(net, false);
    const failure = await failureOf(engine.synthesize({ preset, text: "Hi", signal: signal() }));
    expect(failure.code).toBe("not_configured");
    expect(net.calls).toHaveLength(0);
  });

  it("refuses empty text and an over-long style", async () => {
    const engine = engineWith(mockFetch(() => jsonResponse({})));
    expect(
      (await failureOf(engine.synthesize({ preset, text: "   ", signal: signal() }))).code,
    ).toBe("invalid_request");
    expect(
      (
        await failureOf(
          engine.synthesize({ preset, text: "Hi", style: "x".repeat(5000), signal: signal() }),
        )
      ).code,
    ).toBe("invalid_request");
  });

  it("scrubs the key out of a provider's error and writes nothing to the cache", async () => {
    const net = mockFetch(() =>
      jsonResponse(
        {
          error: {
            code: "invalid_request",
            message: `Request with ${SECRET} was rejected: ${SECRET}`,
          },
        },
        400,
      ),
    );
    const engine = engineWith(net);
    const failure = await failureOf(engine.synthesize({ preset, text: "Hi", signal: signal() }));
    expect(failure.code).toBe("provider_error");
    expect(failure.message).toContain("***");
    expect(JSON.stringify(failure)).not.toContain(SECRET);
    expect(existsSync(join(dir, "cache"))).toBe(false);
  });

  it("turns a non-audio answer into not_audio and caches nothing", async () => {
    const net = mockFetch(
      () =>
        new Response("<html>maintenance</html>", {
          status: 200,
          headers: { "content-type": "text/html" },
        }),
    );
    const engine = createVoiceEngine({ dir, fetch: net.fetch, now: () => NOW, probe: noFfprobe });
    engine.setKey("openai", SECRET);
    const failure = await failureOf(
      engine.synthesize({
        preset: {
          ...preset,
          providerId: "openai",
          model: "tts-1",
          voice: { id: "alloy", name: "alloy", kind: "prebuilt" },
          style: "",
        },
        text: "Hi",
        signal: signal(),
      }),
    );
    expect(failure).toMatchObject({
      code: "not_audio",
      params: { contentType: "text/html", body: "<html>maintenance</html>" },
    });
    expect(existsSync(join(dir, "cache"))).toBe(false);
  });

  it("shares one provider call between identical concurrent requests", async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const net = mockFetch(async () => {
      await gate;
      return jsonResponse(interaction(silentWav()));
    });
    const engine = engineWith(net);
    const a = engine.synthesize({ preset, text: "Same", signal: signal() });
    const b = engine.synthesize({ preset, text: "Same", signal: signal() });
    release();
    const [first, second] = await Promise.all([a, b]);
    expect(net.calls).toHaveLength(1);
    expect(first.hash).toBe(second.hash);
  });

  it("cancels the provider call only when every caller has given up", async () => {
    const started = Promise.withResolvers<AbortSignal>();
    // Like a real fetch: pending until its signal aborts.
    const pending = Object.assign(
      (_input: string | URL | Request, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          const signal = init?.signal;
          if (!signal) return;
          started.resolve(signal);
          signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
        }),
      { preconnect: () => undefined },
    );
    const engine = engineWith({ fetch: pending, calls: [] });
    const one = new AbortController();
    const two = new AbortController();
    const a = engine.synthesize({ preset, text: "Abort me", signal: one.signal });
    const b = engine.synthesize({ preset, text: "Abort me", signal: two.signal });
    const providerSignal = await started.promise;
    one.abort();
    expect((await failureOf(a)).code).toBe("cancelled");
    expect(providerSignal.aborted).toBe(false);
    two.abort();
    expect((await failureOf(b)).code).toBe("cancelled");
    expect(providerSignal.aborted).toBe(true);
  });
});

describe("VoiceEngine providers, keys and check", () => {
  it("never answers a key and stores it trimmed; rejects keys with odd characters", () => {
    const engine = engineWith(
      mockFetch(() => jsonResponse({})),
      false,
    );
    const provider = engine.setKey("openai", `  ${SECRET}\n`);
    expect(provider).toMatchObject({ hasKey: true, configured: true });
    expect(engine.keys.get("openai")).toBe(SECRET);
    expect(JSON.stringify(engine.listProviders())).not.toContain(SECRET);
    expect(engine.listProviders().map((entry) => entry.id)).toEqual([
      "gemini",
      "openai",
      "openrouter",
      "elevenlabs",
      "custom",
    ]);
    for (const key of ["", "   ", "has space", "ключ"]) {
      try {
        engine.setKey("openai", key);
        throw new Error("should have failed");
      } catch (error) {
        expect(isVoiceFailure(error) && error.code).toBe("invalid_request");
      }
    }
    expect(engine.removeKey("openai")).toMatchObject({ hasKey: false, configured: false });
  });

  it("checks a key with the cheap call and speaks a sample into the cache", async () => {
    const net = mockFetch((call) =>
      call.url.includes("/voices")
        ? jsonResponse({ voices: [] })
        : jsonResponse(interaction(silentWav())),
    );
    const engine = engineWith(net);
    const result = await engine.checkKey("gemini", signal());
    expect(result.ok).toBe(true);
    expect(result.sample).toMatchObject({
      mimeType: "audio/wav",
      url: expect.stringMatching(/^\/api\/voice\/audio\/[0-9a-f]{64}$/),
    });
    expect(net.calls.map((call) => new URL(call.url).pathname)).toEqual([
      "/v1beta/voices",
      "/v1beta/interactions",
    ]);
    expect(net.calls[1]?.body).toMatchObject({
      generation_config: { speech_config: [{ voice: "Kore" }] },
    });
  });

  it("still succeeds when only the sample fails, and reports a bad key as invalid_key", async () => {
    const sampleFails = mockFetch((call) =>
      call.url.includes("/voices")
        ? jsonResponse({ voices: [] })
        : jsonResponse({ error: { code: "api_error", message: "down" } }, 500),
    );
    expect(await engineWith(sampleFails).checkKey("gemini", signal())).toEqual({
      ok: true,
      sample: null,
    });
    const bad = mockFetch(() =>
      jsonResponse({ error: { code: "authentication", message: "no" } }, 401),
    );
    expect((await failureOf(engineWith(bad).checkKey("gemini", signal()))).code).toBe(
      "invalid_key",
    );
    const noKey = engineWith(mockFetch(() => jsonResponse({})));
    noKey.removeKey("gemini");
    expect((await failureOf(noKey.checkKey("gemini", signal()))).code).toBe("not_configured");
  });

  it("answers controls for the model with the dialect and prices", async () => {
    const engine = engineWith(mockFetch(() => jsonResponse({})));
    const controls = await engine.controls("gemini", undefined, signal());
    expect(controls).toMatchObject({
      model: "gemini-3.8-flash-tts",
      dialect: { id: "gemini-tts" },
    });
    expect(controls.provider).toMatchObject({ id: "gemini", hasKey: true });
    expect(JSON.stringify(controls)).not.toContain(SECRET);
    expect(controls.controls.map((control) => control.kind)).toEqual([
      "catalog",
      "voice_design",
      "style",
    ]);
    expect(
      controls.models.find((model) => model.id === "gemini-3.8-flash-tts")?.usdPerMinute,
    ).toBeGreaterThan(0);
    const other = await engine.controls("gemini", "gemini-9-future-tts", signal());
    expect(other.models.some((model) => model.id === "gemini-9-future-tts")).toBe(true);
    expect(other.dialect.id).toBe("gemini-tts");
  });

  it("refuses catalog and voice design where the provider has none", async () => {
    const engine = createVoiceEngine({
      dir,
      fetch: mockFetch(() => jsonResponse({})).fetch,
      probe: noFfprobe,
    });
    engine.providers.update("custom", { baseUrl: "http://127.0.0.1:1/v1", model: "m" });
    expect((await failureOf(engine.voices("custom", {}, null, signal()))).code).toBe("unsupported");
    expect(
      (await failureOf(engine.designVoice("custom", { name: "n", description: "d" }, signal())))
        .code,
    ).toBe("unsupported");
    engine.setKey("elevenlabs", SECRET);
    expect(
      (await failureOf(engine.designVoice("elevenlabs", { name: "n", description: "d" }, signal())))
        .code,
    ).toBe("unsupported");
  });

  it("prices OpenRouter models from their listing once listed", async () => {
    const net = mockFetch(() =>
      jsonResponse({
        data: [
          {
            id: "hexgrad/kokoro-82m",
            name: "Kokoro",
            architecture: { tokenizer: "Other" },
            pricing: { prompt: "0.000001", completion: "0" },
          },
        ],
      }),
    );
    const engine = engineWith(net);
    engine.setKey("openrouter", SECRET);
    expect(
      engine.estimateCost("openrouter", "hexgrad/kokoro-82m", { chars: 1000, seconds: 60 }),
    ).toBeNull();
    const models = await engine.models("openrouter", signal());
    expect(models.find((model) => model.id === "hexgrad/kokoro-82m")?.usdPerMinute).toBeCloseTo(
      0.0009,
      8,
    );
    expect(
      engine.estimateCost("openrouter", "hexgrad/kokoro-82m", { chars: 1000, seconds: 60 }),
    ).toBeCloseTo(0.001, 8);
  });
});

describe("VoiceEngine voice design and presets", () => {
  it("designs a voice and puts the instant sample into the cache like a synthesis", async () => {
    const wav = silentWav();
    const net = mockFetch(() =>
      jsonResponse({
        id: "voice_abc",
        display_name: "Astronomer",
        type: "prompted",
        sample_audio: { mime_type: "audio/wav", data: Buffer.from(wav).toString("base64") },
      }),
    );
    const engine = engineWith(net);
    const result = await engine.designVoice(
      "gemini",
      { name: "Astronomer", description: "Warm.", gender: "male" },
      signal(),
    );
    expect(result.voice).toMatchObject({
      id: "voice_abc",
      kind: "designed",
      description: "Warm.",
      labels: { gender: "male" },
      previewUrl: null,
    });
    expect(result.sample?.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(engine.audioPath(result.sample?.hash ?? "")).not.toBeNull();
  });

  it("attaches a sample only when its hash names a cache entry this server made", async () => {
    const net = mockFetch(() => jsonResponse(interaction(silentWav())));
    const engine = engineWith(net);
    const sample = await engine.sample(
      { preset: { ...preset, name: "Narrator" }, text: "Hello" },
      signal(),
    );
    expect(sample.audio.hash).toMatch(/^[0-9a-f]{64}$/);
    const draft = { ...preset, name: "Narrator" };

    const created = engine.createPreset(draft, {
      sampleHash: sample.audio.hash,
      sampleText: "Hello",
    });
    expect(created.sample).toMatchObject({ text: "Hello", audio: sample.audio });
    expect(engine.listPresets()).toHaveLength(1);
    expect(await engine.preset(created.id)).toEqual(created);
    expect(await engine.preset("vp-nothing")).toBeNull();

    for (const options of [
      { sampleHash: "f".repeat(64), sampleText: "x" },
      { sampleHash: "../../etc/passwd", sampleText: "x" },
      { sampleHash: sample.audio.hash },
    ]) {
      try {
        engine.createPreset(draft, options);
        throw new Error("should have failed");
      } catch (error) {
        expect(isVoiceFailure(error) && error.code).toBe("invalid_request");
      }
    }
    expect(engine.listPresets()).toHaveLength(1);
    expect(engine.updatePreset(created.id, { ...draft, name: "Renamed" }, {}).sample).toEqual(
      created.sample,
    );
    engine.deletePreset(created.id);
    expect(engine.listPresets()).toEqual([]);
  });

  it("answers a sample request with the audio reference, the cache flag and the cost", async () => {
    const net = mockFetch(() => jsonResponse(interaction(silentWav())));
    const engine = engineWith(net);
    const request = { preset: { ...preset, name: "x" }, text: "Hello" };
    expect(await engine.sample(request, signal())).toMatchObject({
      cached: false,
      audio: { mimeType: "audio/wav" },
    });
    const again = await engine.sample(request, signal());
    expect(again).toMatchObject({ cached: true, usdCost: 0 });
    expect(net.calls).toHaveLength(1);
  });
});
