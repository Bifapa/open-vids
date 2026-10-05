import {
  EDIT_LIMITS,
  type ClipFrame,
  type ClipProvenance,
  type EditError,
  type ParsedEdit,
} from "./editing.js";
import { isRecord } from "./validate.js";

/** A refused value: the message names the field. */
export type Field = { ok: true } | { ok: false; message: string };

export const invalid = (message: string, opIndex?: number): { ok: false; error: EditError } => ({
  ok: false,
  error: { code: "invalid_request", message, ...(opIndex !== undefined && { opIndex }) },
});

export function isField(value: unknown): value is Field {
  return isRecord(value) && "ok" in value;
}

export function readString(value: unknown, field: string, max: number): string | Field {
  if (typeof value !== "string" || value.trim().length === 0)
    return { ok: false, message: `${field} must be a non-empty string` };
  if (value.length > max) return { ok: false, message: `${field} exceeds ${max} characters` };
  return value;
}

export function readTime(value: unknown, field: string, positive = false): number | Field {
  if (typeof value !== "number" || !Number.isFinite(value))
    return { ok: false, message: `${field} must be a finite number of seconds` };
  if (value < 0 || (positive && value === 0))
    return { ok: false, message: `${field} must be ${positive ? "greater than" : "at least"} 0` };
  if (value > EDIT_LIMITS.maxTime)
    return { ok: false, message: `${field} exceeds ${EDIT_LIMITS.maxTime} seconds` };
  return value;
}

/** A finite number within `[min, max]`. */
export function readNumberIn(
  value: unknown,
  field: string,
  min: number,
  max: number,
): number | Field {
  if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max)
    return { ok: false, message: `${field} must be a number from ${min} to ${max}` };
  return value;
}

export function readTrack(value: unknown, field: string): number | Field {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0)
    return { ok: false, message: `${field} must be a non-negative integer` };
  if (value > EDIT_LIMITS.maxTrack)
    return { ok: false, message: `${field} exceeds ${EDIT_LIMITS.maxTrack}` };
  return value;
}

export function readVolume(value: unknown): number | Field {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0)
    return { ok: false, message: "volume must be a number ≥ 0" };
  if (value > EDIT_LIMITS.maxVolume)
    return { ok: false, message: `volume exceeds ${EDIT_LIMITS.maxVolume}` };
  return value;
}

/** Canvas sides are even (H.264 encodes whole chroma blocks), positive and within the render's limit. */
export function readCanvasPixels(value: unknown, field: string): number | Field {
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0)
    return { ok: false, message: `${field} must be a positive whole number of pixels` };
  if (value % 2 !== 0) return { ok: false, message: `${field} must be even` };
  if (value > EDIT_LIMITS.maxCanvasPixels)
    return { ok: false, message: `${field} exceeds ${EDIT_LIMITS.maxCanvasPixels} pixels` };
  return value;
}

export function readFrame(value: unknown): ClipFrame | Field {
  if (!isRecord(value)) return { ok: false, message: "frame must be {x, y, width, height}" };
  const extra = Object.keys(value).find((key) => !["x", "y", "width", "height"].includes(key));
  if (extra) return { ok: false, message: `frame: unknown field "${extra}"` };
  const { x, y, width, height } = value;
  const limit = EDIT_LIMITS.maxFramePixels;
  const finite = (n: unknown): n is number =>
    typeof n === "number" && Number.isFinite(n) && Math.abs(n) <= limit;
  if (!finite(x) || !finite(y))
    return { ok: false, message: `frame x/y must be numbers within ±${limit}` };
  if (!finite(width) || !finite(height) || width <= 0 || height <= 0)
    return { ok: false, message: `frame width/height must be positive numbers up to ${limit}` };
  return { x, y, width, height };
}

export function oneOf<T extends string>(
  value: unknown,
  allowed: readonly T[],
  field: string,
): T | Field {
  const match = allowed.find((candidate) => candidate === value);
  return match ?? { ok: false, message: `${field} must be one of ${allowed.join(", ")}` };
}

