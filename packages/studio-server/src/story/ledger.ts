import { existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { dirname } from "node:path";
import {
  STORY_SYNC_PATH,
  STORY_SYNC_ROLES,
  isRecord,
  type StorySyncRole,
} from "@hyperframes/agent-protocol";
import { replaceFileAtomically } from "../helpers/atomicFile.js";
import { pinWithinProject, resolveWithinProject } from "../helpers/safePath.js";
import type { ClipState } from "../editing/clipState.js";

export const SYNC_LEDGER_SCHEMA = 1;

/** A clip a unit created, with the state it was generated in (moved along whenever its section moves). */
export interface LedgerEntity {
  clip: string;
  state: ClipState;
}

/**
 * One built unit: the story node it is for, the intent it was built from (the compiler's relative operations, kept
 * as JSON and only ever compared), and its clips.
 */
export interface LedgerUnit {
  node: string;
  role: StorySyncRole;
  intent: unknown;
  entities: LedgerEntity[];
  turnId: string | null;
}

export interface LedgerSection {
  chapter: string;
  /** Where the section started on the timeline at the last sync. */
  start: number;
  /** Its length as compiled at the last sync (what the graph asked for, not what the user trimmed it to). */
  length: number;
  units: LedgerUnit[];
}

export interface LedgerCaptions {
  preset: string;
  /** Fingerprint of the cues written. */
  cues: string;
  /** Fingerprint of the captions file as written (a different file = edited by hand). */
  file: string | null;
  entity: LedgerEntity | null;
  turnId: string | null;
}

/**
 * `.hyperframes/story/sync.json`: what each built section owns on the timeline and the state it was generated in.
 * Written only by Build Story / Rebuild, in the same turn window as the composition; history-tracked, so a
 * reverted turn restores it with the timeline.
 */
export interface SyncLedger {
  schema: typeof SYNC_LEDGER_SCHEMA;
  composition: string;
  syncedAt: number;
  turnId: string | null;
  /** In timeline order. */
  sections: LedgerSection[];
  music: Array<LedgerUnit & { covers: string[] }>;
  captions: LedgerCaptions | null;
}

const num = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);
const str = (value: unknown): value is string => typeof value === "string";
const strOrNull = (value: unknown): value is string | null => value === null || str(value);
const numOrNull = (value: unknown): value is number | null => value === null || num(value);

function isState(value: unknown): value is ClipState {
  if (!isRecord(value)) return false;
  const frame = value.frame;
  return (
    str(value.kind) &&
    num(value.start) &&
    num(value.duration) &&
    num(value.track) &&
    strOrNull(value.src) &&
    strOrNull(value.compositionSrc) &&
    numOrNull(value.mediaStart) &&
    num(value.playbackRate) &&
    numOrNull(value.volume) &&
    typeof value.muted === "boolean" &&
    num(value.fadeIn) &&
    num(value.fadeOut) &&
    numOrNull(value.zIndex) &&
    (frame === null ||
      (isRecord(frame) &&
        num(frame.left) &&
        num(frame.top) &&
        num(frame.width) &&
        num(frame.height))) &&
    strOrNull(value.fit) &&
    typeof value.locked === "boolean" &&
    (value.studio === undefined ||
      (isRecord(value.studio) && Object.values(value.studio).every(str)))
  );
}

function isEntity(value: unknown): value is LedgerEntity {
  return isRecord(value) && str(value.clip) && isState(value.state);
}

function isUnit(value: unknown): value is LedgerUnit {
  return (
    isRecord(value) &&
    str(value.node) &&
    STORY_SYNC_ROLES.some((role) => role === value.role) &&
    "intent" in value &&
    Array.isArray(value.entities) &&
    value.entities.every(isEntity) &&
    strOrNull(value.turnId)
  );
}

function isSection(value: unknown): value is LedgerSection {
  return (
    isRecord(value) &&
    str(value.chapter) &&
    num(value.start) &&
    num(value.length) &&
    Array.isArray(value.units) &&
    value.units.every(isUnit)
  );
}

function isMusic(value: unknown): value is LedgerUnit & { covers: string[] } {
  return isUnit(value) && isRecord(value) && Array.isArray(value.covers) && value.covers.every(str);
}

function isCaptions(value: unknown): value is LedgerCaptions {
  return (
    isRecord(value) &&
    str(value.preset) &&
    str(value.cues) &&
    strOrNull(value.file) &&
    (value.entity === null || isEntity(value.entity)) &&
    strOrNull(value.turnId)
  );
}

export function isSyncLedger(value: unknown): value is SyncLedger {
  return (
    isRecord(value) &&
    value.schema === SYNC_LEDGER_SCHEMA &&
    str(value.composition) &&
    num(value.syncedAt) &&
    strOrNull(value.turnId) &&
    Array.isArray(value.sections) &&
    value.sections.every(isSection) &&
    Array.isArray(value.music) &&
    value.music.every(isMusic) &&
    (value.captions === null || isCaptions(value.captions))
  );
}

export type LedgerRead =
  | { state: "none" }
  | { state: "damaged"; message: string }
  | { state: "ok"; ledger: SyncLedger; bytes: string };

/** The stored ledger. A damaged one is reported (the story is then untracked until a full Build writes a new one). */
export function readLedger(projectDir: string): LedgerRead {
  const abs = resolveWithinProject(projectDir, STORY_SYNC_PATH);
  if (!abs || !existsSync(abs) || !statSync(abs).isFile()) return { state: "none" };
  const bytes = readFileSync(abs, "utf-8");
  let raw: unknown;
  try {
    raw = JSON.parse(bytes);
  } catch {
    return { state: "damaged", message: `${STORY_SYNC_PATH} is not valid JSON` };
  }
  if (!isSyncLedger(raw)) {
    return {
      state: "damaged",
      message: `${STORY_SYNC_PATH} is not a sync record this version reads`,
    };
  }
  return { state: "ok", ledger: raw, bytes };
}

/** Writes the ledger atomically. No history claim: it belongs to the turn that built. */
export function writeLedger(projectDir: string, ledger: SyncLedger): void {
  const abs = pinWithinProject(projectDir, STORY_SYNC_PATH);
  if (!abs) throw new Error(`${STORY_SYNC_PATH} is outside the project`);
  mkdirSync(dirname(abs), { recursive: true });
  replaceFileAtomically(abs, `${JSON.stringify(ledger, null, 2)}\n`, 0o644);
}
