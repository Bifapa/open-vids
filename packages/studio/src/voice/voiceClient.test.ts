import { describe, expect, it, vi } from "vitest";
import { createVoiceClient, VoiceApiError } from "./voiceClient";
import {
  audioRef,
  catalogPage,
  freshProviders,
  providerControls,
  providerInfo,
  scriptView,
  voicePreset,
} from "./voiceTestHarness";

interface Call {
  url: string;
  method: string;
  body: unknown;
}

/** A client over a scripted fetch: `answer(call)` decides what each request gets. */
function clientWith(answer: (call: Call) => Response) {
  const calls: Call[] = [];
  const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const call: Call = {
      url: String(input),
      method: init?.method ?? "GET",
      body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
    };
    calls.push(call);
    return answer(call);
  });
  return { client: createVoiceClient(fetchImpl), calls };
}

const ok = (body: unknown, init?: ResponseInit) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
    ...init,
  });

const failure = (status: number, error: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify({ error }), { status, headers });

describe("the global routes", () => {
  it("reads the providers and sends a key without ever asking it back", async () => {
    const { client, calls } = clientWith((call) =>
      call.url.endsWith("/api-key")
        ? ok({ provider: providerInfo() })
        : ok({ providers: freshProviders() }),
    );
    expect(await client.providers()).toHaveLength(5);
    const provider = await client.setApiKey("gemini", "sk-secret");
    expect(provider.hasKey).toBe(true);
    expect(calls[1]).toMatchObject({
      url: "/api/voice/providers/gemini/api-key",
      method: "PUT",
      body: { key: "sk-secret" },
    });
    await client.removeApiKey("gemini");
    expect(calls[2]).toMatchObject({
      url: "/api/voice/providers/gemini/api-key",
      method: "DELETE",
    });
  });

  it("updates a provider, checks its key and reads its controls for a model", async () => {
    const { client, calls } = clientWith((call) => {
      if (call.url.endsWith("/check")) return ok({ ok: true, sample: audioRef() });
      if (call.url.includes("/controls")) return ok(providerControls());
      return ok({ provider: providerInfo({ model: "gemini-3.8-flash-lite-tts" }) });
    });
    await client.updateProvider("gemini", { model: "gemini-3.8-flash-lite-tts" });
    expect(calls[0]).toMatchObject({
      url: "/api/voice/providers/gemini",
      method: "PUT",
      body: { model: "gemini-3.8-flash-lite-tts" },
    });
    expect((await client.checkProvider("gemini")).sample?.durationSeconds).toBe(2.4);
    await client.controls("gemini", "gemini-3.8-flash-lite-tts");
    await client.controls("openai");
    expect(calls[2].url).toBe(
      "/api/voice/providers/gemini/controls?model=gemini-3.8-flash-lite-tts",
    );
    expect(calls[3].url).toBe("/api/voice/providers/openai/controls");
  });

  it("pages the catalog with the filters that are set, the model and the page token", async () => {
    const { client, calls } = clientWith(() => ok(catalogPage()));
    await client.voices("gemini", {
      filters: { language_code: "ru", gender: " ", search: "warm voice" },
      model: "gemini-3.8-flash-tts",
      pageToken: "t2",
    });
    const url = new URL(calls[0].url, "http://studio.local");
    expect(url.pathname).toBe("/api/voice/providers/gemini/voices");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      language_code: "ru",
      search: "warm voice",
      model: "gemini-3.8-flash-tts",
      pageToken: "t2",
    });
  });

  it("designs a voice, makes samples and plays them from the cache", async () => {
    const { client, calls } = clientWith((call) => {
      if (call.url.endsWith("/voices"))
        return ok({ voice: catalogPage().voices[0], sample: audioRef() });
      return ok({ audio: audioRef(), cached: true, usdCost: null });
    });
    const designed = await client.designVoice("gemini", { name: "A", description: "warm" });
    expect(designed.voice.id).toBe("Kore");
    const sample = await client.sample({
      preset: {
        name: "x",
        providerId: "gemini",
        model: "m",
        voice: { id: "Kore", name: "Kore", kind: "prebuilt" },
        style: "",
        settings: {},
      },
      text: "Hello",
    });
    expect(sample).toMatchObject({ cached: true, usdCost: null });
    expect(calls[1]).toMatchObject({ url: "/api/voice/sample", method: "POST" });
    expect(client.audioUrl("a".repeat(64))).toBe(`/api/voice/audio/${"a".repeat(64)}`);
  });

  it("creates, renames and deletes presets", async () => {
    const { client, calls } = clientWith((call) =>
      call.method === "DELETE"
        ? ok({ ok: true })
        : call.method === "GET"
          ? ok({ presets: [voicePreset()] })
          : ok({ preset: voicePreset() }),
    );
    expect(await client.presets()).toHaveLength(1);
    const request = {
      preset: {
        name: "Warm",
        providerId: "gemini" as const,
        model: "m",
        voice: { id: "Kore", name: "Kore", kind: "prebuilt" as const },
        style: "",
        settings: {},
      },
      sampleHash: "a".repeat(64),
      sampleText: "Hello",
    };
    await client.createPreset(request);
    await client.updatePreset("preset 1", request);
    await client.deletePreset("preset 1");
    expect(calls.map((call) => `${call.method} ${call.url}`)).toEqual([
      "GET /api/voice/presets",
      "POST /api/voice/presets",
      "PUT /api/voice/presets/preset%201",
      "DELETE /api/voice/presets/preset%201",
    ]);
    expect(calls[1].body).toEqual(request);
  });
});

