/**
 * OpenVids editing capabilities: the product-level contract between the Studio server's editing service
 * (`/api/projects/:id/editing/*`) and the agent runtime's editing tools. It names timeline concepts (clips, tracks,
 * assets, presets, renders), not Studio or WebMCP internals, so either side can change its implementation freely.
 *
 * Times are seconds on the edited composition's timeline. Clip ids are the clip's stable `data-hf-id`; its DOM `id`
 * is accepted wherever a clip id is expected.
 */

import { isRecord } from "./validate.js";

// ── Inventory ────────────────────────────────────────────────────────────────

export const ASSET_KINDS = ["video", "audio", "image", "font", "other"] as const;
export type AssetKind = (typeof ASSET_KINDS)[number];

export interface ProjectAsset {
  /** Project-relative path, `/`-separated. */
  path: string;
  kind: AssetKind;
  bytes: number;
  /** Media duration in seconds (video/audio), when it could be probed. */
  duration: number | null;
  width: number | null;
  height: number | null;
  /** Video only: whether the file carries an audio stream. */
  hasAudio: boolean | null;
}

export interface CompositionSummary {
  path: string;
  width: number;
  height: number;
  duration: number;
  clipCount: number;
  /** The project's entry composition (what a render without `composition` renders). */
  isMain: boolean;
}

export interface RenderedFile {
  path: string;
  bytes: number;
  createdAt: number;
}

export interface ProjectInventory {
  compositions: CompositionSummary[];
  assets: ProjectAsset[];
  renders: RenderedFile[];
}

// ── Timeline ─────────────────────────────────────────────────────────────────

export const CLIP_KINDS = ["video", "audio", "image", "composition", "text", "element"] as const;
export type ClipKind = (typeof CLIP_KINDS)[number];

export interface TimelineClip {
  /** Stable clip id (`data-hf-id`). */
  id: string;
  /** The element's DOM id, when it has one. */
  domId: string | null;
  kind: ClipKind;
  /** Short human label: file name, text, or component name. */
  label: string;
  start: number;
  duration: number;
  end: number;
  track: number;
  zIndex: number | null;
  /** Project-relative media path (video/audio/image). */
  src: string | null;
  /** Source in-point in seconds (video/audio). */
  mediaStart: number | null;
  /** Full length of the source media, when known. */
  sourceDuration: number | null;
  volume: number | null;
  muted: boolean;
  /** Project-relative sub-composition file (kind `composition`). */
  compositionSrc: string | null;
  /** Locked clips cannot be edited. */
  locked: boolean;
}

export interface TimelineTrack {
  index: number;
  clipIds: string[];
}

export interface TimelineSnapshot {
  composition: { path: string; width: number; height: number; duration: number };
  /** Content version of the composition file; pass it back as `baseVersion` to refuse edits on a stale view. */
  version: string;
  tracks: TimelineTrack[];
  clips: TimelineClip[];
}

// ── Operations ───────────────────────────────────────────────────────────────

export const CLIP_FITS = ["contain", "cover"] as const;
export type ClipFit = (typeof CLIP_FITS)[number];

export const TEXT_PLACEMENTS = ["top", "center", "bottom"] as const;
export type TextPlacement = (typeof TEXT_PLACEMENTS)[number];

export const TEXT_SIZES = ["small", "medium", "large"] as const;
export type TextSize = (typeof TEXT_SIZES)[number];

export interface CaptionCue {
  text: string;
  start: number;
  end: number;
}

/** Where a visual clip sits in the composition frame, in composition pixels (left/top corner and size). */
export interface ClipFrame {
  x: number;
  y: number;
  width: number;
  height: number;
}

