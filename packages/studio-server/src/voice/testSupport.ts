import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isRecord, type VoiceProviderInfo } from "@hyperframes/agent-protocol";
import type { FfprobeRunner } from "../helpers/mediaMetadata.js";
import { wrapPcmAsWav } from "./audio.js";
import type { ConnectorContext } from "./types.js";

export interface RecordedCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

export interface MockFetch {
  fetch: typeof fetch;
  calls: RecordedCall[];
}

/** A fetch that records every call and answers with `respond`. */
export function mockFetch(
  respond: (call: RecordedCall, index: number) => Response | Promise<Response>,
): MockFetch {
  const calls: RecordedCall[] = [];
  const impl = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const headers: Record<string, string> = {};
    if (isRecord(init?.headers))
      for (const [name, value] of Object.entries(init.headers))
        headers[name.toLowerCase()] = String(value);
    let body: unknown = null;
    if (typeof init?.body === "string") {
      try {
        body = JSON.parse(init.body);
      } catch {
        body = init.body;
      }
    }
    const call: RecordedCall = {
      url: String(input),
      method: init?.method ?? "GET",
      headers,
      body,
    };
    calls.push(call);
    return respond(call, calls.length - 1);
  };
  return { fetch: Object.assign(impl, { preconnect: () => undefined }), calls };
}

/** One second of silence as a 24 kHz mono WAV. */
export function silentWav(seconds = 1): Uint8Array {
  return wrapPcmAsWav(new Uint8Array(24_000 * 2 * seconds), 24_000);
}

export function jsonResponse(
  body: unknown,
  status = 200,
  headers: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

export function audioResponse(bytes: Uint8Array, contentType = "audio/wav"): Response {
  return new Response(new Uint8Array(bytes), {
    status: 200,
    headers: { "content-type": contentType },
  });
}

/** ffprobe is not there: durations come from the audio headers. */
export const noFfprobe: FfprobeRunner = () => ({
  status: null,
  stdout: "",
  stderr: "",
  error: { code: "ENOENT" },
});

export function tempDir(prefix = "openvids-voice-"): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

export const SECRET = "sk-test-SECRET-key-0123456789";

export function provider(
  overrides: Partial<VoiceProviderInfo> & Pick<VoiceProviderInfo, "id">,
): VoiceProviderInfo {
  const defaults: Record<
    string,
    Pick<VoiceProviderInfo, "connector" | "name" | "baseUrl" | "model">
  > = {
    gemini: {
      connector: "gemini",
      name: "Google Gemini",
      baseUrl: "https://generativelanguage.googleapis.com/v1beta",
      model: "gemini-3.8-flash-tts",
    },
    openai: {
      connector: "openai_compatible",
      name: "OpenAI",
      baseUrl: "https://api.openai.com/v1",
      model: "gpt-4o-mini-tts",
    },
    openrouter: {
      connector: "openai_compatible",
      name: "OpenRouter",
      baseUrl: "https://openrouter.ai/api/v1",
      model: "google/gemini-3.8-flash-tts",
    },
    elevenlabs: {
      connector: "elevenlabs",
      name: "ElevenLabs",
      baseUrl: "https://api.elevenlabs.io",
      model: "eleven_v4",
    },
    custom: {
      connector: "openai_compatible",
      name: "Custom server",
      baseUrl: "http://127.0.0.1:8880/v1",
      model: "kokoro",
    },
  };
  const base = defaults[overrides.id];
  if (!base) throw new Error(`no defaults for ${overrides.id}`);
  return {
    ...base,
    hasKey: true,
    keyRequired: overrides.id !== "custom",
    configured: true,
    voice: "",
    agentRules: "",
    notes: [],
    ...overrides,
  };
}

/** A connector context for a provider with the test secret as its key. */
export function context(
  info: VoiceProviderInfo,
  fetchImpl: typeof fetch,
  options: { apiKey?: string | null; signal?: AbortSignal } = {},
): ConnectorContext {
  return {
    provider: info,
    apiKey: options.apiKey === undefined ? SECRET : options.apiKey,
    signal: options.signal ?? new AbortController().signal,
    fetch: fetchImpl,
  };
}
