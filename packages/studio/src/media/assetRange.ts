/**
 * The "fragment for AI" of a video/audio asset: the in/out points (source seconds) the user picked, and the pure maths
 * the range editor and the timeline drop run on. A stored range of the whole file is never kept: it means "no range".
 */

import { ASSET_RANGE_MIN_SECONDS, type AssetRange } from "@hyperframes/agent-protocol";

/** A handle's arrow-key step, and the Shift step. */
export const RANGE_NUDGE_SECONDS = 0.1;
export const RANGE_NUDGE_LARGE_SECONDS = 1;

/** Closer than this to the file's edge counts as the edge. */
const EDGE_EPSILON = 0.005;

const MILLI = 1000;
const roundMilli = (value: number) => Math.round(value * MILLI) / MILLI;
const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

const pad2 = (value: number) => String(value).padStart(2, "0");

/** `m:ss.s` (`h:mm:ss.s` from an hour), rounded to a tenth of a second. */
export function formatRangeTime(seconds: number): string {
  const tenths = Math.max(0, Math.round((Number.isFinite(seconds) ? seconds : 0) * 10));
  const whole = Math.floor(tenths / 10);
  const fraction = tenths % 10;
  const h = Math.floor(whole / 3600);
  const m = Math.floor(whole / 60) % 60;
  const s = whole % 60;
  return h > 0 ? `${h}:${pad2(m)}:${pad2(s)}.${fraction}` : `${m}:${pad2(s)}.${fraction}`;
}

/** `m:ss` (`h:mm:ss`) to the nearest second: a badge, not an editor. */
export function formatRangeClock(seconds: number): string {
  const total = Math.max(0, Math.round(Number.isFinite(seconds) ? seconds : 0));
  const h = Math.floor(total / 3600);
  const m = Math.floor(total / 60) % 60;
  const s = total % 60;
  return h > 0 ? `${h}:${pad2(m)}:${pad2(s)}` : `${m}:${pad2(s)}`;
}

/** `0:42–1:15`. */
export function formatRangeLabel(range: AssetRange): string {
  return `${formatRangeClock(range.start)}–${formatRangeClock(range.end)}`;
}

const TIME_PATTERN = /^\d+(?:[.,]\d+)?$/;
const WHOLE_PATTERN = /^\d+$/;

/**
 * Seconds from what a person types: `75`, `75.5`, `1:15`, `1:15.5`, `01:15,50`, `1:02:03.4`. Null for anything else
 * (empty, negative, letters, minutes or seconds out of range after a colon).
 */
export function parseRangeTime(text: string): number | null {
  const parts = text.trim().split(":");
  if (parts.length > 3 || parts.some((part) => part === "")) return null;
  const secondsPart = parts[parts.length - 1] ?? "";
  if (!TIME_PATTERN.test(secondsPart)) return null;
  const leading = parts.slice(0, -1);
  if (!leading.every((part) => WHOLE_PATTERN.test(part))) return null;
  const seconds = Number(secondsPart.replace(",", "."));
  if (leading.length > 0 && seconds >= 60) return null;
  const [hours, minutes] = leading.length === 2 ? leading : [0, ...leading];
  if (leading.length === 2 && Number(minutes) >= 60) return null;
  const total = Number(hours) * 3600 + Number(minutes ?? 0) * 60 + seconds;
  return Number.isFinite(total) ? roundMilli(total) : null;
}

export function wholeFileRange(duration: number): AssetRange {
  return { start: 0, end: duration };
}

/** The range spans the file (to within a few milliseconds). */
export function isWholeFile(range: AssetRange, duration: number): boolean {
  return range.start <= EDGE_EPSILON && range.end >= duration - EDGE_EPSILON;
}

/**
 * A range as it applies to a file of `duration` seconds: clamped into the file; null when nothing usable is left
 * (shorter than the minimum, the file got shorter than the range).
 */