const PROVENANCE_KEYS = ["storyNode", "cut", "turn"] as const;
export const PROVENANCE_ID = /^[A-Za-z0-9_.:-]{1,200}$/;

/** `provenance` of an add operation: any of the three ids, each a plain token that is safe to write as an attribute. */
export function readProvenance(value: unknown): Partial<ClipProvenance> | Field {
  if (!isRecord(value)) return { ok: false, message: "provenance must be an object" };
  const extra = Object.keys(value).find((key) => !PROVENANCE_KEYS.some((known) => known === key));
  if (extra) return { ok: false, message: `provenance: unknown field "${extra}"` };
  const read: Partial<ClipProvenance> = {};
  for (const key of PROVENANCE_KEYS) {
    const entry = value[key];
    if (entry === undefined) continue;
    if (typeof entry !== "string" || !PROVENANCE_ID.test(entry)) {
      return { ok: false, message: `provenance.${key} must be an id (letters, digits, _ . : -)` };
    }
    read[key] = entry;
  }
  if (Object.keys(read).length === 0) {
    return { ok: false, message: "provenance must set storyNode, cut or turn" };
  }
  return read;
}

/**
 * The readers of one operation object. Every value goes through a reader; failures collect in `failures` with the
 * field name, and a reader returns undefined for a missing or refused value.
 */
export interface OpReader {
  raw: Record<string, unknown>;
  failures: string[];
  need: <T>(value: T | Field) => T | undefined;
  maybe: <T>(key: string, read: (value: unknown) => T | Field) => T | undefined;
  bool: (key: string) => boolean | undefined;
  clipRef: () => string | undefined;
  time: (key: string, positive?: boolean) => number | undefined;
  optTime: (key: string, positive?: boolean) => number | undefined;
  track: () => number | undefined;
  optTrack: () => number | undefined;
  volume: () => number | undefined;
  provenance: () => Partial<ClipProvenance> | undefined;
  /** A list of distinct clip ids (`key`), 1..max entries. */
  clipList: (key: string, max: number) => string[] | undefined;
}

export function createOpReader(raw: Record<string, unknown>): OpReader {
  const failures: string[] = [];
  const need = <T>(value: T | Field): T | undefined => {
    if (isField(value)) {
      if (!value.ok) failures.push(value.message);
      return undefined;
    }
    return value;
  };
  const maybe = <T>(key: string, read: (value: unknown) => T | Field): T | undefined =>
    raw[key] === undefined ? undefined : need(read(raw[key]));
  const bool = (key: string): boolean | undefined => {
    const value = raw[key];
    if (value === undefined) return undefined;
    if (typeof value !== "boolean") {
      failures.push(`${key} must be true or false`);
      return undefined;
    }
    return value;
  };
  const time = (key: string, positive = false) => need(readTime(raw[key], key, positive));
  const optTime = (key: string, positive = false) =>
    maybe(key, (value) => readTime(value, key, positive));
  return {
    raw,
    failures,
    need,
    maybe,
    bool,
    clipRef: () => need(readString(raw.clip, "clip", EDIT_LIMITS.idChars)),
    time,
    optTime,
    track: () => need(readTrack(raw.track, "track")),
    optTrack: () => maybe("track", (value) => readTrack(value, "track")),
    volume: () => maybe("volume", readVolume),
    provenance: () => maybe("provenance", readProvenance),
    clipList: (key, max) => {
      const value = raw[key];
      if (!Array.isArray(value) || value.length === 0) {
        failures.push(`${key} must be a non-empty array of clip ids`);
        return undefined;
      }
      if (value.length > max) {
        failures.push(`${key} exceeds ${max} entries`);
        return undefined;
      }
      const ids: string[] = [];
      for (const [index, entry] of value.entries()) {
        const id = need(readString(entry, `${key}[${index}]`, EDIT_LIMITS.idChars));
        if (id !== undefined) ids.push(id);
      }
      if (new Set(ids).size !== ids.length) failures.push(`${key} must not repeat a clip`);
      return ids;
    },
  };
}

export type { ParsedEdit };