export type EditOperation =
  /** Place a project asset (video, image or audio) on the timeline. */
  | {
      op: "add_clip";
      asset: string;
      start: number;
      track: number;
      /** Defaults: remaining media length (video/audio), 3 s (image, like a Studio drop). */
      duration?: number;
      mediaStart?: number;
      volume?: number;
      muted?: boolean;
      fit?: ClipFit;
      /** Video/image: position and size; default fits the media inside the frame, centred. */
      frame?: ClipFrame;
      /** Audio/video: linear gain ramps (seconds) at the clip's start and end. */
      fadeIn?: number;
      fadeOut?: number;
    }
  /** A simple text/title clip. */
  | {
      op: "add_text";
      text: string;
      start: number;
      duration: number;
      track: number;
      placement?: TextPlacement;
      size?: TextSize;
      color?: string;
    }
  /** Install a registry block/component (motion graphics) and mount it as a sub-composition clip. */
  | {
      op: "add_component";
      name: string;
      start: number;
      track: number;
      duration?: number;
    }
  /** Write the project's captions from cues in a caption preset's style, spanning the whole composition. */
  | { op: "apply_captions"; preset: string; cues: CaptionCue[]; track?: number }
  | { op: "remove_clip"; clip: string; ripple?: boolean }
  | { op: "move_clip"; clip: string; start?: number; track?: number }
  /** New timeline in/out points; trimming the head of a video/audio clip advances its media in-point. */
  | { op: "trim_clip"; clip: string; start?: number; end?: number }
  | { op: "split_clip"; clip: string; at: number }
  | {
      op: "set_clip";
      clip: string;
      volume?: number;
      muted?: boolean;
      fit?: ClipFit;
      zIndex?: number;
      /** Video/image/component: position and size in composition pixels. */
      frame?: ClipFrame;
      fadeIn?: number;
      fadeOut?: number;
    }
  /** Lay the clips end to end on `track` in the given order, starting at `start` (default 0). */
  | { op: "arrange_track"; track: number; clips: string[]; start?: number; gap?: number }
  /** Explicit composition length; without it the length follows the content after every batch. */
  | { op: "set_composition"; duration: number };

export type EditOperationName = EditOperation["op"];

export const EDIT_OPERATION_NAMES = [
  "add_clip",
  "add_text",
  "add_component",
  "apply_captions",
  "remove_clip",
  "move_clip",
  "trim_clip",
  "split_clip",
  "set_clip",
  "arrange_track",
  "set_composition",
] as const satisfies readonly EditOperationName[];

export interface ApplyEditsRequest {
  /** Project-relative composition path; defaults to the main composition. */
  composition?: string;
  baseVersion?: string;
  operations: EditOperation[];
}

export interface EditOperationResult {
  op: EditOperationName;
  /** The clip the operation created or changed. */
  clipId: string | null;
  /** split_clip: the new second half. */
  newClipId: string | null;
}

export interface ApplyEditsResponse {
  timeline: TimelineSnapshot;
  results: EditOperationResult[];
  /** Project-relative files written by the batch. */
  changedFiles: string[];
}

export const EDIT_ERROR_CODES = [
  "invalid_request",
  "unknown_composition",
  "unknown_clip",
  "unknown_asset",
  "unknown_preset",
  "out_of_bounds",
  "locked",
  "conflict",
  "unsupported",
] as const;
export type EditErrorCode = (typeof EDIT_ERROR_CODES)[number];

export interface EditError {
  code: EditErrorCode;
  message: string;
  /** Index of the failing operation in the batch. */
  opIndex?: number;
}

// ── Presets ──────────────────────────────────────────────────────────────────

export const PRESET_KINDS = ["caption", "block", "component"] as const;
export type PresetKind = (typeof PRESET_KINDS)[number];

export interface PresetInfo {
  name: string;
  kind: PresetKind;
  title: string;
  description: string;
  tags: string[];
  /** Natural length in seconds (blocks/components), when declared. */
  duration: number | null;
}

// ── Limits and validation ────────────────────────────────────────────────────

export const EDIT_LIMITS = {
  operations: 50,
  captionCues: 500,
  textChars: 500,
  pathChars: 1_024,
  idChars: 200,
  arrangeClips: 100,
  maxTime: 24 * 60 * 60,
  maxTrack: 999,
  /** `data-volume` ceiling: +12 dB. */
  maxVolume: 3.98,
  /** Largest |coordinate| or size of a clip frame, in composition pixels. */
  maxFramePixels: 20_000,
} as const;

export type ParsedEdit<T> = { ok: true; value: T } | { ok: false; error: EditError };

type Field = { ok: true } | { ok: false; message: string };

const invalid = (message: string, opIndex?: number): { ok: false; error: EditError } => ({
  ok: false,
  error: { code: "invalid_request", message, ...(opIndex !== undefined && { opIndex }) },
});

function readString(value: unknown, field: string, max: number): string | Field {
  if (typeof value !== "string" || value.trim().length === 0)
    return { ok: false, message: `${field} must be a non-empty string` };
  if (value.length > max) return { ok: false, message: `${field} exceeds ${max} characters` };
  return value;
}

