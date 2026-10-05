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
  /**
   * Inventory only (video/audio): the fragment the user picked for the AI to use (see {@link AssetRange}). Absent
   * when the whole file may be used.
   */
  range?: AssetRange;
}

/**
 * The part of a video/audio asset the user picked for the AI to use, in source seconds (`0 ≤ start < end ≤ length`,
 * at least {@link ASSET_RANGE_MIN_SECONDS} long). Every editing-service placement of the asset — agent edits, Build
 * Story, rough cuts — stays inside it and defaults to it; manual Studio edits are not restricted. Stored per project
 * in {@link ASSET_RANGES_PATH}, keyed by project-relative asset path.
 */
export interface AssetRange {
  start: number;
  end: number;
}

export const ASSET_RANGES_PATH = ".hyperframes/media/ranges.json";
export const ASSET_RANGES_SCHEMA = 1;
export const ASSET_RANGE_MIN_SECONDS = 0.1;

/** `ranges.json` on disk and the answer of `GET`/`PUT /api/projects/:id/editing/ranges`: asset path → range. */
export interface AssetRangesView {
  ranges: Record<string, AssetRange>;
}

/** `PUT /api/projects/:id/editing/ranges`: pick a fragment of one asset, or `range: null` to use the whole file. */
export interface SetAssetRangeRequest {
  path: string;
  range: AssetRange | null;
}

export function isAssetRange(value: unknown): value is AssetRange {
  return (
    isRecord(value) &&
    typeof value.start === "number" &&
    typeof value.end === "number" &&
    Number.isFinite(value.start) &&
    Number.isFinite(value.end) &&
    value.start >= 0 &&
    value.end - value.start >= ASSET_RANGE_MIN_SECONDS - 1e-6
  );
}

export function isAssetRangesView(value: unknown): value is AssetRangesView {
  return (
    isRecord(value) && isRecord(value.ranges) && Object.values(value.ranges).every(isAssetRange)
  );
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
  /** Playback rate when it is not 1 (`data-playback-rate`). */
  playbackRate?: number;
  /** Opacity when below 1 (inline style). */
  opacity?: number;
  /** Colour grade: the preset name, or "custom" for hand-set values; absent without one. */
  colorGrade?: string;
  /** Number of effects in the clip's audio FX chain, when it has one. */
  audioFx?: number;
  /** Targets of the clip's automation lanes (`volume`, `rate`, `fx.<node>.<param>`). */
  automation?: string[];
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
  /**
   * Remove one clip (`clip`) or many at once (`clips`); exactly one of the two. `ripple` closes the gap: later clips
   * on the clip's own track move back (`rippleScope` "track", the default) or later clips on every track do ("all").
   */
  | {
      op: "remove_clip";
      clip?: string;
      clips?: string[];
      ripple?: boolean;
      rippleScope?: RippleScope;
    }
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
      /** Visual clips: 0 (invisible) to 1 (opaque). */
      opacity?: number;
    }
  /** Lay the clips end to end on `track` in the given order, starting at `start` (default 0). */
  | { op: "arrange_track"; track: number; clips: string[]; start?: number; gap?: number }
  /** Explicit composition length; without it the length follows the content after every batch. */
  | { op: "set_composition"; duration: number }
  /**
   * Resize the composition's canvas (frame): the root's `data-width`/`data-height`, the inline stage CSS and the
   * viewport meta. Even pixels, up to {@link EDIT_LIMITS.maxCanvasPixels} — the render encodes H.264. `fit` decides
   * what happens to the clips already placed: "keep" (default) leaves their frames, "contain" scales and centres
   * the old picture inside the new canvas (everything stays visible), "cover" scales it to fill the new canvas.
   */
  | { op: "set_canvas"; width: number; height: number; fit?: CanvasFit }
  /**
   * Change a video/audio clip's playback rate (`data-playback-rate`, 0.1–10). By default the clip keeps the same
   * stretch of source, so its timeline length shrinks or grows (2 → half as long); `keepDuration` keeps the length
   * instead, as Studio's speed slider does (the clip then plays more or less of the source). `ripple` moves later
   * clips by the length difference.
   */
  | {
      op: "set_speed";
      clip: string;
      rate: number;
      keepDuration?: boolean;
      ripple?: boolean;
      rippleScope?: RippleScope;
    }
  /**
   * Shift and/or stretch the cues of the composition's existing captions: a cue starting inside [from, to) moves to
   * `from + (t − from) × scale + shift`. Without from/to every cue changes.
   */
  | { op: "retime_captions"; shift?: number; scale?: number; from?: number; to?: number }
  /**
   * Write the composition's captions from the cached transcripts of the clips on the timeline: the words each clip
   * plays (its in-point, length and speed taken into account) become cues in a caption preset's style.
   */
  | {
      op: "captions_from_transcript";
      preset: string;
      track?: number;
      /** Only these clips; default: every video/audio clip with a cached transcript. */
      clips?: string[];
      /** Longest cue in words (default 6). */
      maxWords?: number;
    }
  /** Mount an existing composition file of the project as a clip, the way a Studio drop does. */
  | {
      op: "mount_composition";
      composition: string;
      start: number;
      track: number;
      duration?: number;
      provenance?: Partial<ClipProvenance>;
    }
  /** Colour-grade a video/image clip (`data-color-grading`): a preset and/or tonal adjustments, or clear it. */
  | {
      op: "set_color_grade";
      clip: string;
      preset?: string;
      intensity?: number;
      adjust?: ColorAdjust;
      clear?: boolean;
    }
  /** Audio effects of a video/audio clip (`data-fx-chain`): apply a named preset, or clear the chain. */
  | { op: "set_audio_fx"; clip: string; preset?: string; replace?: boolean; clear?: boolean }
  /** The volume envelope of a video/audio clip (`data-automation`): breakpoints in clip-local seconds. */
  | {
      op: "set_volume_automation";
      clip: string;
      points?: Array<{ t: number; v: number }>;
      clear?: boolean;
    }
  /**
   * Duck a (music) clip under speech: its volume drops by `reduceDb` while any of the `under` clips (or the clips on
   * `underTrack`) play, with `attack` seconds of ramp down before and `release` seconds of ramp up after.
   */
  | {
      op: "duck_audio";
      clip: string;
      under?: string[];
      underTrack?: number;
      reduceDb?: number;
      attack?: number;
      release?: number;
    }
  /** Lock or unlock clips (`data-timeline-locked`): a locked clip refuses every other edit. */
  | { op: "set_locked"; clips: string[]; locked: boolean };

