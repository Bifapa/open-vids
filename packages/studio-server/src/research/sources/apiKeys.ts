import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { isRecord } from "@hyperframes/agent-protocol";
import { replaceFileAtomically } from "../../helpers/atomicFile.js";

const KEYS_SCHEMA = "openvids.research-keys/1";
/** Beside `policy.json`; the Projects page (`research_policy.rs`) reads and writes the same file. */
export const API_KEYS_FILE = "api-keys.json";

/**
 * The API keys the user entered for the built-in sources that need one, by source id. Owner-only file, replaced
 * atomically; the keys are only ever read by the connectors and never served back. An unreadable file reads as no
 * keys (the sources ask for a key again), it is never widened into anything else.
 */
export class ApiKeyStore {
  private readonly file: string;

  constructor(dir: string) {
    this.file = join(dir, API_KEYS_FILE);
  }

  private load(): Record<string, string> {
    if (!existsSync(this.file)) return {};
    try {
      const raw: unknown = JSON.parse(readFileSync(this.file, "utf-8"));
      if (!isRecord(raw) || raw.schema !== KEYS_SCHEMA || !isRecord(raw.keys)) return {};
      const keys: Record<string, string> = {};
      for (const [id, key] of Object.entries(raw.keys)) {
        if (typeof key === "string" && key.length > 0) keys[id] = key;
      }
      return keys;
    } catch {
      return {};
    }
  }

  private save(keys: Record<string, string>): void {
    mkdirSync(join(this.file, ".."), { recursive: true, mode: 0o700 });
    replaceFileAtomically(
      this.file,
      `${JSON.stringify({ schema: KEYS_SCHEMA, keys }, null, 2)}\n`,
      0o600,
    );
  }

  get(id: string): string | null {
    return this.load()[id] ?? null;
  }

  /** Ids of the sources with a saved key. */
  configured(): Set<string> {
    return new Set(Object.keys(this.load()));
  }

  set(id: string, key: string): void {
    this.save({ ...this.load(), [id]: key });
  }

  remove(id: string): void {
    const { [id]: _dropped, ...rest } = this.load();
    this.save(rest);
  }
}