function readTime(value: unknown, field: string, positive = false): number | Field {
  if (typeof value !== "number" || !Number.isFinite(value))
    return { ok: false, message: `${field} must be a finite number of seconds` };
  if (value < 0 || (positive && value === 0))
    return { ok: false, message: `${field} must be ${positive ? "greater than" : "at least"} 0` };
  if (value > EDIT_LIMITS.maxTime)
    return { ok: false, message: `${field} exceeds ${EDIT_LIMITS.maxTime} seconds` };
  return value;
}

function readTrack(value: unknown, field: string): number | Field {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0)
    return { ok: false, message: `${field} must be a non-negative integer` };
  if (value > EDIT_LIMITS.maxTrack)
    return { ok: false, message: `${field} exceeds ${EDIT_LIMITS.maxTrack}` };
  return value;
}

function readVolume(value: unknown): number | Field {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0)
    return { ok: false, message: "volume must be a number ≥ 0" };
  if (value > EDIT_LIMITS.maxVolume)
    return { ok: false, message: `volume exceeds ${EDIT_LIMITS.maxVolume}` };
  return value;
}

function readFrame(value: unknown): ClipFrame | Field {
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

function oneOf<T extends string>(value: unknown, allowed: readonly T[], field: string): T | Field {
  const match = allowed.find((candidate) => candidate === value);
  return match ?? { ok: false, message: `${field} must be one of ${allowed.join(", ")}` };
}

function isField(value: unknown): value is Field {
  return isRecord(value) && "ok" in value;
}

/**
 * Reads the allowed keys of one operation. Every value goes through its reader; the first failure is reported with
 * the field name. Unknown keys are refused so a misspelled option never silently does nothing.
 */
function readOperation(raw: unknown, index: number): ParsedEdit<EditOperation> {
  const at = `operations[${index}]`;
  if (!isRecord(raw)) return invalid(`${at} must be an object`, index);
  const name = oneOf(raw.op, EDIT_OPERATION_NAMES, `${at}.op`);
  if (isField(name)) return invalid(name.ok ? `${at}.op is invalid` : name.message, index);

  const allowedKeys: Record<EditOperationName, readonly string[]> = {
    add_clip: [
      "asset",
      "start",
      "track",
      "duration",
      "mediaStart",
      "volume",
      "muted",
      "fit",
      "frame",
      "fadeIn",
      "fadeOut",
    ],
    add_text: ["text", "start", "duration", "track", "placement", "size", "color"],
    add_component: ["name", "start", "track", "duration"],
    apply_captions: ["preset", "cues", "track"],
    remove_clip: ["clip", "ripple"],
    move_clip: ["clip", "start", "track"],
    trim_clip: ["clip", "start", "end"],
    split_clip: ["clip", "at"],
    set_clip: ["clip", "volume", "muted", "fit", "zIndex", "frame", "fadeIn", "fadeOut"],
    arrange_track: ["track", "clips", "start", "gap"],
    set_composition: ["duration"],
  };
  const unknownKey = Object.keys(raw).find(
    (key) => key !== "op" && !allowedKeys[name].includes(key),
  );
  if (unknownKey) return invalid(`${at}: unknown field "${unknownKey}" for ${name}`, index);

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
  const clipRef = () => need(readString(raw.clip, "clip", EDIT_LIMITS.idChars));
  const time = (key: string, positive = false) => need(readTime(raw[key], key, positive));
  const optTime = (key: string, positive = false) =>
    maybe(key, (value) => readTime(value, key, positive));
  const track = () => need(readTrack(raw.track, "track"));
  const optTrack = () => maybe("track", (value) => readTrack(value, "track"));
  const volume = () => maybe("volume", readVolume);
  const fit = () => maybe("fit", (value) => oneOf(value, CLIP_FITS, "fit"));

  let op: EditOperation | null = null;
  switch (name) {
    case "add_clip": {
      const asset = need(readString(raw.asset, "asset", EDIT_LIMITS.pathChars));
      const start = time("start");
      const onTrack = track();
      const duration = optTime("duration", true);
      const mediaStart = optTime("mediaStart");
      const vol = volume();
      const muted = bool("muted");
      const fitting = fit();
      const frame = maybe("frame", readFrame);
      const fadeIn = optTime("fadeIn");
      const fadeOut = optTime("fadeOut");
      if (asset !== undefined && start !== undefined && onTrack !== undefined)
        op = {
          op: name,
          asset,
          start,
          track: onTrack,
          ...(duration !== undefined && { duration }),
          ...(mediaStart !== undefined && { mediaStart }),
          ...(vol !== undefined && { volume: vol }),
          ...(muted !== undefined && { muted }),
          ...(fitting !== undefined && { fit: fitting }),
          ...(frame !== undefined && { frame }),
          ...(fadeIn !== undefined && { fadeIn }),
          ...(fadeOut !== undefined && { fadeOut }),
        };
      break;
    }
    case "add_text": {
      const text = need(readString(raw.text, "text", EDIT_LIMITS.textChars));
      const start = time("start");
      const duration = time("duration", true);
      const onTrack = track();
      const placement = maybe("placement", (value) => oneOf(value, TEXT_PLACEMENTS, "placement"));
      const size = maybe("size", (value) => oneOf(value, TEXT_SIZES, "size"));
      const color = maybe("color", (value) => {
        const read = readString(value, "color", 40);
        if (isField(read)) return read;
        return /^#[0-9a-fA-F]{3,8}$|^[a-zA-Z]{3,20}$/.test(read)
          ? read
          : { ok: false, message: "color must be a hex color or a CSS color name" };
      });
      if (
        text !== undefined &&
        start !== undefined &&
        duration !== undefined &&
        onTrack !== undefined
      )
        op = {
          op: name,
          text,
          start,
          duration,
          track: onTrack,
          ...(placement !== undefined && { placement }),
          ...(size !== undefined && { size }),
          ...(color !== undefined && { color }),
        };
      break;
    }
    case "add_component": {
      const component = need(readString(raw.name, "name", EDIT_LIMITS.idChars));
      const start = time("start");
      const onTrack = track();
      const duration = optTime("duration", true);
      if (component !== undefined && start !== undefined && onTrack !== undefined)
        op = {
          op: name,
          name: component,
          start,
          track: onTrack,
          ...(duration !== undefined && { duration }),
        };
      break;
    }
    case "apply_captions": {
      const preset = need(readString(raw.preset, "preset", EDIT_LIMITS.idChars));
      const onTrack = optTrack();
      const cues: CaptionCue[] = [];
      if (!Array.isArray(raw.cues) || raw.cues.length === 0) {
        failures.push("cues must be a non-empty array");
      } else if (raw.cues.length > EDIT_LIMITS.captionCues) {
        failures.push(`cues exceeds ${EDIT_LIMITS.captionCues} entries`);
      } else {
        raw.cues.forEach((cue, cueIndex) => {
          const label = `cues[${cueIndex}]`;
          if (!isRecord(cue)) {
            failures.push(`${label} must be an object`);
            return;
          }
          const text = need(readString(cue.text, `${label}.text`, EDIT_LIMITS.textChars));
          const start = need(readTime(cue.start, `${label}.start`));
          const end = need(readTime(cue.end, `${label}.end`, true));
          if (text === undefined || start === undefined || end === undefined) return;
          if (end <= start) failures.push(`${label}.end must be after its start`);
          else cues.push({ text, start, end });
        });
      }
      if (preset !== undefined && failures.length === 0)
        op = { op: name, preset, cues, ...(onTrack !== undefined && { track: onTrack }) };
      break;
    }
    case "remove_clip": {
      const clip = clipRef();
      const ripple = bool("ripple");
      if (clip !== undefined) op = { op: name, clip, ...(ripple !== undefined && { ripple }) };
      break;
    }
    case "move_clip": {
      const clip = clipRef();
      const start = optTime("start");
      const onTrack = optTrack();
      if (raw.start === undefined && raw.track === undefined)
        failures.push("move_clip needs start and/or track");
      if (clip !== undefined)
        op = {
          op: name,
          clip,
          ...(start !== undefined && { start }),
          ...(onTrack !== undefined && { track: onTrack }),
        };
      break;
    }
    case "trim_clip": {
      const clip = clipRef();
      const start = optTime("start");
      const end = optTime("end", true);
      if (raw.start === undefined && raw.end === undefined)
        failures.push("trim_clip needs start and/or end");
      if (start !== undefined && end !== undefined && end <= start)
        failures.push("end must be after start");
      if (clip !== undefined)
        op = {
          op: name,
          clip,
          ...(start !== undefined && { start }),
          ...(end !== undefined && { end }),
        };
      break;
    }
    case "split_clip": {
      const clip = clipRef();
      const at = time("at", true);
      if (clip !== undefined && at !== undefined) op = { op: name, clip, at };
      break;
    }
    case "set_clip": {
      const clip = clipRef();
      const vol = volume();
      const muted = bool("muted");
      const fitting = fit();
      const frame = maybe("frame", readFrame);
      const fadeIn = optTime("fadeIn");
      const fadeOut = optTime("fadeOut");
      const zIndex = maybe("zIndex", (value) =>
        typeof value === "number" && Number.isInteger(value) && Math.abs(value) <= 100_000
          ? value
          : { ok: false, message: "zIndex must be an integer" },
      );
      if (Object.keys(raw).length <= 2) failures.push("set_clip needs at least one property");
      if (clip !== undefined)
        op = {
          op: name,
          clip,
          ...(vol !== undefined && { volume: vol }),
          ...(muted !== undefined && { muted }),
          ...(fitting !== undefined && { fit: fitting }),
          ...(zIndex !== undefined && { zIndex }),
          ...(frame !== undefined && { frame }),
          ...(fadeIn !== undefined && { fadeIn }),
          ...(fadeOut !== undefined && { fadeOut }),
        };
      break;
    }
    case "arrange_track": {
      const onTrack = track();
      const start = optTime("start");
      const gap = optTime("gap");
      const clips: string[] = [];
      if (!Array.isArray(raw.clips) || raw.clips.length === 0) {
        failures.push("clips must be a non-empty array of clip ids");
      } else if (raw.clips.length > EDIT_LIMITS.arrangeClips) {
        failures.push(`clips exceeds ${EDIT_LIMITS.arrangeClips} entries`);
      } else {
        for (const [clipIndex, clip] of raw.clips.entries()) {
          const id = need(readString(clip, `clips[${clipIndex}]`, EDIT_LIMITS.idChars));
          if (id !== undefined) clips.push(id);
        }
        if (new Set(clips).size !== clips.length) failures.push("clips must not repeat a clip");
      }
      if (onTrack !== undefined && failures.length === 0)
        op = {
          op: name,
          track: onTrack,
          clips,
          ...(start !== undefined && { start }),
          ...(gap !== undefined && { gap }),
        };
      break;
    }
    case "set_composition": {
      const duration = time("duration", true);
      if (duration !== undefined) op = { op: name, duration };
      break;
    }
  }
  if (failures.length > 0) return invalid(`${at} (${name}): ${failures.join("; ")}`, index);
  if (!op) return invalid(`${at} (${name}) is invalid`, index);
  return { ok: true, value: op };
}

/** Validates an editing batch at the boundary; the service still checks clips, assets and presets against the project. */
export function parseApplyEditsRequest(body: unknown): ParsedEdit<ApplyEditsRequest> {
  if (!isRecord(body)) return invalid("body must be a JSON object");
  const unknownKey = Object.keys(body).find(
    (key) => key !== "composition" && key !== "baseVersion" && key !== "operations",
  );
  if (unknownKey) return invalid(`unknown field "${unknownKey}"`);
  let composition: string | undefined;
  if (body.composition !== undefined) {
    const read = readString(body.composition, "composition", EDIT_LIMITS.pathChars);
    if (isField(read)) return invalid(read.ok ? "composition is invalid" : read.message);
    composition = read;
  }
  let baseVersion: string | undefined;
  if (body.baseVersion !== undefined) {
    const read = readString(body.baseVersion, "baseVersion", 200);
    if (isField(read)) return invalid(read.ok ? "baseVersion is invalid" : read.message);
    baseVersion = read;
  }
  if (!Array.isArray(body.operations) || body.operations.length === 0)
    return invalid("operations must be a non-empty array");
  if (body.operations.length > EDIT_LIMITS.operations)
    return invalid(`operations exceeds ${EDIT_LIMITS.operations} entries`);
  const operations: EditOperation[] = [];
  for (const [index, raw] of body.operations.entries()) {
    const parsed = readOperation(raw, index);
    if (!parsed.ok) return parsed;
    operations.push(parsed.value);
  }
  return {
    ok: true,
    value: {
      ...(composition !== undefined && { composition }),
      ...(baseVersion !== undefined && { baseVersion }),
      operations,
    },
  };
}

export function isEditError(value: unknown): value is EditError {
  return (
    isRecord(value) &&
    typeof value.message === "string" &&
    EDIT_ERROR_CODES.some((code) => code === value.code)
  );
}
