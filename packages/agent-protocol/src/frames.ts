import { EDIT_LIMITS, type EditError } from "./editing.js";
import { isRecord } from "./validate.js";

/**
 * Frames of a composition as the preview shows it, without rendering a video: the editing service seeks the
 * composition in headless Chrome and returns JPEGs.
 *
 *   POST …/editing/frames            CompositionFramesRequest → CompositionFramesResponse (or `{ error: EditError }`)
 *
 * Times are seconds on the composition timeline.
 */

export const COMPOSITION_FRAME_LIMITS = {
  /** Most frames of one request. */
  times: 12,
  defaultWidth: 640,
  minWidth: 160,
  maxWidth: 1280,
} as const;

export interface CompositionFramesRequest {
  /** Project-relative composition; the project's main composition when absent. */
  composition?: string;
  /** Distinct seconds to capture (1–12). A time at or past the end shows the last readable frame. */
  times: number[];
  /** Output width in pixels (default 640); the height follows the composition's aspect ratio. */
  width?: number;
}

export interface CompositionFrame {
  /** The requested second. */
  time: number;
  /** The second that was actually captured (a request past the end is taken just before it). */
  capturedAt: number;
  mimeType: "image/jpeg";
  /** Base64 JPEG. */
  data: string;
  width: number;
  height: number;
  /** Served from the cache: the composition and the time are unchanged since it was captured. */
  cached: boolean;
}

export interface CompositionFramesResponse {
  /** The composition that was captured, project-relative. */
  composition: string;
  /** Its length in seconds. */
  duration: number;
  /** In the order of the request's times. */
  frames: CompositionFrame[];
}

export type ParsedCompositionFrames =
  | { ok: true; value: CompositionFramesRequest }
  | { ok: false; error: EditError };

function invalid(message: string): ParsedCompositionFrames {
  return { ok: false, error: { code: "invalid_request", message } };
}

/** Validates `POST /editing/frames`. Duplicate times are collapsed (first occurrence wins). */
export function parseCompositionFramesRequest(body: unknown): ParsedCompositionFrames {
  if (!isRecord(body)) return invalid("body must be a JSON object");
  const unknownKey = Object.keys(body).find(
    (key) => key !== "composition" && key !== "times" && key !== "width",
  );
  if (unknownKey) return invalid(`unknown field "${unknownKey}"`);

  const { composition, times, width } = body;
  if (
    composition !== undefined &&
    (typeof composition !== "string" ||
      composition.trim() === "" ||
      composition.length > EDIT_LIMITS.pathChars)
  ) {
    return invalid("composition must be a project-relative path");
  }
  if (
    !Array.isArray(times) ||
    times.length === 0 ||
    times.length > COMPOSITION_FRAME_LIMITS.times
  ) {
    return invalid(`times must list 1 to ${COMPOSITION_FRAME_LIMITS.times} seconds`);
  }
  const seconds: number[] = [];
  for (const entry of times) {
    if (
      typeof entry !== "number" ||
      !Number.isFinite(entry) ||
      entry < 0 ||
      entry > EDIT_LIMITS.maxTime
    ) {
      return invalid(`every time must be a number from 0 to ${EDIT_LIMITS.maxTime} seconds`);
    }
    const rounded = Math.round(entry * 1000) / 1000;
    if (!seconds.includes(rounded)) seconds.push(rounded);
  }
  if (
    width !== undefined &&
    (typeof width !== "number" ||
      !Number.isInteger(width) ||
      width < COMPOSITION_FRAME_LIMITS.minWidth ||
      width > COMPOSITION_FRAME_LIMITS.maxWidth)
  ) {
    return invalid(
      `width must be an integer from ${COMPOSITION_FRAME_LIMITS.minWidth} to ${COMPOSITION_FRAME_LIMITS.maxWidth}`,
    );
  }
  return {
    ok: true,
    value: {
      ...(composition !== undefined && { composition }),
      times: seconds,
      ...(width !== undefined && { width }),
    },
  };
}

export function isCompositionFramesResponse(value: unknown): value is CompositionFramesResponse {
  return (
    isRecord(value) &&
    typeof value.composition === "string" &&
    typeof value.duration === "number" &&
    Array.isArray(value.frames) &&
    value.frames.every(
      (frame) =>
        isRecord(frame) &&
        typeof frame.time === "number" &&
        typeof frame.capturedAt === "number" &&
        frame.mimeType === "image/jpeg" &&
        typeof frame.data === "string" &&
        typeof frame.width === "number" &&
        typeof frame.height === "number" &&
        typeof frame.cached === "boolean",
    )
  );
}
