import { createHash } from "node:crypto";
import {
  STUDIO_HEIGHT_PROP,
  STUDIO_OFFSET_X_PROP,
  STUDIO_OFFSET_Y_PROP,
  STUDIO_WIDTH_PROP,
} from "@hyperframes/core/editing/draft-markers";
import type { ClipKind } from "@hyperframes/agent-protocol";
import type { ClipNode } from "./timeline.js";

/**
 * The properties of a clip that an edit can change, read from its markup as structured values (never its HTML).
 * Story sync records it for every generated clip and compares it later to find manual edits.
 */
export interface ClipState {
  kind: ClipKind;
  start: number;
  duration: number;
  track: number;
  src: string | null;
  compositionSrc: string | null;
  mediaStart: number | null;
  playbackRate: number;
  volume: number | null;
  muted: boolean;
  fadeIn: number;
  fadeOut: number;
  zIndex: number | null;
  /** Position and size in composition pixels when the clip is absolutely placed. */
  frame: { left: number; top: number; width: number; height: number } | null;
  fit: string | null;
  locked: boolean;
  /**
   * Studio canvas edits: the offset, size and rotation properties, the motion marker and the transform channels it
   * writes. Absent (not null) when there are none, so states stored before this field was tracked still compare.
   */
  studio?: Record<string, string>;
}

/** Marks a clip an agent turn changed: `<turn>@<hash of the clip's state without its start>`. */
export const AI_EDIT_ATTRIBUTE = "data-ov-ai-edit";

const round3 = (value: number) => Math.round(value * 1000) / 1000;

function styleValue(style: string, property: string): string | null {
  const match = new RegExp(`(?:^|;)\\s*${property}\\s*:\\s*([^;]+)`, "i").exec(style);
  return match?.[1] ? match[1].trim() : null;
}

function pixels(style: string, property: string): number | null {
  const value = styleValue(style, property);
  if (value === null) return null;
  const match = /^(-?\d+(?:\.\d+)?)px$/i.exec(value);
  return match?.[1] ? round3(Number.parseFloat(match[1])) : null;
}

function numberAttr(element: Element, name: string): number | null {
  const raw = element.getAttribute(name);
  if (raw === null || raw.trim() === "") return null;
  const value = Number.parseFloat(raw);
  return Number.isFinite(value) ? value : null;
}

/** Studio's persisted canvas-edit markers (`manualEditsTypes.ts` in Studio): the attributes it stamps on an element. */
const STUDIO_ATTRIBUTES = [
  "data-hf-studio-path-offset",
  "data-hf-studio-box-size",
  "data-hf-studio-rotation",
  "data-hf-studio-motion",
] as const;

/** The inline style properties a drag, resize, rotation or motion edit leaves on the element. */
const STUDIO_STYLE_PROPERTIES = [
  STUDIO_OFFSET_X_PROP,
  STUDIO_OFFSET_Y_PROP,
  STUDIO_WIDTH_PROP,
  STUDIO_HEIGHT_PROP,
  "--hf-studio-rotation",
  "translate",
  "rotate",
  "scale",
  "transform",
  "opacity",
] as const;

/** What Studio's canvas wrote on the element, in a fixed order; absent when the clip carries none of it. */
function studioEdits(element: Element, style: string): { studio?: Record<string, string> } {
  const found: Record<string, string> = {};
  for (const name of STUDIO_ATTRIBUTES) {
    const value = element.getAttribute(name);
    if (value !== null) found[name] = value;
  }
  for (const property of STUDIO_STYLE_PROPERTIES) {
    const value = styleValue(style, property);
    if (value !== null) found[property] = value;
  }
  return Object.keys(found).length > 0 ? { studio: found } : {};
}

export function clipState(clip: ClipNode): ClipState {
  const { element } = clip;
  const style = element.getAttribute("style") ?? "";
  const isMedia = clip.kind === "video" || clip.kind === "audio";
  const left = pixels(style, "left");
  const top = pixels(style, "top");
  const width = pixels(style, "width");
  const height = pixels(style, "height");
  const zIndex = styleValue(style, "z-index");
  return {
    kind: clip.kind,
    start: round3(clip.start),
    duration: round3(clip.duration),
    track: clip.track,
    src: clip.src,
    compositionSrc: clip.compositionSrc,
    mediaStart: clip.mediaStart === null ? null : round3(clip.mediaStart),
    playbackRate: clip.playbackRate,
    volume: isMedia ? round3(numberAttr(element, "data-volume") ?? 1) : null,
    muted: isMedia && element.hasAttribute("muted"),
    fadeIn: round3(numberAttr(element, "data-fade-in") ?? 0),
    fadeOut: round3(numberAttr(element, "data-fade-out") ?? 0),
    zIndex: zIndex !== null && /^-?\d+$/.test(zIndex) ? Number.parseInt(zIndex, 10) : null,
    frame:
      left !== null && top !== null && width !== null && height !== null
        ? { left, top, width, height }
        : null,
    fit: styleValue(style, "object-fit"),
    locked: clip.locked,
    ...studioEdits(element, style),
  };
}

const EPS = 0.0015;

const FIELD_NAMES: Array<[keyof ClipState, string]> = [
  ["duration", "duration"],
  ["track", "track"],
  ["src", "media"],
  ["compositionSrc", "composition"],
  ["mediaStart", "mediaStart"],
  ["playbackRate", "speed"],
  ["volume", "volume"],
  ["muted", "muted"],
  ["fadeIn", "fades"],
  ["fadeOut", "fades"],
  ["zIndex", "zIndex"],
  ["frame", "frame"],
  ["fit", "fit"],
  ["locked", "locked"],
  ["studio", "canvas"],
];

function same(a: unknown, b: unknown): boolean {
  if (typeof a === "number" && typeof b === "number") return Math.abs(a - b) < EPS;
  if (a && b && typeof a === "object" && typeof b === "object") {
    return JSON.stringify(a) === JSON.stringify(b);
  }
  return a === b;
}

/**
 * What differs between a clip's current state and the state it was generated in, as field names (`start`,
 * `duration`, `mediaStart`, `volume`, …). `shift` is how far the clip's whole section moved since: a clip that moved
 * with its section has not been edited.
 */
export function clipStateChanges(current: ClipState, baseline: ClipState, shift = 0): string[] {
  const changes: string[] = [];
  if (!same(current.start - shift, baseline.start)) changes.push("start");
  for (const [key, name] of FIELD_NAMES) {
    if (!same(current[key], baseline[key]) && !changes.includes(name)) changes.push(name);
  }
  return changes;
}

/** A position-independent fingerprint of a clip's state (moving a section as a whole keeps it). */
export function clipStateHash(state: ClipState): string {
  const { start: _start, ...rest } = state;
  return createHash("sha256").update(JSON.stringify(rest)).digest("hex").slice(0, 16);
}

export function aiEditStamp(turn: string, state: ClipState): string {
  return `${turn}@${clipStateHash(state)}`;
}

/** The agent turn whose edit left the clip in exactly its current state, or null (no stamp, or edited since). */
export function aiEditTurn(clip: ClipNode, state: ClipState): string | null {
  const stamp = clip.element.getAttribute(AI_EDIT_ATTRIBUTE);
  if (!stamp) return null;
  const at = stamp.lastIndexOf("@");
  if (at <= 0) return null;
  return stamp.slice(at + 1) === clipStateHash(state) ? stamp.slice(0, at) : null;
}
