import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { dirname } from "node:path";
import {
  ASSET_SEARCH_MODES,
  LICENSE_CONFIDENCES,
  LICENSE_IDS,
  LICENSE_STATUSES,
  PROVENANCE_PATH,
  PROVENANCE_SCHEMA,
  PROVENANCE_MEDIA_KINDS,
  isRecord,
  type AssetProvenance,
  type ProvenanceLedger,
} from "@hyperframes/agent-protocol";
import { serialized } from "../analysis/store.js";
import { replaceFileAtomically } from "../helpers/atomicFile.js";
import { agentIdOf } from "./agents.js";
import { pinWithinProject, resolveWithinProject } from "../helpers/safePath.js";

const text = (value: unknown): string | null => (typeof value === "string" ? value : null);
const maybeText = (value: unknown): string | null | undefined =>
  value === null ? null : typeof value === "string" ? value : undefined;
const count = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;

function oneOf<T extends string>(allowed: readonly T[], value: unknown): T | null {
  return allowed.find((entry) => entry === value) ?? null;
}

/** One stored record, or null when it is not a usable one (a hand-edited or partly written file). */
function recordOf(raw: unknown): AssetProvenance | null {
  if (!isRecord(raw) || !isRecord(raw.source) || !isRecord(raw.retrievedBy)) return null;
  const id = text(raw.id);
  const asset = text(raw.asset);
  const title = text(raw.title);
  const originalUrl = text(raw.originalUrl);
  const license = text(raw.license);
  const attribution = text(raw.attribution);
  const sha256 = text(raw.sha256);
  const originalSha256 = text(raw.originalSha256);
  const contentType = text(raw.contentType);
  const licenseBasis = text(raw.licenseBasis);
  const mediaKind = oneOf(PROVENANCE_MEDIA_KINDS, raw.mediaKind);
  const licenseId = oneOf(LICENSE_IDS, raw.licenseId);
  const licenseConfidence = oneOf(LICENSE_CONFIDENCES, raw.licenseConfidence);
  const licenseStatus = oneOf(LICENSE_STATUSES, raw.licenseStatus);
  const policyMode = oneOf(ASSET_SEARCH_MODES, raw.policyMode);
  const retrievedAt = count(raw.retrievedAt);
  const bytes = count(raw.bytes);
  const pageUrl = maybeText(raw.pageUrl);
  const authorUrl = maybeText(raw.authorUrl);
  const author = maybeText(raw.author);
  const licenseUrl = maybeText(raw.licenseUrl);
  const converted = maybeText(raw.converted);
  const storyNode = maybeText(raw.storyNode);
  const need = maybeText(raw.need);
  const sourceId = text(raw.source.id);
  const sourceName = text(raw.source.name);
  const agent = text(raw.retrievedBy.agent);
  const turnId = maybeText(raw.retrievedBy.turnId);
  const model = maybeText(raw.retrievedBy.model);
  if (
    id === null ||
    asset === null ||
    title === null ||
    originalUrl === null ||
    license === null ||
    attribution === null ||
    sha256 === null ||
    originalSha256 === null ||
    contentType === null ||
    licenseBasis === null ||
    mediaKind === null ||
    licenseId === null ||
    licenseConfidence === null ||
    licenseStatus === null ||
    policyMode === null ||
    retrievedAt === null ||
    bytes === null ||
    sourceId === null ||
    sourceName === null ||
    typeof raw.source.trusted !== "boolean" ||
    agent === null ||
    turnId === undefined ||
    model === undefined ||
    pageUrl === undefined ||
    authorUrl === undefined ||
    author === undefined ||
    licenseUrl === undefined ||
    converted === undefined ||
    storyNode === undefined ||
    need === undefined
  ) {
    return null;
  }
  const importedFrom =
    isRecord(raw.importedFrom) &&
    typeof raw.importedFrom.project === "string" &&
    typeof raw.importedFrom.asset === "string"
      ? { project: raw.importedFrom.project, asset: raw.importedFrom.asset }
      : null;
  return {
    id,
    asset,
    mediaKind,
    title,
    originalUrl,
    pageUrl,
    source: { id: sourceId, name: sourceName, trusted: raw.source.trusted },
    author,
    authorUrl,
    license,
    licenseId,
    licenseUrl,
    licenseConfidence,
    licenseStatus,
    licenseBasis,
    attribution,
    retrievedAt,
    // `agent` is an AgentId or "user": the ledger is ours, and only its text form matters to readers.
    retrievedBy: { agent: agentIdOf(agent) ?? "user", turnId, model },
    policyMode,
    sha256,
    originalSha256,
    bytes,
    contentType,
    converted,
    storyNode,
    need,
    ...(importedFrom && { importedFrom }),
  };
}

/**
 * The project's provenance ledger. A missing file is an empty ledger; a file that cannot be read (damaged JSON,
 * wrong schema) is kept as `provenance.json.bak` and read as empty, and records that are not usable are dropped.
 */
export function readLedger(projectDir: string): ProvenanceLedger {
  return loadLedger(projectDir, true);
}

/** The ledger of a project this process only reads (another project): a damaged file is read as empty, never backed up. */
export function readLedgerReadOnly(projectDir: string): ProvenanceLedger {
  return loadLedger(projectDir, false);
}

function loadLedger(projectDir: string, keepDamaged: boolean): ProvenanceLedger {
  const empty: ProvenanceLedger = { schema: PROVENANCE_SCHEMA, records: [] };
  const abs = resolveWithinProject(projectDir, PROVENANCE_PATH);
  if (!abs || !existsSync(abs) || !statSync(abs).isFile()) return empty;
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(abs, "utf-8"));
  } catch {
    if (keepDamaged) backUp(abs);
    return empty;
  }
  if (!isRecord(raw) || raw.schema !== PROVENANCE_SCHEMA || !Array.isArray(raw.records)) {
    if (keepDamaged) backUp(abs);
    return empty;
  }
  const records = raw.records.flatMap((entry) => recordOf(entry) ?? []);
  if (records.length !== raw.records.length && keepDamaged) backUp(abs);
  return { schema: PROVENANCE_SCHEMA, records };
}

function backUp(file: string): void {
  try {
    copyFileSync(file, `${file}.bak`);
  } catch {
    // The ledger is still read as empty; the backup is best effort.
  }
}

/** Writes the ledger (pretty JSON, atomically). No history claim: the caller's turn window owns the write. */
export function writeLedger(projectDir: string, ledger: ProvenanceLedger): void {
  const abs = pinWithinProject(projectDir, PROVENANCE_PATH);
  if (!abs) throw new Error(`${PROVENANCE_PATH} is outside the project`);
  mkdirSync(dirname(abs), { recursive: true });
  replaceFileAtomically(abs, `${JSON.stringify(ledger, null, 2)}\n`, 0o644);
}

/**
 * Runs a read-modify-write of the project's ledger (and the files it describes) one at a time per project: Research
 * imports and cross-project imports share it.
 */
export function withLedgerLock<T>(projectDir: string, task: () => Promise<T>): Promise<T> {
  return serialized(`research\0${projectDir}`, task);
}
