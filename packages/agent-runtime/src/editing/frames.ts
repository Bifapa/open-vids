import type {
  CompositionFramesRequest,
  CompositionFramesResponse,
  EditErrorCode,
} from "@hyperframes/agent-protocol";
import type { HostToolResult } from "../backend.js";

/**
 * Frames of the project's compositions as the preview shows them, without rendering a video: Studio's editing service
 * (`POST /api/projects/:id/editing/frames`) seeks the composition in headless Chrome. A host is bound to one project
 * and every call is cancellable through its signal (the capture stops with it).
 */
export interface FramesHost {
  frames(
    request: CompositionFramesRequest,
    signal: AbortSignal,
  ): Promise<CompositionFramesResponse>;
}

export type FramesErrorCode = EditErrorCode | "unavailable" | "aborted";

/** A frames failure the model can act on: a stable code and a message. */
export class FramesError extends Error {
  readonly code: FramesErrorCode;

  constructor(code: FramesErrorCode, message: string) {
    super(message);
    this.name = "FramesError";
    this.code = code;
  }
}

const seconds = (value: number) => String(Math.round(value * 100) / 100);

/** What the model reads next to the attached images: which second each one shows and where it differs from the ask. */
export function formatCompositionFrames(response: CompositionFramesResponse): string {
  const rows = response.frames.map((frame, index) => {
    const notes: string[] = [];
    if (frame.capturedAt !== frame.time) {
      notes.push(
        `the composition ends at ${seconds(response.duration)} s: this is its last readable frame`,
      );
    }
    if (frame.cached) notes.push("cached");
    return `${index + 1}. ${seconds(frame.time)} s${notes.length > 0 ? ` — ${notes.join("; ")}` : ""}`;
  });
  return [
    `${response.frames.length} ${response.frames.length === 1 ? "frame" : "frames"} of ${response.composition} (${seconds(response.duration)} s long), attached in this order:`,
    ...rows,
    "These are previews of the composition as it is on disk now (video, text, graphics, captions), without audio.",
  ].join("\n");
}

/** The images of a response in the shape a tool result carries them. */
export function compositionFrameImages(
  response: CompositionFramesResponse,
): NonNullable<HostToolResult["images"]> {
  return response.frames.map((frame) => ({ mimeType: frame.mimeType, data: frame.data }));
}
