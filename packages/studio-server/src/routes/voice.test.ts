// @vitest-environment node
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createAnalysisProject, type TestProject } from "../analysis/testSupport.js";
import { createVoiceEngine, type VoiceEngineImpl } from "../voice/engine.js";
import {
  jsonResponse,
  mockFetch,
  noFfprobe,
  SECRET,
  silentWav,
  tempDir,
  type MockFetch,
} from "../voice/testSupport.js";
import { registerVoiceRoutes } from "./voice.js";

const HOST = { host: "localhost:5190" };
const FOREIGN = { host: "localhost:5190", origin: "https://evil.example" };
const OWN = { host: "localhost:5190", origin: "http://localhost:5190" };

let project: TestProject;
let cleanup: () => void;
let dir: string;
let api: Hono;
let engine: VoiceEngineImpl;
let net: MockFetch;
let respond: (url: string) => Response;

const interaction = (wav: Uint8Array) => ({
  status: "completed",
  steps: [
    {
      type: "model_output",
      content: [{ type: "audio", data: Buffer.from(wav).toString("base64") }],
    },
  ],
});

beforeEach(() => {
  const temp = tempDir("openvids-voice-routes-");
  dir = join(temp.dir, "voice");
  project = createAnalysisProject({ speech: false });
  cleanup = () => {
    temp.cleanup();
    project.cleanup();
  };
  respond = (url) =>
    url.includes("/voices")
      ? jsonResponse({
          voices: [{ id: "Kore", display_name: "Kore", type: "prebuilt", language_code: "en-US" }],
          next_page_token: "next",
        })
      : jsonResponse(interaction(silentWav(2)));
  net = mockFetch((call) => respond(call.url));
  engine = createVoiceEngine({
    dir,
    fetch: net.fetch,
    now: () => Date.parse("2026-10-07T00:00:00Z"),
    probe: noFfprobe,
  });
  api = new Hono();
  expect(registerVoiceRoutes(api, project.adapter, { engine })).toBe(engine);
});
afterEach(() => cleanup());

const call = (
  method: string,
  path: string,
  body?: unknown,
  headers: Record<string, string> = HOST,
) =>
  api.request(`/voice${path}`, {
    method,
    headers: { "content-type": "application/json", ...headers },
    ...(body !== undefined && { body: typeof body === "string" ? body : JSON.stringify(body) }),
  });

const draft = {
  name: "Narrator",
  providerId: "gemini",
  model: "gemini-3.8-flash-tts",
  voice: { id: "Kore", name: "Kore", kind: "prebuilt" },
  style: "calm",
  settings: {},
};

async function withKey(): Promise<void> {
  expect((await call("PUT", "/providers/gemini/api-key", { key: SECRET })).status).toBe(200);
}

