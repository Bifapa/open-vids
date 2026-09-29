import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import * as fs from "node:fs";
import { withFileLock } from "../media-use/lib/config-lock.mjs";

// Local consent store for the on-device embedding model download (~33 MB).
// A single small JSON file under ~/.hyperframes; no network, no reporting.
// Reads concurrent with a write in progress observe the on-disk value first
// (settings lock), so a just-saved answer is visible immediately.

const CONSENT_DIR = join(homedir(), ".hyperframes");
const CONSENT_FILE = join(CONSENT_DIR, "local-model-consent.json");

export type LocalModelDecision = boolean | undefined;

interface ConsentFile {
  localEmbeddingEnabled?: boolean;
}

function consentFrom(value: unknown): boolean | undefined {
  return value === undefined ? undefined : value === true;
}

function readConsentFile(): ConsentFile {
  try {
    if (!existsSync(CONSENT_FILE)) return {};
    const parsed: unknown = JSON.parse(readFileSync(CONSENT_FILE, "utf-8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const enabled = "localEmbeddingEnabled" in parsed ? parsed.localEmbeddingEnabled : undefined;
    return { localEmbeddingEnabled: consentFrom(enabled) };
  } catch {
    return {};
  }
}

function writeConsentFile(next: boolean): boolean {
  try {
    mkdirSync(CONSENT_DIR, { recursive: true, mode: 0o700 });
    const tmp = `${CONSENT_FILE}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify({ localEmbeddingEnabled: next }, null, 2) + "\n", {
      mode: 0o600,
    });
    renameSync(tmp, CONSENT_FILE);
    return true;
  } catch {
    return false;
  }
}

let holdingLock = false;

function withConsentLock<T>(task: () => T): T {
  if (holdingLock) return task();
  mkdirSync(CONSENT_DIR, { recursive: true, mode: 0o700 });
  return withFileLock(`${CONSENT_FILE}.lock`, fs, () => {
    holdingLock = true;
    try {
      return task();
    } finally {
      holdingLock = false;
    }
  });
}

/** The saved answer, or undefined when never asked. */
export function localModelConsent(): LocalModelDecision {
  return readConsentFile().localEmbeddingEnabled;
}

export function updateLocalModelConsent(
  decide: (onDisk: boolean | undefined) => boolean | undefined,
): LocalModelDecision {
  try {
    return withConsentLock(() => {
      const onDisk = readConsentFile().localEmbeddingEnabled;
      const next = decide(onDisk);
      if (next === onDisk) return next;
      if (next === undefined) return onDisk;
      return writeConsentFile(next) ? next : onDisk;
    });
  } catch {
    return readConsentFile().localEmbeddingEnabled;
  }
}
