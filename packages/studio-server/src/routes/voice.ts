import { readFileSync } from "node:fs";
import type { Context, Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import {
  isRecord,
  isVoiceProviderId,
  parseDesignVoiceRequest,
  parseUpdateVoiceProviderRequest,
  parseVoicePresetDraft,
  parseVoiceSampleRequest,
  VOICE_DIALECTS,
  VOICE_LIMITS,
  type VoiceProviderId,
} from "@hyperframes/agent-protocol";
import { originMatchesHost } from "../agent/gateway.js";
import type { StudioApiAdapter } from "../types.js";
import { isCacheHash } from "../voice/cache.js";
import { createVoiceEngine, type VoiceEngineImpl } from "../voice/engine.js";
import { isVoiceFailure, voiceErrorBody, VoiceFailure } from "../voice/errors.js";

const MAX_BODY_BYTES = 256 * 1024;

/** One `Range: bytes=a-b` header against a file of `size` bytes; null when absent, malformed or unsatisfiable. */
function parseRange(
  header: string | undefined,
  size: number,
): { start: number; end: number } | null {
  const match = header ? /^bytes=(\d*)-(\d*)$/.exec(header.trim()) : null;
  if (!match || (match[1] === "" && match[2] === "")) return null;
  let start: number;
  let end: number;
  if (match[1] === "") {
    // A suffix range: the last N bytes.
    start = Math.max(0, size - Number(match[2]));
    end = size - 1;
  } else {
    start = Number(match[1]);
    end = match[2] === "" ? size - 1 : Math.min(Number(match[2]), size - 1);
  }
  return start <= end && start < size ? { start, end } : null;
}

/**
 * The global voice routes (`/voice/…`): providers and their keys, the controls and catalog of the voice-setup
 * window, voice design, presets, samples, the audio cache and the dialects. Every write is origin-checked like
 * `PUT /app/preferences`: a page on another origin must neither change a key nor spend the user's credits.
 * Returns the engine the project routes (`/projects/:id/voice/…`) are built on.
 */
export function registerVoiceRoutes(
  api: Hono,
  _adapter: StudioApiAdapter,
  options: { engine?: VoiceEngineImpl } = {},
): VoiceEngineImpl {
  const engine = options.engine ?? createVoiceEngine();

  const failure = (code: "invalid_request" | "not_found", message: string) =>
    new VoiceFailure(code, message);

  const tooLarge = bodyLimit({
    maxSize: MAX_BODY_BYTES,
    onError: (c) =>
      c.json(voiceErrorBody(failure("invalid_request", "Request body is too large")), 400),
  });

  /** Runs an action; a voice failure becomes `{error}` with its status (and `Retry-After` when known). */
  const answer = async (
    c: Context,
    action: () => Promise<Response | object> | Response | object,
  ) => {
    try {
      const result = await action();
      return result instanceof Response ? result : c.json(result);
    } catch (error) {
      if (!isVoiceFailure(error)) throw error;
      const retryAfter = error.params?.retryAfterSeconds;
      if (error.code === "rate_limited" && typeof retryAfter === "number")
        c.header("Retry-After", String(retryAfter));
      return c.json(voiceErrorBody(error), toStatus(error.status));
    }
  };

  /** Writes and anything that spends credits: refused when the request comes from another origin. */
  const sameOrigin = (c: Context): void => {
    if (!originMatchesHost(c.req.raw))
      throw new VoiceFailure(
        "invalid_request",
        "The request Origin does not match its Host.",
        undefined,
        403,
      );
  };

  const providerId = (c: Context): VoiceProviderId => {
    const id = c.req.param("id");
    if (!isVoiceProviderId(id)) throw failure("not_found", "Unknown voice provider.");
    return id;
  };

  const body = async (c: Context): Promise<unknown> => c.req.json().catch(() => undefined);

  const parsed = <T>(result: { ok: true; value: T } | { ok: false; message: string }): T => {
    if (!result.ok) throw failure("invalid_request", result.message);
    return result.value;
  };

  // ── Providers ──────────────────────────────────────────────────────────────

  api.get("/voice/providers", (c) => answer(c, () => ({ providers: engine.listProviders() })));

  api.put("/voice/providers/:id", tooLarge, (c) =>
    answer(c, async () => {
      sameOrigin(c);
      const id = providerId(c);
      const update = parsed(parseUpdateVoiceProviderRequest(await body(c)));
      return { provider: engine.updateProvider(id, update) };
    }),
  );

  api.put("/voice/providers/:id/api-key", tooLarge, (c) =>
    answer(c, async () => {
      sameOrigin(c);
      const id = providerId(c);
      const payload = await body(c);
      if (!isRecord(payload) || typeof payload.key !== "string")
        throw failure("invalid_request", "key must be a string");
      return { provider: engine.setKey(id, payload.key) };
    }),
  );

  api.delete("/voice/providers/:id/api-key", (c) =>
    answer(c, () => {
      sameOrigin(c);
      return { provider: engine.removeKey(providerId(c)) };
    }),
  );

  api.post("/voice/providers/:id/check", (c) =>
    answer(c, () => {
      sameOrigin(c);
      return engine.checkKey(providerId(c), c.req.raw.signal);
    }),
  );

  api.get("/voice/providers/:id/controls", (c) =>
    answer(c, () => engine.controls(providerId(c), c.req.query("model"), c.req.raw.signal)),
  );

  api.get("/voice/providers/:id/voices", (c) =>
    answer(c, () => {
      const filters: Record<string, string> = {};
      for (const [key, value] of Object.entries(c.req.query())) {
        if (key !== "pageToken" && value.length > 0) filters[key] = value;
      }
      return engine.voices(
        providerId(c),
        filters,
        c.req.query("pageToken") || null,
        c.req.raw.signal,
      );
    }),
  );

  api.post("/voice/providers/:id/voices", tooLarge, (c) =>
    answer(c, async () => {
      sameOrigin(c);
      const id = providerId(c);
      const request = parsed(parseDesignVoiceRequest(await body(c)));
      return engine.designVoice(id, request, c.req.raw.signal);
    }),
  );

  // ── Presets ────────────────────────────────────────────────────────────────

  /** `{ preset, sampleHash?, sampleText? }`: the draft plus the sample the user listened to, named by its cache hash. */
  const presetBody = async (c: Context) => {
    const payload = await body(c);
    if (!isRecord(payload)) throw failure("invalid_request", "body must be an object");
    const draft = parsed(parseVoicePresetDraft(payload.preset));
    const { sampleHash, sampleText } = payload;
    if (sampleHash !== undefined && sampleHash !== null && typeof sampleHash !== "string")
      throw failure("invalid_request", "sampleHash must be a string");
    if (
      sampleText !== undefined &&
      (typeof sampleText !== "string" || sampleText.length > VOICE_LIMITS.sampleTextChars)
    )
      throw failure("invalid_request", "sampleText must be a short string");
    return { draft, sample: { sampleHash, sampleText } };
  };

  api.get("/voice/presets", (c) => answer(c, () => ({ presets: engine.listPresets() })));

  api.post("/voice/presets", tooLarge, (c) =>
    answer(c, async () => {
      sameOrigin(c);
      const { draft, sample } = await presetBody(c);
      return { preset: engine.createPreset(draft, sample) };
    }),
  );

  api.put("/voice/presets/:id", tooLarge, (c) =>
    answer(c, async () => {
      sameOrigin(c);
      const { draft, sample } = await presetBody(c);
      return { preset: engine.updatePreset(c.req.param("id"), draft, sample) };
    }),
  );

  api.delete("/voice/presets/:id", (c) =>
    answer(c, () => {
      sameOrigin(c);
      engine.deletePreset(c.req.param("id"));
      return { ok: true };
    }),
  );

  // ── Samples, audio, dialects ───────────────────────────────────────────────

  api.post("/voice/sample", tooLarge, (c) =>
    answer(c, async () => {
      sameOrigin(c);
      const request = parsed(parseVoiceSampleRequest(await body(c)));
      return engine.sample(request, c.req.raw.signal);
    }),
  );

  api.get("/voice/audio/:hash", (c) =>
    answer(c, () => {
      const hash = c.req.param("hash");
      if (!isCacheHash(hash)) throw failure("invalid_request", "hash must be 64 hex characters");
      const path = engine.audioPath(hash);
      const ref = engine.audioRef(hash);
      if (!path || !ref) throw failure("not_found", "No such audio.");
      const bytes = new Uint8Array(readFileSync(path));
      // Content-addressed: the bytes behind a hash never change. Ranges: WebKit's media stack asks for them.
      const headers: Record<string, string> = {
        "content-type": ref.mimeType,
        "accept-ranges": "bytes",
        "cache-control": "private, max-age=31536000, immutable",
      };
      const range = parseRange(c.req.header("range"), bytes.length);
      if (!range) return c.body(bytes, 200, { ...headers, "content-length": String(bytes.length) });
      return c.body(bytes.subarray(range.start, range.end + 1), 206, {
        ...headers,
        "content-length": String(range.end - range.start + 1),
        "content-range": `bytes ${range.start}-${range.end}/${bytes.length}`,
      });
    }),
  );

  api.get("/voice/dialects", (c) => answer(c, () => ({ dialects: Object.values(VOICE_DIALECTS) })));

  return engine;
}

/** The statuses a voice failure can carry (Hono types the status of a JSON answer). */
function toStatus(status: number): 400 | 401 | 402 | 403 | 404 | 409 | 422 | 429 | 502 | 504 {
  switch (status) {
    case 401:
    case 402:
    case 403:
    case 404:
    case 409:
    case 422:
    case 429:
    case 502:
    case 504:
      return status;
    default:
      return 400;
  }
}