describe("voice routes: providers and keys", () => {
  it("lists the five providers without any key", async () => {
    await withKey();
    const response = await call("GET", "/providers");
    expect(response.status).toBe(200);
    const text = await response.text();
    expect(text).not.toContain(SECRET);
    const body = JSON.parse(text);
    expect(body.providers.map((provider: { id: string }) => provider.id)).toEqual([
      "gemini",
      "openai",
      "openrouter",
      "elevenlabs",
      "custom",
    ]);
    expect(body.providers[0]).toMatchObject({ id: "gemini", hasKey: true, configured: true });
    expect(body.providers[1]).toMatchObject({ id: "openai", hasKey: false, configured: false });
  });

  it("stores a key owner-only and answers the provider, never the key", async () => {
    const response = await call("PUT", "/providers/openai/api-key", { key: SECRET }, OWN);
    expect(response.status).toBe(200);
    const text = await response.text();
    expect(text).not.toContain(SECRET);
    expect(JSON.parse(text).provider).toMatchObject({ id: "openai", hasKey: true });
    expect(JSON.parse(readFileSync(join(dir, "api-keys.json"), "utf-8")).keys.openai).toBe(SECRET);
    const removed = await call("DELETE", "/providers/openai/api-key", undefined, OWN);
    expect(JSON.parse(await removed.text()).provider).toMatchObject({ hasKey: false });
  });

  it("refuses writes from a foreign origin and stores nothing", async () => {
    const put = await call("PUT", "/providers/openai/api-key", { key: SECRET }, FOREIGN);
    expect(put.status).toBe(403);
    expect((await put.json()).error.code).toBe("invalid_request");
    expect((await call("PUT", "/providers/openai", { model: "tts-1" }, FOREIGN)).status).toBe(403);
    expect((await call("DELETE", "/providers/openai/api-key", undefined, FOREIGN)).status).toBe(
      403,
    );
    expect((await call("POST", "/providers/gemini/check", undefined, FOREIGN)).status).toBe(403);
    expect((await call("POST", "/sample", { preset: draft, text: "Hi" }, FOREIGN)).status).toBe(
      403,
    );
    expect((await call("POST", "/presets", { preset: draft }, FOREIGN)).status).toBe(403);
    expect((await call("DELETE", "/presets/vp-x", undefined, FOREIGN)).status).toBe(403);
    expect(
      (await call("POST", "/providers/gemini/voices", { name: "n", description: "d" }, FOREIGN))
        .status,
    ).toBe(403);
    expect(existsSync(join(dir, "api-keys.json"))).toBe(false);
    expect(existsSync(join(dir, "providers.json"))).toBe(false);
    expect(net.calls).toHaveLength(0);
  });

  it("validates ids and bodies", async () => {
    expect((await call("PUT", "/providers/nope/api-key", { key: "k" })).status).toBe(404);
    expect((await call("PUT", "/providers/openai/api-key", { key: 5 })).status).toBe(400);
    expect((await call("PUT", "/providers/openai/api-key", { key: "has space" })).status).toBe(400);
    expect((await call("PUT", "/providers/openai/api-key", "{ nope")).status).toBe(400);
    // A query string or a fragment never passes the parser (and so never reaches the desktop-only refusal).
    expect(
      (await call("PUT", "/providers/custom", { baseUrl: "https://example.test/v1?token=1" }))
        .status,
    ).toBe(400);
    expect(
      (await call("PUT", "/providers/custom", { baseUrl: "https://example.test/v1#x" })).status,
    ).toBe(400);
    expect((await call("PUT", "/providers/openai", { voice: "x" })).status).toBe(400);
    expect(
      (await call("PUT", "/providers/openai/api-key", { key: "x".repeat(300_000) })).status,
    ).toBe(400);
  });

  it("updates the model, the custom voice and the agent rules", async () => {
    engine.providers.update("custom", { baseUrl: "http://127.0.0.1:8880/v1" });
    const response = await call("PUT", "/providers/custom", {
      model: "kokoro",
      voice: "af_heart",
      agentRules: "Short.",
    });
    expect(response.status).toBe(200);
    expect((await response.json()).provider).toMatchObject({
      id: "custom",
      configured: true,
      baseUrl: "http://127.0.0.1:8880/v1",
      model: "kokoro",
      voice: "af_heart",
      agentRules: "Short.",
    });
  });

  it("refuses the custom server address (desktop_only): composition code must not redirect the key", async () => {
    await call("PUT", "/providers/custom/api-key", { key: SECRET });
    const before = readFileSync(join(dir, "api-keys.json"), "utf-8");
    for (const baseUrl of ["https://attacker.example/v1", "", "http://127.0.0.1:9/v1"]) {
      const response = await call("PUT", "/providers/custom", { baseUrl, model: "m" });
      expect(response.status).toBe(403);
      expect((await response.json()).error).toMatchObject({
        code: "desktop_only",
        params: { key: "baseUrl" },
      });
    }
    // Nothing of the refused request was applied (not even its model), and no key went anywhere.
    expect(existsSync(join(dir, "providers.json"))).toBe(false);
    expect(readFileSync(join(dir, "api-keys.json"), "utf-8")).toBe(before);
    expect((await call("POST", "/providers/custom/check")).status).toBe(409);
    expect(net.calls).toHaveLength(0);
  });

  it("checks a key: ok with a sample, invalid_key as 401", async () => {
    await withKey();
    const ok = await call("POST", "/providers/gemini/check");
    expect(ok.status).toBe(200);
    const body = await ok.json();
    expect(body.ok).toBe(true);
    expect(body.sample.url).toMatch(/^\/api\/voice\/audio\/[0-9a-f]{64}$/);

    respond = () => jsonResponse({ error: { code: "authentication", message: "bad" } }, 401);
    const bad = await call("POST", "/providers/gemini/check");
    expect(bad.status).toBe(401);
    expect((await bad.json()).error.code).toBe("invalid_key");
    expect((await call("POST", "/providers/openai/check")).status).toBe(409);
  });

  it("answers a rate limit with 429 and Retry-After", async () => {
    await withKey();
    respond = () =>
      jsonResponse(
        {
          error: {
            code: 429,
            message: "slow",
            details: [{ "@type": "type.googleapis.com/google.rpc.RetryInfo", retryDelay: "30s" }],
          },
        },
        429,
      );
    const response = await call("POST", "/sample", { preset: draft, text: "Hi" });
    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("30");
    expect((await response.json()).error).toMatchObject({
      code: "rate_limited",
      params: { retryAfterSeconds: 30 },
    });
  });
});

