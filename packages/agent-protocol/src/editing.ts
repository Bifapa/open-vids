/**
 * OpenVids editing capabilities: the product-level contract between the Studio server's editing service
 * (`/api/projects/:id/editing/*`) and the agent runtime's editing tools. It names timeline concepts (clips, tracks,
 * assets, presets, renders), not Studio or WebMCP internals, so either side can change its implementation freely.
 *
 * Times are seconds on the edited composition's timeline. Clip ids are the clip's stable `data-hf-id`; its DOM `id`
 * is accepted wherever a clip id is expected.
 */

import type { CodedMessageParams } from "./types.js";
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

/**
 * Where a clip came from, stamped by agent operations (`data-ov-story-node`, `data-ov-cut`, `data-ov-turn`) and read
 * back from the markup. A manual Studio edit keeps the attributes; a clip without any has no provenance (null).
 */
export interface ClipProvenance {
  /** Story node the clip was built for (Build Story). */
  storyNode: string | null;
  /** Cut plan the clip was built from (build_rough_cut). */
  cut: string | null;
  /** Agent turn that created the clip. */
  turn: string | null;
}

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
  /**
   * The blank project template's placeholder clip, still untouched. Not user content: it may be removed or replaced,
   * and Build Story / build_rough_cut remove it. Present only when true.
   */
  placeholder?: boolean;
  provenance: ClipProvenance | null;
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
      /** Video/image: position and size; default: a video fills the frame (scaled to fit), an image keeps its size (scaled down to fit), centred. */
      frame?: ClipFrame;
      /** Audio/video: linear gain ramps (seconds) at the clip's start and end. */
      fadeIn?: number;
      fadeOut?: number;
      provenance?: Partial<ClipProvenance>;
    }
  /**
   * Place several ranges of one video/audio source back to back on a track (a rough cut). Each range becomes one
   * clip whose media in-point is `from` and whose length is `to − from`; the clips start at `start` and follow each
   * other without gaps, in the given order.
   */
  | {
      op: "add_sequence";
      /** Video or audio asset. */
      asset: string;
      track: number;
      /** Timeline position of the first range (default 0). */
      start?: number;
      /** Source in/out points in seconds, played back to back in this order. */
      ranges: Array<{ from: number; to: number }>;
      volume?: number;
      muted?: boolean;
      fit?: ClipFit;
      /** Video: position and size; default fills the frame (scaled to fit). */
      frame?: ClipFrame;
      /** Short audio gain ramp (seconds, 0–0.1) at both edges of every clip, against clicks at cuts. */
      edgeFade?: number;
      provenance?: Partial<ClipProvenance>;
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
      provenance?: Partial<ClipProvenance>;
    }
  /** Install a registry block/component (motion graphics) and mount it as a sub-composition clip. */
  | {
      op: "add_component";
      name: string;
      start: number;
      track: number;
      duration?: number;
      provenance?: Partial<ClipProvenance>;
    }
  /** Write the project's captions from cues in a caption preset's style, spanning the whole composition. */
  | { op: "apply_captions"; preset: string; cues: CaptionCue[]; track?: number }
  /** Remove one clip (`clip`) or many at once (`clips`); exactly one of the two. */
  | { op: "remove_clip"; clip?: string; clips?: string[]; ripple?: boolean }
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
  "add_sequence",
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
  /**
   * The agent turn making the edit (set by the runtime, never by a model): clips the batch changes get a
   * `data-ov-ai-edit` stamp and clips it adds default to that turn's provenance, so Story sync can tell a later AI
   * edit of generated material from a manual one.
   */
  turnId?: string;
  operations: EditOperation[];
}