export function clampRangeToFile(range: AssetRange, duration: number): AssetRange | null {
  const start = clamp(range.start, 0, duration);
  const end = clamp(range.end, 0, duration);
  if (end - start < ASSET_RANGE_MIN_SECONDS - 1e-6) return null;
  return { start: roundMilli(start), end: roundMilli(end) };
}

/**
 * What to store for an edited range: null (use the whole file) when it spans the file or nothing usable is left,
 * else the clamped range.
 */
export function storedRange(range: AssetRange, duration: number): AssetRange | null {
  const clamped = clampRangeToFile(range, duration);
  return !clamped || isWholeFile(clamped, duration) ? null : clamped;
}

/** The range a stored pick leaves in effect on a file of `duration` seconds (null duration: kept as is). */
export function effectivePick(range: AssetRange | null | undefined, duration: number | null) {
  if (!range) return null;
  if (duration === null || !(duration > 0)) return range;
  const clamped = clampRangeToFile(range, duration);
  return clamped && !isWholeFile(clamped, duration) ? clamped : null;
}

export function sameRange(a: AssetRange | null | undefined, b: AssetRange | null | undefined) {
  if (!a || !b) return !a && !b;
  return Math.abs(a.start - b.start) < 1e-6 && Math.abs(a.end - b.end) < 1e-6;
}

/** Moves the in point; it stays inside the file and at least the minimum before the out point. */
export function moveStart(range: AssetRange, value: number, duration: number): AssetRange {
  const end = clamp(range.end, 0, duration);
  const start = clamp(value, 0, Math.max(0, end - ASSET_RANGE_MIN_SECONDS));
  return { start: roundMilli(start), end };
}

/** Moves the out point; it stays inside the file and at least the minimum after the in point. */
export function moveEnd(range: AssetRange, value: number, duration: number): AssetRange {
  const start = clamp(range.start, 0, duration);
  const end = clamp(value, Math.min(duration, start + ASSET_RANGE_MIN_SECONDS), duration);
  return { start, end: roundMilli(end) };
}

/** Slides the whole range, keeping its length; it stops at the file's edges. */
export function shiftRange(range: AssetRange, delta: number, duration: number): AssetRange {
  const length = range.end - range.start;
  const start = clamp(range.start + delta, 0, Math.max(0, duration - length));
  return { start: roundMilli(start), end: roundMilli(start + length) };
}

export type RangeHandle = "start" | "end";
export type RangeDragMode = RangeHandle | "move";

/** The range a drag that began on `origin` and has moved `delta` seconds shows. */
export function dragRange(
  mode: RangeDragMode,
  origin: AssetRange,
  delta: number,
  duration: number,
): AssetRange {
  if (mode === "start") return moveStart(origin, origin.start + delta, duration);
  if (mode === "end") return moveEnd(origin, origin.end + delta, duration);
  return shiftRange(origin, delta, duration);
}

/** One arrow-key step of a handle: 0.1 s, a second with Shift. */
export function nudgeHandle(
  handle: RangeHandle,
  range: AssetRange,
  direction: 1 | -1,
  large: boolean,
  duration: number,
): AssetRange {
  const step = direction * (large ? RANGE_NUDGE_LARGE_SECONDS : RANGE_NUDGE_SECONDS);
  return handle === "start"
    ? moveStart(range, range.start + step, duration)
    : moveEnd(range, range.end + step, duration);
}

/** Seconds under a pointer at `clientX` over a strip that starts at `left` and is `width` px wide. */
export function timeAtPointer(clientX: number, left: number, width: number, duration: number) {
  if (!(width > 0)) return 0;
  return roundMilli(clamp((clientX - left) / width, 0, 1) * duration);
}

/** Where a time sits along the strip, as a CSS percentage. */
export function percentAt(seconds: number, duration: number): string {
  return `${duration > 0 ? clamp(seconds / duration, 0, 1) * 100 : 0}%`;
}
