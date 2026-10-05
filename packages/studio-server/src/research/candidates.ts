import { createHash } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import {
  isAssetCandidate,
  isRecord,
  type AssetCandidate,
  type AssetSourceRef,
} from "@hyperframes/agent-protocol";
import { replaceFileAtomically } from "../helpers/atomicFile.js";
import type { RawCandidate } from "./sources/types.js";

const MAX_CANDIDATES = 2_000;
/** A candidate older than this is forgotten: its source may have changed the file or its terms since. */
export const CANDIDATE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const CANDIDATES_SCHEMA = "openvids.research-candidates/1";
/** Where one project keeps its candidates: next to the download cache, outside project history. */
export const CANDIDATES_PATH = ".hyperframes/research/candidates.json";

interface StoredCandidate {
  candidate: AssetCandidate;
  /** Exact hosts a download of this candidate may use in trusted mode (issued by the source's connector). */
  grants: string[];
  /** When the search or inspection found it. */
  at: number;
}

export interface CandidateRegistryOptions {
  /** Where the registry is kept between server restarts; without it candidates live in memory only. */
  file?: string;
  now?: () => number;
}

function storedOf(value: unknown): StoredCandidate | null {
  if (!isRecord(value) || !isAssetCandidate(value.candidate)) return null;
  const { grants, at } = value;
  if (typeof at !== "number" || !Array.isArray(grants)) return null;
  return {
    candidate: value.candidate,
    grants: grants.filter((host): host is string => typeof host === "string"),
    at,
  };
}

/**
 * One project's record of what its searches and inspections found (a candidate id of another project is unknown to
 * it). A candidate's id names this record — its URLs, author and
 * license as the source reported them — so importing by id can never take facts from a model. Ids are stable for one
 * (source, media URL) pair. With a `file` the record survives a server restart (an agent turn can import what it
 * searched before the restart) for {@link CANDIDATE_TTL_MS}; a damaged file is an empty record, and the grants of a
 * restored candidate are still judged against the policy at import time.
 */
export class CandidateRegistry {
  private readonly candidates = new Map<string, StoredCandidate>();
  private readonly file: string | undefined;
  private readonly now: () => number;
  private loaded = false;
  private flushing = false;

  constructor(options: CandidateRegistryOptions = {}) {
    this.file = options.file;
    this.now = options.now ?? Date.now;
  }

  register(raw: RawCandidate, source: AssetSourceRef, grants: string[]): AssetCandidate {
    this.load();
    const id = `cand-${createHash("sha256").update(`${source.id}\0${raw.mediaUrl}`).digest("hex").slice(0, 12)}`;
    const candidate: AssetCandidate = { ...raw, id, source, inProject: null };
    this.candidates.delete(id);
    this.candidates.set(id, { candidate, grants, at: this.now() });
    if (this.candidates.size > MAX_CANDIDATES) {
      const oldest = this.candidates.keys().next();
      if (!oldest.done) this.candidates.delete(oldest.value);
    }
    this.scheduleSave();
    return candidate;
  }

  get(id: string): StoredCandidate | undefined {
    this.load();
    const stored = this.candidates.get(id);
    if (stored && stored.at + CANDIDATE_TTL_MS < this.now()) {
      this.candidates.delete(id);
      return undefined;
    }
    return stored;
  }

  /** Reads the file once, on first use; what was registered in memory before stays. */
  private load(): void {
    if (this.loaded) return;
    this.loaded = true;
    if (!this.file) return;
    try {
      const parsed: unknown = JSON.parse(readFileSync(this.file, "utf-8"));
      if (
        !isRecord(parsed) ||
        parsed.schema !== CANDIDATES_SCHEMA ||
        !Array.isArray(parsed.entries)
      )
        return;
      const earlier = [...this.candidates];
      this.candidates.clear();
      for (const entry of parsed.entries) {
        const stored = storedOf(entry);
        if (stored && stored.at + CANDIDATE_TTL_MS >= this.now())
          this.candidates.set(stored.candidate.id, stored);
      }
      for (const [id, stored] of earlier) this.candidates.set(id, stored);
    } catch {
      // Missing or damaged: an empty record.
    }
  }

  /** One write per burst of registrations (a search registers its candidates in a loop). */
  private scheduleSave(): void {
    if (!this.file || this.flushing) return;
    this.flushing = true;
    queueMicrotask(() => {
      this.flushing = false;
      this.save();
    });
  }

  private save(): void {
    if (!this.file) return;
    try {
      mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 });
      replaceFileAtomically(
        this.file,
        JSON.stringify({ schema: CANDIDATES_SCHEMA, entries: [...this.candidates.values()] }),
        0o600,
      );
    } catch {
      // A derived cache: losing a write only means a search again after a restart.
    }
  }
}
