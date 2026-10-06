// @vitest-environment node
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { isVoiceFailure } from "../errors.js";
import { SECRET, tempDir } from "../testSupport.js";
import { VoiceKeyStore } from "./keys.js";
import { VoicePresetStore } from "./presets.js";
import { VoiceProviderStore } from "./providers.js";

let dir: string;
let cleanup: () => void;
beforeEach(() => {
  const temp = tempDir("openvids-voice-stores-");
  dir = join(temp.dir, "voice");
  cleanup = temp.cleanup;
});
afterEach(() => cleanup());

const mode = (path: string): number => statSync(path).mode & 0o777;
const posix = process.platform !== "win32";

describe("VoiceKeyStore", () => {
  it("writes api-keys.json owner-only in an owner-only directory and leaves no temp files", () => {
    const keys = new VoiceKeyStore(dir);
    keys.set("gemini", SECRET);
    const file = join(dir, "api-keys.json");
    expect(JSON.parse(readFileSync(file, "utf-8"))).toEqual({
      schema: "openvids.voice-keys/1",
      keys: { gemini: SECRET },
    });
    if (posix) {
      expect(mode(file)).toBe(0o600);
      expect(mode(dir)).toBe(0o700);
    }
    expect(readdirSync(dir)).toEqual(["api-keys.json"]);
    expect(keys.get("gemini")).toBe(SECRET);
    expect(keys.has("gemini")).toBe(true);
    keys.remove("gemini");
    expect(keys.get("gemini")).toBeNull();
  });

  it("reads an unreadable or foreign file as no keys", () => {
    const keys = new VoiceKeyStore(dir);
    keys.set("openai", "k");
    writeFileSync(join(dir, "api-keys.json"), "{ not json");
    expect(keys.get("openai")).toBeNull();
    writeFileSync(
      join(dir, "api-keys.json"),
      JSON.stringify({ schema: "other/1", keys: { openai: "k" } }),
    );
    expect(keys.has("openai")).toBe(false);
  });
});

describe("VoiceProviderStore", () => {
  const make = () => {
    const keys = new VoiceKeyStore(dir);
    return { keys, providers: new VoiceProviderStore(dir, keys) };
  };

  it("answers the defaults without a file and never creates one", () => {
    const { providers } = make();
    expect(providers.info("gemini")).toEqual({
      id: "gemini",
      connector: "gemini",
      name: "Google Gemini",
      baseUrl: "https://generativelanguage.googleapis.com/v1beta",
      model: "gemini-3.8-flash-tts",
      hasKey: false,
      keyRequired: true,
      configured: false,
      voice: "",
      agentRules: "",
      notes: ["free_tier_terms"],
    });
    expect(providers.info("openai").model).toBe("gpt-4o-mini-tts");
    expect(providers.info("elevenlabs").baseUrl).toBe("https://api.elevenlabs.io");
    expect(providers.info("custom")).toMatchObject({
      baseUrl: "",
      model: "",
      configured: false,
      keyRequired: false,
    });
    expect(existsSync(dir)).toBe(false);
  });

  it("is configured with a key; custom needs an address and a model, never a key", () => {
    const { keys, providers } = make();
    keys.set("openai", SECRET);
    expect(providers.info("openai")).toMatchObject({ hasKey: true, configured: true });
    expect(JSON.stringify(providers.info("openai"))).not.toContain(SECRET);
    providers.update("custom", {
      baseUrl: "http://127.0.0.1:8880/v1/",
      model: "kokoro",
      voice: "af_heart",
    });
    expect(providers.info("custom")).toMatchObject({
      baseUrl: "http://127.0.0.1:8880/v1",
      model: "kokoro",
      voice: "af_heart",
      hasKey: false,
      configured: true,
    });
  });

  it("notes the Gemini-through-OpenRouter catalog limit", () => {
    const { providers } = make();
    expect(providers.info("openrouter").notes).toEqual(["catalog_needs_google_key"]);
    providers.update("openrouter", { model: "mistralai/voxtral-mini-tts-2603" });
    expect(providers.info("openrouter").notes).toEqual([]);
  });

  it("removes an override with an empty string and keeps every key it does not know", () => {
    const { providers } = make();
    providers.update("elevenlabs", { model: "eleven_v3", agentRules: "Always warm." });
    const file = join(dir, "providers.json");
    const document = JSON.parse(readFileSync(file, "utf-8"));
    document.future = { x: 1 };
    document.providers.elevenlabs.later = "kept";
    writeFileSync(file, JSON.stringify(document));
    providers.update("elevenlabs", { model: "" });
    expect(providers.info("elevenlabs")).toMatchObject({
      model: "eleven_v4",
      agentRules: "Always warm.",
    });
    expect(JSON.parse(readFileSync(file, "utf-8"))).toEqual({
      schema: "openvids.voice-providers/1",
      future: { x: 1 },
      providers: { elevenlabs: { agentRules: "Always warm.", later: "kept" } },
    });
    if (posix) expect(mode(file)).toBe(0o644);
  });

  it("refuses a base URL or voice on a built-in provider", () => {
    const { providers } = make();
    for (const request of [{ baseUrl: "https://evil.example" }, { voice: "x" }]) {
      try {
        providers.update("openai", request);
        throw new Error("should have failed");
      } catch (error) {
        expect(isVoiceFailure(error) && error.code).toBe("invalid_request");
      }
    }
    expect(providers.info("openai").baseUrl).toBe("https://api.openai.com/v1");
  });

  it("reads an unreadable file as defaults", () => {
    const { providers } = make();
    providers.update("openai", { model: "tts-1" });
    writeFileSync(join(dir, "providers.json"), "garbage");
    expect(providers.info("openai").model).toBe("gpt-4o-mini-tts");
  });
});