describe("the project routes", () => {
  it("reads and saves the script, sets the voice and picks a take", async () => {
    const { client, calls } = clientWith(() => ok(scriptView({ voice: voicePreset() })));
    expect((await client.script("demo")).voice?.name).toBe("Warm narrator");
    await client.saveScript("demo", { lines: [{ text: "Hi" }] });
    await client.setProjectVoice("demo", { presetId: "preset1" });
    await client.selectTake("demo", "l 1", { takeId: "t1" });
    expect(calls.map((call) => `${call.method} ${call.url}`)).toEqual([
      "GET /api/projects/demo/voice/script",
      "PUT /api/projects/demo/voice/script",
      "PUT /api/projects/demo/voice/voice",
      "PUT /api/projects/demo/voice/lines/l%201/take",
    ]);
    expect(calls[2].body).toEqual({ presetId: "preset1" });
  });

  it("follows and cancels a synthesis request", async () => {
    const { client, calls } = clientWith((call) =>
      call.url.endsWith("/cancel")
        ? ok({ requestId: "req-12345", state: "cancelled" })
        : ok({ requestId: "req-12345", state: "running", done: 1, total: 3, lineId: "l1" }),
    );
    expect((await client.progress("demo", "req-12345")).done).toBe(1);
    await client.cancel("demo", "req-12345");
    expect(calls[1]).toMatchObject({
      url: "/api/projects/demo/voice/requests/req-12345/cancel",
      method: "POST",
    });
  });
});

describe("failures", () => {
  it("say what the code means, in Studio's words", async () => {
    const { client } = clientWith(() =>
      failure(401, { code: "invalid_key", message: "API key not valid." }),
    );
    const error = await client.checkProvider("gemini").catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(VoiceApiError);
    if (!(error instanceof VoiceApiError)) throw error;
    expect(error).toMatchObject({ status: 401, code: "invalid_key" });
    expect(error.message).toBe(
      "The service rejected this key. Check that it is correct and allows speech generation.",
    );
  });

  it("tell a daily quota from a short wait, from the params or the Retry-After header", async () => {
    const daily = clientWith(() =>
      failure(429, { code: "rate_limited", message: "quota", params: { daily: 1 } }),
    );
    expect(await daily.client.checkProvider("gemini").catch((r: unknown) => String(r))).toContain(
      "daily limit",
    );
    const header = clientWith(() =>
      failure(429, { code: "rate_limited", message: "slow down" }, { "retry-after": "12" }),
    );
    const error = await header.client.checkProvider("gemini").catch((reason: unknown) => reason);
    if (!(error instanceof VoiceApiError)) throw new Error("expected a VoiceApiError");
    expect(error.retryAfterSeconds).toBe(12);
    expect(error.message).toBe("The service asks you to slow down. Try again in 12 seconds.");
  });

  it("carry a dialect violation's findings and a non-audio answer's body", async () => {
    const issues = [
      { lineId: "l1", code: "unknown_tag", severity: "error", message: "<boom> is not a tag" },
    ];
    const violation = clientWith(() =>
      failure(422, { code: "dialect_violation", message: "bad script", issues }),
    );
    const error = await violation.client
      .synthesize("demo", { requestId: "req-12345" })
      .catch((reason: unknown) => reason);
    if (!(error instanceof VoiceApiError)) throw new Error("expected a VoiceApiError");
    expect(error.code).toBe("dialect_violation");
    expect(error.issues).toEqual(issues);

    const notAudio = clientWith(() =>
      failure(502, {
        code: "not_audio",
        message: "x",
        params: { contentType: "text/html", body: "<html>login</html>" },
      }),
    );
    const html = await notAudio.client.checkProvider("custom").catch((reason: unknown) => reason);
    if (!(html instanceof VoiceApiError)) throw new Error("expected a VoiceApiError");
    expect(html.message).toBe(
      "The server answered with something that isn’t audio (text/html). It said: “<html>login</html>”",
    );
  });

  it("fall back to the server's own message for a code Studio does not know, and to the status for no body", async () => {
    const odd = clientWith(() => failure(500, { code: "brand_new", message: "Something new" }));
    expect(await odd.client.providers().catch((r: unknown) => String(r))).toContain(
      "Something new",
    );
    const bare = clientWith(() => new Response("oops", { status: 503 }));
    const error = await bare.client.providers().catch((reason: unknown) => reason);
    if (!(error instanceof VoiceApiError)) throw new Error("expected a VoiceApiError");
    expect(error).toMatchObject({ status: 503, code: null });
    expect(error.message).toBe("The voice service answered with an error (503).");
  });

  it("refuse an answer that is not what the route promises, and a request that never arrived", async () => {
    const wrong = clientWith(() => ok({ providers: [{ id: "gemini" }] }));
    const bad = await wrong.client.providers().catch((reason: unknown) => reason);
    if (!(bad instanceof VoiceApiError)) throw new Error("expected a VoiceApiError");
    expect(bad.message).toBe("The voice service gave an unexpected answer.");
    const down = createVoiceClient(async () => {
      throw new Error("connection refused");
    });
    expect(await down.providers().catch((r: unknown) => String(r))).toContain("connection refused");
  });

  it("lets a cancelled request's abort through as the caller's own doing", async () => {
    const controller = new AbortController();
    const client = createVoiceClient(async () => {
      controller.abort();
      throw new DOMException("aborted", "AbortError");
    });
    const error = await client.providers(controller.signal).catch((reason: unknown) => reason);
    expect(error).not.toBeInstanceOf(VoiceApiError);
    expect(error).toBeInstanceOf(DOMException);
  });
});
