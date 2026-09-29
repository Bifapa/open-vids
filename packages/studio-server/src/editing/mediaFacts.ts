import { stat } from "node:fs/promises";
import type { AssetKind, ProjectAsset } from "@hyperframes/agent-protocol";
import { AUDIO_EXT, FONT_EXT, IMAGE_EXT, VIDEO_EXT } from "@hyperframes/core/media-types";
import { probeMediaMetadata } from "../helpers/mediaMetadata.js";
import { resolveWithinProject } from "../helpers/safePath.js";

export type MediaProber = typeof probeMediaMetadata;

export function assetKindOf(path: string): AssetKind {
  if (IMAGE_EXT.test(path)) return "image";
  if (VIDEO_EXT.test(path)) return "video";
  if (AUDIO_EXT.test(path)) return "audio";
  if (FONT_EXT.test(path)) return "font";
  return "other";
}

const MAX_CACHED = 1_000;
const PROBE_CONCURRENCY = 4;

interface Cached {
  mtimeMs: number;
  size: number;
  asset: ProjectAsset;
}

/**
 * Media facts (duration, pixel size, audio stream) through the same ffprobe reader `GET /media/metadata`
 * uses, cached per file by path + mtime + size so a timeline read never re-probes an unchanged file.
 */
export class MediaFacts {
  private readonly cache = new Map<string, Cached>();
  private readonly inFlight = new Map<string, Promise<ProjectAsset | null>>();

  constructor(private readonly probe: MediaProber = probeMediaMetadata) {}

  /** The facts of a project-relative file, or null when it is missing (or outside the project). */
  async read(projectDir: string, path: string): Promise<ProjectAsset | null> {
    const abs = resolveWithinProject(projectDir, path);
    if (!abs) return null;
    let info;
    try {
      info = await stat(abs);
    } catch {
      return null;
    }
    if (!info.isFile()) return null;
    const key = `${projectDir}\0${path}`;
    const hit = this.cache.get(key);
    if (hit && hit.mtimeMs === info.mtimeMs && hit.size === info.size) return hit.asset;

    const flightKey = `${key}\0${info.mtimeMs}\0${info.size}`;
    const running = this.inFlight.get(flightKey);
    if (running) return running;
    const task = this.measure(abs, path, info.size).then((measured) => {
      if (measured.cacheable) {
        if (this.cache.size >= MAX_CACHED) this.cache.clear();
        this.cache.set(key, { mtimeMs: info.mtimeMs, size: info.size, asset: measured.asset });
      }
      return measured.asset;
    });
    this.inFlight.set(flightKey, task);
    try {
      return await task;
    } finally {
      this.inFlight.delete(flightKey);
    }
  }

  /** Cached facts only; never touches ffprobe. Undefined when the file was not probed (or changed since). */
  peek(projectDir: string, path: string): ProjectAsset | undefined {
    return this.cache.get(`${projectDir}\0${path}`)?.asset;
  }

  /** Probes many files with a small worker pool (a cold project scan runs one ffprobe per media file). */
  async readMany(projectDir: string, paths: readonly string[]): Promise<Map<string, ProjectAsset>> {
    const found = new Map<string, ProjectAsset>();
    let next = 0;
    const worker = async () => {
      for (let index = next++; index < paths.length; index = next++) {
        const path = paths[index];
        if (path === undefined) continue;
        const asset = await this.read(projectDir, path);
        if (asset) found.set(path, asset);
      }
    };
    await Promise.all(
      Array.from({ length: Math.min(PROBE_CONCURRENCY, paths.length) }, () => worker()),
    );
    return found;
  }

  private async measure(
    abs: string,
    path: string,
    bytes: number,
  ): Promise<{ asset: ProjectAsset; cacheable: boolean }> {
    const kind = assetKindOf(path);
    const bare: ProjectAsset = {
      path,
      kind,
      bytes,
      duration: null,
      width: null,
      height: null,
      hasAudio: null,
    };
    if (kind !== "video" && kind !== "audio" && kind !== "image") {
      return { asset: bare, cacheable: true };
    }
    const metadata = await this.probe(abs);
    return {
      asset: {
        ...bare,
        duration: metadata.durationSeconds ?? null,
        width: metadata.width ?? null,
        height: metadata.height ?? null,
        hasAudio: metadata.hasAudio ?? null,
      },
      // A failed probe (no ffprobe, unreadable file) is retried next time rather than remembered.
      cacheable: metadata.probeError === undefined,
    };
  }
}