describe("VoicePresetStore", () => {
  const draft = {
    name: "Narrator",
    providerId: "gemini" as const,
    model: "gemini-3.8-flash-tts",
    voice: { id: "Kore", name: "Kore", kind: "prebuilt" as const },
    style: "calm",
    settings: {},
  };
  const sample = {
    text: "Hello",
    audio: {
      url: `/api/voice/audio/${"a".repeat(64)}`,
      hash: "a".repeat(64),
      durationSeconds: 1,
      mimeType: "audio/wav" as const,
    },
    createdAt: 5,
  };

  it("creates, lists, updates and deletes presets with vp- ids", () => {
    let now = 100;
    const store = new VoicePresetStore(dir, () => now);
    const created = store.create(draft, sample);
    expect(created.id).toMatch(/^vp-[0-9a-f]{12}$/);
    expect(created).toMatchObject({ createdAt: 100, updatedAt: 100, sample });
    expect(store.list()).toEqual([created]);
    expect(JSON.parse(readFileSync(join(dir, "presets.json"), "utf-8")).schema).toBe(
      "openvids.voice-presets/1",
    );
    if (posix) expect(mode(join(dir, "presets.json"))).toBe(0o644);

    now = 200;
    const renamed = store.update(created.id, { ...draft, name: "Narrator 2" }, undefined);
    expect(renamed).toMatchObject({ name: "Narrator 2", createdAt: 100, updatedAt: 200, sample });
    store.remove(created.id);
    expect(store.list()).toEqual([]);
  });

  it("keeps the sample while the sound is unchanged and drops it when the voice or style changes", () => {
    const store = new VoicePresetStore(dir, () => 1);
    const created = store.create(draft, sample);
    expect(store.update(created.id, { ...draft, settings: { x: 1 } }, undefined).sample).toEqual(
      sample,
    );
    expect(store.update(created.id, { ...draft, style: "angry" }, undefined).sample).toBeNull();
    store.update(created.id, draft, sample);
    expect(
      store.update(
        created.id,
        { ...draft, voice: { id: "Puck", name: "Puck", kind: "prebuilt" } },
        undefined,
      ).sample,
    ).toBeNull();
    store.update(created.id, draft, sample);
    expect(store.update(created.id, draft, null).sample).toBeNull();
  });

  it("reports the cache hashes presets still play", () => {
    const store = new VoicePresetStore(dir, () => 1);
    store.create(draft, sample);
    store.create({ ...draft, name: "No sample" }, null);
    expect([...store.referencedHashes()]).toEqual(["a".repeat(64)]);
  });

  it("refuses an unknown preset with not_found and survives a damaged file", () => {
    const store = new VoicePresetStore(dir, () => 1);
    for (const run of [() => store.update("vp-nope", draft, null), () => store.remove("vp-nope")]) {
      try {
        run();
        throw new Error("should have failed");
      } catch (error) {
        expect(isVoiceFailure(error) && error.code).toBe("not_found");
      }
    }
    store.create(draft, null);
    writeFileSync(join(dir, "presets.json"), "garbage");
    expect(store.list()).toEqual([]);
  });
});
