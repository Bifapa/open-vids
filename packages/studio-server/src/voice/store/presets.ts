import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  isRecord,
  isVoiceProviderId,
  VOICE_KINDS,
  type VoiceAudioRef,
  type VoicePreset,
  type VoicePresetDraft,
  type VoicePresetSample,
  type VoicePresetVoice,
} from "@hyperframes/agent-protocol";
import { replaceFileAtomically } from "../../helpers/atomicFile.js";
import { VoiceFailure } from "../errors.js";

const PRESETS_SCHEMA = "openvids.voice-presets/1";
export const VOICE_PRESETS_FILE = "presets.json";

/** A preset id: `vp-` and 12 hex digits. */
export function newPresetId(): string {
  return `vp-${randomBytes(6).toString("hex")}`;
}

function readSettings(value: unknown): Record<string, number | boolean> {
  const settings: Record<string, number | boolean> = {};
  if (!isRecord(value)) return settings;
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry === "boolean" || (typeof entry === "number" && Number.isFinite(entry)))
      settings[key] = entry;
  }
  return settings;
}

function readVoice(value: unknown): VoicePresetVoice | null {
  if (!isRecord(value) || typeof value.id !== "string" || typeof value.name !== "string")
    return null;
  const kind = VOICE_KINDS.find((candidate) => candidate === value.kind);
  if (!kind) return null;
  const voice: VoicePresetVoice = { id: value.id, name: value.name, kind };
  if (typeof value.language === "string") voice.language = value.language;
  if (typeof value.description === "string") voice.description = value.description;
  return voice;
}

function readSample(value: unknown): VoicePresetSample | null {
  if (!isRecord(value) || typeof value.text !== "string" || !isRecord(value.audio)) return null;
  const audio = value.audio;
  const mimeType =
    audio.mimeType === "audio/wav" || audio.mimeType === "audio/mpeg" ? audio.mimeType : null;
  if (
    typeof audio.url !== "string" ||
    typeof audio.hash !== "string" ||
    typeof audio.durationSeconds !== "number" ||
    !mimeType
  )
    return null;
  const ref: VoiceAudioRef = {
    url: audio.url,
    hash: audio.hash,
    durationSeconds: audio.durationSeconds,
    mimeType,
  };
  return {
    text: value.text,
    audio: ref,
    createdAt: typeof value.createdAt === "number" ? value.createdAt : 0,
  };
}

function readPreset(value: unknown): VoicePreset | null {
  if (!isRecord(value) || typeof value.id !== "string" || typeof value.name !== "string")
    return null;
  if (!isVoiceProviderId(value.providerId) || typeof value.model !== "string") return null;
  const voice = readVoice(value.voice);
  if (!voice) return null;
  return {
    id: value.id,
    name: value.name,
    providerId: value.providerId,
    model: value.model,
    voice,
    style: typeof value.style === "string" ? value.style : "",
    settings: readSettings(value.settings),
    sample: readSample(value.sample),
    createdAt: typeof value.createdAt === "number" ? value.createdAt : 0,
    updatedAt: typeof value.updatedAt === "number" ? value.updatedAt : 0,
  };
}

/** What a preset sounds like: when this changes, the saved sample no longer belongs to it. */
function soundKey(preset: Pick<VoicePreset, "providerId" | "model" | "voice" | "style">): string {
  return JSON.stringify([preset.providerId, preset.model, preset.voice.id, preset.style]);
}

/**
 * `presets.json`: the user's configured voices. Reads and writes are synchronous, so two requests never
 * interleave a read-modify-write. A preset whose entry is unreadable is dropped from the answer, the file is never
 * widened into anything else.
 */
export class VoicePresetStore {
  private readonly file: string;

  constructor(
    dir: string,
    private readonly now: () => number,
  ) {
    this.file = join(dir, VOICE_PRESETS_FILE);
  }

  list(): VoicePreset[] {
    if (!existsSync(this.file)) return [];
    try {
      const raw: unknown = JSON.parse(readFileSync(this.file, "utf-8"));
      if (!isRecord(raw) || raw.schema !== PRESETS_SCHEMA || !Array.isArray(raw.presets)) return [];
      const presets: VoicePreset[] = [];
      for (const entry of raw.presets) {
        const preset = readPreset(entry);
        if (preset) presets.push(preset);
      }
      return presets;
    } catch {
      return [];
    }
  }

  get(id: string): VoicePreset | null {
    return this.list().find((preset) => preset.id === id) ?? null;
  }

  private save(presets: VoicePreset[]): void {
    mkdirSync(join(this.file, ".."), { recursive: true, mode: 0o700 });
    replaceFileAtomically(
      this.file,
      `${JSON.stringify({ schema: PRESETS_SCHEMA, presets }, null, 2)}\n`,
      0o644,
    );
  }

  /**
   * Creates a preset. `sample`: the sound the user listened to, resolved by the engine from a cache entry it made.
   */
  create(draft: Omit<VoicePresetDraft, "sample">, sample: VoicePresetSample | null): VoicePreset {
    const at = this.now();
    const preset: VoicePreset = {
      ...draft,
      id: newPresetId(),
      sample,
      createdAt: at,
      updatedAt: at,
    };
    this.save([...this.list(), preset]);
    return preset;
  }

  /**
   * Replaces a preset's settings. `sample`: a new sample, `null` to drop it, `undefined` to keep the saved one while
   * the provider, model, voice and style are unchanged (a sample of another voice would lie).
   */
  update(
    id: string,
    draft: Omit<VoicePresetDraft, "sample">,
    sample: VoicePresetSample | null | undefined,
  ): VoicePreset {
    const presets = this.list();
    const index = presets.findIndex((preset) => preset.id === id);
    const current = presets[index];
    if (!current) throw new VoiceFailure("not_found", "The voice preset does not exist.");
    const kept =
      sample !== undefined
        ? sample
        : soundKey(current) === soundKey({ ...current, ...draft })
          ? current.sample
          : null;
    const next: VoicePreset = {
      ...draft,
      id: current.id,
      sample: kept,
      createdAt: current.createdAt,
      updatedAt: this.now(),
    };
    presets[index] = next;
    this.save(presets);
    return next;
  }

  remove(id: string): void {
    const presets = this.list();
    if (!presets.some((preset) => preset.id === id))
      throw new VoiceFailure("not_found", "The voice preset does not exist.");
    this.save(presets.filter((preset) => preset.id !== id));
  }

  /** Cache entries presets still play: the cache must never drop them. */
  referencedHashes(): Set<string> {
    const hashes = new Set<string>();
    for (const preset of this.list()) if (preset.sample) hashes.add(preset.sample.audio.hash);
    return hashes;
  }
}