describe("voice routes: controls, catalog and design", () => {
  it("answers the controls of a model", async () => {
    const response = await call(
      "GET",
      "/providers/gemini/controls?model=gemini-3.8-flash-lite-tts",
    );
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.model).toBe("gemini-3.8-flash-lite-tts");
    expect(body.controls.map((control: { kind: string }) => control.kind)).toEqual([
      "catalog",
      "voice_design",
      "style",
    ]);
    expect(body.dialect.id).toBe("gemini-tts");
    expect((await call("GET", "/providers/nope/controls")).status).toBe(404);
  });

  it("lists voices with the filters and the page token", async () => {
    await withKey();
    const response = await call(
      "GET",
      "/providers/gemini/voices?gender=female&language_code=en-US&pageToken=tok",
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      voices: [{ id: "Kore", kind: "prebuilt" }],
      nextPageToken: "next",
    });
    const url = new URL(net.calls[0]?.url ?? "");
    expect(url.searchParams.get("gender")).toBe("female");
    expect(url.searchParams.get("page_token")).toBe("tok");
    expect(url.searchParams.has("pageToken")).toBe(false);
  });

  it("answers unsupported for a provider without a catalog or design", async () => {
    // The address is written by the shell (here: straight into the store), never through Studio's route.
    engine.providers.update("custom", { baseUrl: "http://127.0.0.1:1/v1", model: "m" });
    const catalog = await call("GET", "/providers/custom/voices");
    expect(catalog.status).toBe(400);
    expect((await catalog.json()).error.code).toBe("unsupported");
    const design = await call("POST", "/providers/custom/voices", { name: "n", description: "d" });
    expect((await design.json()).error.code).toBe("unsupported");
    expect((await call("GET", "/providers/gemini/voices")).status).toBe(409);
  });

  it("designs a voice and serves the instant sample", async () => {
    await withKey();
    respond = () =>
      jsonResponse({
        id: "voice_abc",
        display_name: "Astronomer",
        type: "prompted",
        sample_audio: { mime_type: "audio/wav", data: Buffer.from(silentWav()).toString("base64") },
      });
    const response = await call("POST", "/providers/gemini/voices", {
      name: "Astronomer",
      description: "Warm and slow.",
    });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.voice).toMatchObject({ id: "voice_abc", kind: "designed" });
    expect((await call("GET", `/audio/${body.sample.hash}`)).status).toBe(200);
    expect(
      (await call("POST", "/providers/gemini/voices", { name: "", description: "x" })).status,
    ).toBe(400);
  });
});

