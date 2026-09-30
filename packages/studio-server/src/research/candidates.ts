import { createHash } from "node:crypto";
import type { AssetCandidate, AssetSourceRef } from "@hyperframes/agent-protocol";
import type { RawCandidate } from "./sources/types.js";

const MAX_CANDIDATES = 2_000;

interface StoredCandidate {
  candidate: AssetCandidate;
  /** Exact hosts a download of this candidate may use in trusted mode (issued by the source's connector). */
  grants: string[];
}

/**
 * The server's record of what searches and inspections found. A candidate's id names this record — its URLs, author and
 * license as the source reported them — so importing by id can never take facts from a model. Ids are stable for one
 * (source, media URL) pair and live as long as the Studio server process.
 */
export class CandidateRegistry {
  private readonly candidates = new Map<string, StoredCandidate>();

  register(raw: RawCandidate, source: AssetSourceRef, grants: string[]): AssetCandidate {
    const id = `cand-${createHash("sha256").update(`${source.id}\0${raw.mediaUrl}`).digest("hex").slice(0, 12)}`;
    const candidate: AssetCandidate = { ...raw, id, source, inProject: null };
    this.candidates.delete(id);
    this.candidates.set(id, { candidate, grants });
    if (this.candidates.size > MAX_CANDIDATES) {
      const oldest = this.candidates.keys().next();
      if (!oldest.done) this.candidates.delete(oldest.value);
    }
    return candidate;
  }

  get(id: string): StoredCandidate | undefined {
    return this.candidates.get(id);
  }
}