export const RIPPLE_SCOPES = ["track", "all"] as const;
export type RippleScope = (typeof RIPPLE_SCOPES)[number];

export const CANVAS_FITS = ["keep", "contain", "cover"] as const;
export type CanvasFit = (typeof CANVAS_FITS)[number];

export const COLOR_ADJUST_KEYS = [
  "exposure",
  "contrast",
  "highlights",
  "shadows",
  "whites",
  "blacks",
  "temperature",
  "tint",
  "vibrance",
  "saturation",
] as const;
export type ColorAdjustKey = (typeof COLOR_ADJUST_KEYS)[number];
/** Tonal adjustments: -1…1 each (exposure -2…2), 0 = unchanged. */
export type ColorAdjust = Partial<Record<ColorAdjustKey, number>>;

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
  "set_canvas",
  "set_speed",
  "retime_captions",
  "captions_from_transcript",
  "mount_composition",
  "set_color_grade",
  "set_audio_fx",
  "set_volume_automation",
  "duck_audio",
  "set_locked",
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
  /**
   * Idempotency key (set by the runtime): a batch repeated with an id the service has already applied answers with
   * the stored result instead of applying twice, before any version check.
   */
  requestId?: string;
  /** Run the whole batch in memory and answer what it would do; nothing is written. */
  dryRun?: boolean;
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
  /** Operation-specific note (what a reframe skipped, how many cues a transcript produced, …). */
  note?: string;
}

export interface ApplyEditsResponse {
  timeline: TimelineSnapshot;
  results: EditOperationResult[];
  /** Project-relative files written by the batch (for a dry run: the files it would write). */
  changedFiles: string[];
  /** Things worth a look in the result, such as clips that now overlap on track 0. */
  warnings?: string[];
  /** The batch was only simulated (`dryRun`): `timeline` is how it would look. */
  dryRun?: true;
  /** The request id was applied before: this is the stored answer of that application. */
  replayed?: true;
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
  "aborted",
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

export const PRESET_KINDS = ["caption", "block", "component", "color_grade", "audio_fx"] as const;
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
  operations: 200,
  captionCues: 500,
  /** Cues `captions_from_transcript` may derive for one composition. */
  transcriptCaptionCues: 3_000,
  textChars: 500,
  pathChars: 1_024,
  idChars: 200,
  arrangeClips: 100,
  /** Clips removed by one `remove_clip` with `clips`. */
  removeClips: 1_000,
  /** Clips locked/unlocked by one `set_locked`. */
  lockClips: 1_000,
  /** Clips a `duck_audio` may duck under. */
  duckClips: 500,
  /** Breakpoints in one `set_volume_automation`. */
  automationPoints: 256,
  /** Ranges in one `add_sequence`. */
  sequenceRanges: 1_000,
  /** Longest `edgeFade` of `add_sequence`, in seconds. */
  maxEdgeFade: 0.1,
  maxTime: 24 * 60 * 60,
  maxTrack: 999,
  /** `data-volume` ceiling: +12 dB. */
  maxVolume: 3.98,
  /** Playback rate bounds (`data-playback-rate`). */
  minRate: 0.1,
  maxRate: 10,
  /** Deepest `duck_audio` reduction, in dB. */
  maxDuckDb: 40,
  /** Largest |coordinate| or size of a clip frame, in composition pixels. */
  maxFramePixels: 20_000,
  /** Largest canvas side `set_canvas` accepts, in pixels (even numbers only). */
  maxCanvasPixels: 8_192,
} as const;

export type ParsedEdit<T> = { ok: true; value: T } | { ok: false; error: EditError };

export function isEditError(value: unknown): value is EditError {
  return (
    isRecord(value) &&
    typeof value.message === "string" &&
    EDIT_ERROR_CODES.some((code) => code === value.code)
  );
}