describe("voice routes: presets, samples and audio", () => {
  it("makes a sample, then a second identical one from the cache, and serves the audio", async () => {
    await withKey();
    const first = await (
      await call("POST", "/sample", { preset: draft, text: "Hello there" })
    ).json();
    expect(first).toMatchObject({ cached: false, audio: { mimeType: "audio/wav" } });
    expect(first.audio.durationSeconds).toBeCloseTo(2, 4);
    const second = await (
      await call("POST", "/sample", { preset: draft, text: "Hello there" })
    ).json();
    expect(second).toMatchObject({ cached: true, usdCost: 0 });
    expect(net.calls).toHaveLength(1);

    const audio = await call("GET", `/audio/${first.audio.hash}`);
    expect(audio.status).toBe(200);
    expect(audio.headers.get("content-type")).toBe("audio/wav");
    expect(audio.headers.get("accept-ranges")).toBe("bytes");
    expect(Number(audio.headers.get("content-length"))).toBe(44 + 96_000);
    expect(new Uint8Array(await audio.arrayBuffer())).toEqual(silentWav(2));
  });

  it("answers a byte range with 206 and Content-Range (WebKit asks for bytes=0-1 first)", async () => {
    await withKey();
    const { audio } = await (
      await call("POST", "/sample", { preset: draft, text: "Range" })
    ).json();
    const size = 44 + 96_000;
    const probe = await call("GET", `/audio/${audio.hash}`, undefined, {
      ...HOST,
      range: "bytes=0-1",
    });
    expect(probe.status).toBe(206);
    expect(probe.headers.get("content-range")).toBe(`bytes 0-1/${size}`);
    expect(Number(probe.headers.get("content-length"))).toBe(2);
    expect(new TextDecoder().decode(new Uint8Array(await probe.arrayBuffer()))).toBe("RI");
    const tail = await call("GET", `/audio/${audio.hash}`, undefined, {
      ...HOST,
      range: "bytes=-100",
    });
    expect(tail.headers.get("content-range")).toBe(`bytes ${size - 100}-${size - 1}/${size}`);
    const open = await call("GET", `/audio/${audio.hash}`, undefined, {
      ...HOST,
      range: `bytes=${size - 10}-`,
    });
    expect(Number(open.headers.get("content-length"))).toBe(10);
    // An unsatisfiable or malformed range falls back to the whole file.
    const whole = await call("GET", `/audio/${audio.hash}`, undefined, {
      ...HOST,
      range: `bytes=${size + 5}-`,
    });
    expect(whole.status).toBe(200);
  });

  it("rejects a bad hash and answers not_found for an unknown one", async () => {
    for (const hash of [
      "abc",
      "../../etc/passwd",
      "Z".repeat(64),
      "A".repeat(64),
      "a".repeat(63),
    ]) {
      const response = await call("GET", `/audio/${encodeURIComponent(hash)}`);
      expect(response.status, hash).toBeGreaterThanOrEqual(400);
      expect(response.status, hash).toBeLessThan(500);
    }
    expect((await call("GET", "/audio/abc")).status).toBe(400);
    expect((await call("GET", `/audio/${"a".repeat(64)}`)).status).toBe(404);
  });

  it("creates, lists, updates and deletes presets; a sample must be a sound the server made", async () => {
    await withKey();
    const { audio } = await (
      await call("POST", "/sample", { preset: draft, text: "Hello" })
    ).json();
    const created = await call("POST", "/presets", {
      preset: draft,
      sampleHash: audio.hash,
      sampleText: "Hello",
    });
    expect(created.status).toBe(200);
    const { preset } = await created.json();
    expect(preset).toMatchObject({
      name: "Narrator",
      sample: { text: "Hello", audio: { hash: audio.hash } },
    });
    expect(preset.id).toMatch(/^vp-/);
    expect((await (await call("GET", "/presets")).json()).presets).toHaveLength(1);

    const forged = await call("POST", "/presets", {
      preset: draft,
      sampleHash: "f".repeat(64),
      sampleText: "x",
    });
    expect(forged.status).toBe(400);
    expect(
      (await call("POST", "/presets", { preset: draft, sampleHash: "../x", sampleText: "x" }))
        .status,
    ).toBe(400);
    expect(
      (await call("POST", "/presets", { preset: { ...draft, providerId: "nope" } })).status,
    ).toBe(400);

    const renamed = await call("PUT", `/presets/${preset.id}`, {
      preset: { ...draft, name: "Renamed" },
    });
    expect((await renamed.json()).preset).toMatchObject({
      name: "Renamed",
      sample: { audio: { hash: audio.hash } },
    });
    expect((await call("PUT", "/presets/vp-missing", { preset: draft })).status).toBe(404);
    expect(await (await call("DELETE", `/presets/${preset.id}`)).json()).toEqual({ ok: true });
    expect((await call("DELETE", `/presets/${preset.id}`)).status).toBe(404);
  });

  it("serves the dialects", async () => {
    const body = await (await call("GET", "/dialects")).json();
    expect(body.dialects.map((dialect: { id: string }) => dialect.id)).toContain("gemini-tts");
    expect(body.dialects.length).toBeGreaterThanOrEqual(5);
  });
});
