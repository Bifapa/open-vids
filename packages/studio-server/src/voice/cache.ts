import { existsSync, mkdirSync, readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { isRecord, type VoiceAudioRef, type VoiceProviderId } from "@hyperframes/agent-protocol";
import { replaceFileAtomically } from "../helpers/atomicFile.js";
import { measureDuration, type NormalizedAudio } from "./audio.js";
import type { FfprobeRunner } from "../helpers/mediaMetadata.js";

const CACHE_SCHEMA = "openvids.voice-cache/1";
const HASH = /^[0-9a-f]{64}$/;

export function isCacheHash(value: string): boolean {
  return HASH.test(value);
}

export interface CacheEntry {
  /** Absolute path of the audio file. */
  path: string;
  hash: string;
  mimeType: "audio/wav" | "audio/mpeg";
  durationSeconds: number;
  createdAt: number;
  providerId: string;
  model: string;
  /** What the request that made the entry cost (not what a hit costs). */
  usdCost: number | null;
}

/** What the engine knows of a request when it stores its audio. */
export interface CacheStoreInfo {
  providerId: VoiceProviderId;
  model: string;
  now: number;
  /** The cost of the synthesis, known once the duration is. */
  cost: (durationSeconds: number) => number | null;
}

/**
 * `<voice dir>/cache/<hash>.wav|.mp3` + `<hash>.json`. The audio is written first (temp file and rename), the meta
 * last, and an entry exists only when both do: a crash between the two leaves an orphan audio file that the next
 * request for the hash simply replaces, never an entry that points at nothing.
 */
export class VoiceCache {
  readonly dir: string;

  constructor(
    voiceDirectory: string,
    private readonly probe?: FfprobeRunner,
  ) {
    this.dir = join(voiceDirectory, "cache");
  }

  private audioPath(hash: string, mimeType: CacheEntry["mimeType"]): string {
    return join(this.dir, `${hash}.${mimeType === "audio/wav" ? "wav" : "mp3"}`);
  }

  /** The entry for a hash, or null when absent, half-written or unreadable. */
  entry(hash: string): CacheEntry | null {
    if (!isCacheHash(hash)) return null;
    const metaPath = join(this.dir, `${hash}.json`);
    if (!existsSync(metaPath)) return null;
    try {
      const meta: unknown = JSON.parse(readFileSync(metaPath, "utf-8"));
      if (!isRecord(meta) || meta.schema !== CACHE_SCHEMA || meta.hash !== hash) return null;
      const mimeType =
        meta.mimeType === "audio/wav" || meta.mimeType === "audio/mpeg" ? meta.mimeType : null;
      if (!mimeType || typeof meta.durationSeconds !== "number") return null;
      const path = this.audioPath(hash, mimeType);
      if (!existsSync(path)) return null;
      return {
        path,
        hash,
        mimeType,
        durationSeconds: meta.durationSeconds,
        createdAt: typeof meta.createdAt === "number" ? meta.createdAt : 0,
        providerId: typeof meta.providerId === "string" ? meta.providerId : "",
        model: typeof meta.model === "string" ? meta.model : "",
        usdCost: typeof meta.usdCost === "number" ? meta.usdCost : null,
      };
    } catch {
      return null;
    }
  }

  async store(hash: string, audio: NormalizedAudio, info: CacheStoreInfo): Promise<CacheEntry> {
    mkdirSync(this.dir, { recursive: true });
    const path = this.audioPath(hash, audio.mimeType);
    replaceFileAtomically(path, audio.bytes, 0o644);
    let durationSeconds: number;
    try {
      durationSeconds = await measureDuration(path, audio.bytes, audio.kind, this.probe);
    } catch (error) {
      unlinkSync(path);
      throw error;
    }
    const entry: CacheEntry = {
      path,
      hash,
      mimeType: audio.mimeType,
      durationSeconds,
      createdAt: info.now,
      providerId: info.providerId,
      model: info.model,
      usdCost: info.cost(durationSeconds),
    };
    const meta = {
      schema: CACHE_SCHEMA,
      hash,
      mimeType: entry.mimeType,
      durationSeconds,
      createdAt: entry.createdAt,
      providerId: entry.providerId,
      model: entry.model,
      usdCost: entry.usdCost,
    };
    replaceFileAtomically(
      join(this.dir, `${hash}.json`),
      `${JSON.stringify(meta, null, 2)}\n`,
      0o644,
    );
    return entry;
  }

  /** The reference the UI plays (`/api/voice/audio/<hash>`). */
  ref(entry: CacheEntry): VoiceAudioRef {
    return {
      url: `/api/voice/audio/${entry.hash}`,
      hash: entry.hash,
      durationSeconds: entry.durationSeconds,
      mimeType: entry.mimeType,
    };
  }
}
