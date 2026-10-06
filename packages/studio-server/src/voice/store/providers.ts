import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  isRecord,
  type UpdateVoiceProviderRequest,
  type VoiceConnector,
  type VoiceProviderId,
  type VoiceProviderInfo,
  type VoiceProviderNote,
} from "@hyperframes/agent-protocol";
import { replaceFileAtomically } from "../../helpers/atomicFile.js";
import { VoiceFailure } from "../errors.js";
import type { VoiceKeyStore } from "./keys.js";

const PROVIDERS_SCHEMA = "openvids.voice-providers/1";
export const VOICE_PROVIDERS_FILE = "providers.json";

interface ProviderDefinition {
  connector: VoiceConnector;
  name: string;
  baseUrl: string;
  model: string;
  keyRequired: boolean;
}

/**
 * The fixed providers. The Projects page (Rust, `voice_settings.rs`) answers the same table: keep the two in sync
 * (names, defaults, and the rules in {@link VoiceProviderStore.info}).
 */
export const PROVIDER_DEFINITIONS: Readonly<Record<VoiceProviderId, ProviderDefinition>> = {
  gemini: {
    connector: "gemini",
    name: "Google Gemini",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta",
    model: "gemini-3.8-flash-tts",
    keyRequired: true,
  },
  openai: {
    connector: "openai_compatible",
    name: "OpenAI",
    baseUrl: "https://api.openai.com/v1",
    model: "gpt-4o-mini-tts",
    keyRequired: true,
  },
  openrouter: {
    connector: "openai_compatible",
    name: "OpenRouter",
    baseUrl: "https://openrouter.ai/api/v1",
    model: "google/gemini-3.8-flash-tts",
    keyRequired: true,
  },
  elevenlabs: {
    connector: "elevenlabs",
    name: "ElevenLabs",
    baseUrl: "https://api.elevenlabs.io",
    model: "eleven_v4",
    keyRequired: true,
  },
  custom: {
    connector: "openai_compatible",
    name: "Custom server",
    baseUrl: "",
    model: "",
    keyRequired: false,
  },
};

interface ProviderEntry {
  model?: string;
  baseUrl?: string;
  voice?: string;
  agentRules?: string;
}

/** The text field of an entry, or undefined when absent or not a string. */
function text(entry: Record<string, unknown>, field: keyof ProviderEntry): string | undefined {
  const value = entry[field];
  return typeof value === "string" ? value : undefined;
}

/**
 * `providers.json`: the user's overrides of the provider table. A missing entry means the defaults, an unreadable
 * file reads as defaults; writes keep every key this version does not know (the Projects page and later versions
 * write the same file).
 */
export class VoiceProviderStore {
  private readonly file: string;

  constructor(
    dir: string,
    private readonly keys: VoiceKeyStore,
  ) {
    this.file = join(dir, VOICE_PROVIDERS_FILE);
  }

  private loadDocument(): Record<string, unknown> {
    if (!existsSync(this.file)) return {};
    try {
      const raw: unknown = JSON.parse(readFileSync(this.file, "utf-8"));
      return isRecord(raw) ? raw : {};
    } catch {
      return {};
    }
  }

  private entries(document: Record<string, unknown>): Record<string, Record<string, unknown>> {
    const entries: Record<string, Record<string, unknown>> = {};
    if (!isRecord(document.providers)) return entries;
    for (const [id, entry] of Object.entries(document.providers)) {
      if (isRecord(entry)) entries[id] = entry;
    }
    return entries;
  }

  private entry(id: VoiceProviderId): ProviderEntry {
    const raw = this.entries(this.loadDocument())[id] ?? {};
    const entry: ProviderEntry = {};
    for (const field of ["model", "baseUrl", "voice", "agentRules"] as const) {
      const value = text(raw, field);
      if (value !== undefined) entry[field] = value;
    }
    return entry;
  }

  /** The provider as Studio and the agents see it. */
  info(id: VoiceProviderId): VoiceProviderInfo {
    const definition = PROVIDER_DEFINITIONS[id];
    const entry = this.entry(id);
    const custom = id === "custom";
    const model = entry.model && entry.model.length > 0 ? entry.model : definition.model;
    const baseUrl = custom ? stripTrailingSlashes(entry.baseUrl ?? "") : definition.baseUrl;
    const hasKey = this.keys.has(id);
    const notes: VoiceProviderNote[] = [];
    if (id === "gemini") notes.push("free_tier_terms");
    if (id === "openrouter" && model.toLowerCase().startsWith("google/gemini"))
      notes.push("catalog_needs_google_key");
    return {
      id,
      connector: definition.connector,
      name: definition.name,
      baseUrl,
      model,
      hasKey,
      keyRequired: definition.keyRequired,
      configured: custom ? baseUrl.length > 0 && model.length > 0 : hasKey,
      voice: custom ? (entry.voice ?? "") : "",
      agentRules: entry.agentRules ?? "",
      notes,
    };
  }

  /**
   * Applies an update: an empty string removes the override (the model goes back to the default, the custom fields
   * and the rules to empty). `baseUrl` and `voice` belong to the custom server only.
   */
  update(id: VoiceProviderId, request: UpdateVoiceProviderRequest): VoiceProviderInfo {
    if (id !== "custom" && (request.baseUrl !== undefined || request.voice !== undefined))
      throw new VoiceFailure(
        "invalid_request",
        "Only the custom server has a base URL and a voice of its own.",
      );
    const document = this.loadDocument();
    const entries = this.entries(document);
    const entry: Record<string, unknown> = { ...entries[id] };
    for (const field of ["model", "baseUrl", "voice", "agentRules"] as const) {
      const value = request[field];
      if (value === undefined) continue;
      if (value.length === 0) delete entry[field];
      else entry[field] = field === "baseUrl" ? stripTrailingSlashes(value) : value;
    }
    entries[id] = entry;
    mkdirSync(join(this.file, ".."), { recursive: true, mode: 0o700 });
    replaceFileAtomically(
      this.file,
      `${JSON.stringify({ ...document, schema: PROVIDERS_SCHEMA, providers: entries }, null, 2)}\n`,
      0o644,
    );
    return this.info(id);
  }
}

export function stripTrailingSlashes(url: string): string {
  let end = url.length;
  while (end > 0 && url[end - 1] === "/") end -= 1;
  return url.slice(0, end);
}