export interface EditOperationResult {
  op: EditOperationName;
  /** The clip the operation created or changed (add_sequence: the first created clip). */
  clipId: string | null;
  /** split_clip: the new second half. */
  newClipId: string | null;
  /** add_sequence: every created clip, in timeline order; remove_clip with `clips`: every removed clip. */
  clipIds?: string[];
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
  /** Placeholder values for `errors.<code>`, when the message interpolates any. */
  params?: CodedMessageParams;
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
  /** Clips removed by one `remove_clip` with `clips`. */
  removeClips: 1_000,
  /** Ranges in one `add_sequence`. */
  sequenceRanges: 1_000,
  /** Longest `edgeFade` of `add_sequence`, in seconds. */
  maxEdgeFade: 0.1,
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

const PROVENANCE_KEYS = ["storyNode", "cut", "turn"] as const;
const PROVENANCE_ID = /^[A-Za-z0-9_.:-]{1,200}$/;

/** `provenance` of an add operation: any of the three ids, each a plain token that is safe to write as an attribute. */
function readProvenance(value: unknown): Partial<ClipProvenance> | Field {
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
      "provenance",
    ],
    add_sequence: [
      "asset",
      "track",
      "start",
      "ranges",
      "volume",
      "muted",
      "fit",
      "frame",
      "edgeFade",
      "provenance",
    ],
    add_text: ["text", "start", "duration", "track", "placement", "size", "color", "provenance"],
    add_component: ["name", "start", "track", "duration", "provenance"],
    apply_captions: ["preset", "cues", "track"],
    remove_clip: ["clip", "clips", "ripple"],
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
  const provenance = () => maybe("provenance", readProvenance);

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
      const stamp = provenance();
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
          ...(stamp !== undefined && { provenance: stamp }),
        };
      break;
    }
    case "add_sequence": {
      const asset = need(readString(raw.asset, "asset", EDIT_LIMITS.pathChars));
      const onTrack = track();
      const start = optTime("start");
      const vol = volume();
      const muted = bool("muted");
      const fitting = fit();
      const frame = maybe("frame", readFrame);
      const stamp = provenance();
      const edgeFade = maybe("edgeFade", (value) =>
        typeof value === "number" &&
        Number.isFinite(value) &&
        value >= 0 &&
        value <= EDIT_LIMITS.maxEdgeFade
          ? value
          : { ok: false, message: `edgeFade must be between 0 and ${EDIT_LIMITS.maxEdgeFade}` },
      );
      const ranges: Array<{ from: number; to: number }> = [];
      if (!Array.isArray(raw.ranges) || raw.ranges.length === 0) {
        failures.push("ranges must be a non-empty array of {from, to}");
      } else if (raw.ranges.length > EDIT_LIMITS.sequenceRanges) {
        failures.push(`ranges exceeds ${EDIT_LIMITS.sequenceRanges} entries`);
      } else {
        for (const [rangeIndex, range] of raw.ranges.entries()) {
          const label = `ranges[${rangeIndex}]`;
          if (!isRecord(range)) {
            failures.push(`${label} must be an object {from, to}`);
            break;
          }
          const extra = Object.keys(range).find((key) => key !== "from" && key !== "to");
          if (extra) {
            failures.push(`${label}: unknown field "${extra}"`);
            break;
          }
          const from = need(readTime(range.from, `${label}.from`));
          const to = need(readTime(range.to, `${label}.to`, true));
          if (from === undefined || to === undefined) break;
          if (to <= from) {
            failures.push(`${label}.to must be after its from`);
            break;
          }
          ranges.push({ from, to });
        }
      }
      if (asset !== undefined && onTrack !== undefined && failures.length === 0)
        op = {
          op: name,
          asset,
          track: onTrack,
          ranges,
          ...(start !== undefined && { start }),
          ...(vol !== undefined && { volume: vol }),
          ...(muted !== undefined && { muted }),
          ...(fitting !== undefined && { fit: fitting }),
          ...(frame !== undefined && { frame }),
          ...(edgeFade !== undefined && { edgeFade }),
          ...(stamp !== undefined && { provenance: stamp }),
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
      const stamp = provenance();
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
          ...(stamp !== undefined && { provenance: stamp }),
        };
      break;
    }
    case "add_component": {
      const component = need(readString(raw.name, "name", EDIT_LIMITS.idChars));
      const start = time("start");
      const onTrack = track();
      const duration = optTime("duration", true);
      const stamp = provenance();
      if (component !== undefined && start !== undefined && onTrack !== undefined)
        op = {
          op: name,
          name: component,
          start,
          track: onTrack,
          ...(duration !== undefined && { duration }),
          ...(stamp !== undefined && { provenance: stamp }),
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
      const ripple = bool("ripple");
      const clips: string[] = [];
      if ((raw.clip === undefined) === (raw.clips === undefined)) {
        failures.push("remove_clip needs exactly one of clip or clips");
      } else if (raw.clips !== undefined) {
        if (!Array.isArray(raw.clips) || raw.clips.length === 0) {
          failures.push("clips must be a non-empty array of clip ids");
        } else if (raw.clips.length > EDIT_LIMITS.removeClips) {
          failures.push(`clips exceeds ${EDIT_LIMITS.removeClips} entries`);
        } else {
          for (const [clipIndex, clip] of raw.clips.entries()) {
            const id = need(readString(clip, `clips[${clipIndex}]`, EDIT_LIMITS.idChars));
            if (id !== undefined) clips.push(id);
          }
          if (new Set(clips).size !== clips.length) failures.push("clips must not repeat a clip");
        }
      }
      const clip = raw.clip === undefined ? undefined : clipRef();
      if (failures.length === 0 && (clip !== undefined || raw.clips !== undefined))
        op = {
          op: name,
          ...(clip !== undefined && { clip }),
          ...(raw.clips !== undefined && { clips }),
          ...(ripple !== undefined && { ripple }),
        };
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
    (key) =>
      key !== "composition" && key !== "baseVersion" && key !== "operations" && key !== "turnId",
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
  let turnId: string | undefined;
  if (body.turnId !== undefined) {
    if (typeof body.turnId !== "string" || !PROVENANCE_ID.test(body.turnId))
      return invalid("turnId must be an id (letters, digits, _ . : -)");
    turnId = body.turnId;
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
      ...(turnId !== undefined && { turnId }),
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
