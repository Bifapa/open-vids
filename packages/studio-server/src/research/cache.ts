import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync } from "node:fs";
import { dirname } from "node:path";
import {
  RESEARCH_MEDIA_KINDS,
  isRecord,
  type ResearchMediaKind,
} from "@hyperframes/agent-protocol";
import { replaceFileAtomically } from "../helpers/atomicFile.js";
import { pinWithinProject } from "../helpers/safePath.js";

/** The project's download cache: outside project history, so reverting an import never forgets the bytes. */
export const RESEARCH_CACHE_DIR = ".hyperframes/research/cache";
const INDEX_FILE = `${RESEARCH_CACHE_DIR}/index.json`;
const CACHE_SCHEMA = "openvids.research-cache/1";

export interface CacheEntry {
  sha256: string;
  bytes: number;
  contentType: string;
  mediaKind: ResearchMediaKind | null;
  /** File extension (no dot) the bytes were served as. */
  extension: string | null;
  finalUrl: string;
  at: number;
}

function entryOf(value: unknown): CacheEntry | null {
  if (!isRecord(value)) return null;
  const { sha256, bytes, contentType, mediaKind, extension, finalUrl, at } = value;
  if (
    typeof sha256 !== "string" ||
    !/^[0-9a-f]{64}$/.test(sha256) ||
    typeof bytes !== "number" ||
    typeof contentType !== "string" ||
    typeof finalUrl !== "string" ||
    typeof at !== "number"
  ) {
    return null;
  }
  return {
    sha256,
    bytes,
    contentType,
    mediaKind: RESEARCH_MEDIA_KINDS.find((kind) => kind === mediaKind) ?? null,
    extension: typeof extension === "string" ? extension : null,
    finalUrl,
    at,
  };
}

/**
 * URL → bytes index of one project's download cache (`.hyperframes/research/cache/`): the files are named by their
 * sha256, the index says which URL produced which file. A damaged index is an empty one (the files are only a
 * cache).
 */
export class ResearchCache {
  constructor(private readonly projectDir: string) {}

  private path(relative: string): string | null {
    return pinWithinProject(this.projectDir, relative);
  }

  private read(): Record<string, CacheEntry> {
    const file = this.path(INDEX_FILE);
    if (!file || !existsSync(file)) return {};
    try {
      const raw: unknown = JSON.parse(readFileSync(file, "utf-8"));
      if (!isRecord(raw) || raw.schema !== CACHE_SCHEMA || !isRecord(raw.entries)) return {};
      const entries: Record<string, CacheEntry> = {};
      for (const [url, value] of Object.entries(raw.entries)) {
        const entry = entryOf(value);
        if (entry) entries[url] = entry;
      }
      return entries;
    } catch {
      return {};
    }
  }

  private write(entries: Record<string, CacheEntry>): void {
    const file = this.path(INDEX_FILE);
    if (!file) throw new Error("The research cache is outside the project");
    mkdirSync(dirname(file), { recursive: true });
    replaceFileAtomically(
      file,
      `${JSON.stringify({ schema: CACHE_SCHEMA, entries }, null, 2)}\n`,
      0o644,
    );
  }

  /** Absolute path of a cached file by content hash, when its bytes are still there. */
  fileFor(sha256: string): string | null {
    const file = this.path(`${RESEARCH_CACHE_DIR}/${sha256}.bin`);
    return file && existsSync(file) ? file : null;
  }

  /** The cached answer for a URL: its entry and the file holding the bytes. Null when either is gone. */
  lookup(url: string): { entry: CacheEntry; file: string } | null {
    const entry = this.read()[url];
    if (!entry) return null;
    const file = this.fileFor(entry.sha256);
    return file ? { entry, file } : null;
  }

  /** The hashes of originals whose bytes came from `url` (what the index knows, for `inProject`). */
  shaForUrl(url: string): string | null {
    return this.read()[url]?.sha256 ?? null;
  }

  /** Moves a downloaded file into the cache (named by hash) and records which URL produced it. */
  store(url: string, downloaded: string, entry: CacheEntry): void {
    const target = this.path(`${RESEARCH_CACHE_DIR}/${entry.sha256}.bin`);
    if (!target) throw new Error("The research cache is outside the project");
    mkdirSync(dirname(target), { recursive: true });
    if (existsSync(target)) rmSync(downloaded, { force: true });
    else renameSync(downloaded, target);
    this.write({ ...this.read(), [url]: entry });
  }

  /** A private working copy of cached bytes (conversion and the final rename must not touch the cache). */
  copyTo(entry: CacheEntry, destination: string): void {
    const file = this.fileFor(entry.sha256);
    if (!file) throw new Error("The cached file is gone");
    copyFileSync(file, destination);
  }

  /** Scratch directory inside the cache folder (same filesystem as the project, so the final move is a rename). */
  scratchDir(name: string): string {
    const dir = this.path(`${RESEARCH_CACHE_DIR}/tmp/${name}`);
    if (!dir) throw new Error("The research cache is outside the project");
    mkdirSync(dir, { recursive: true });
    return dir;
  }
}
