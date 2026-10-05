import type {
  CompositionFramesRequest,
  CompositionFramesResponse,
} from "@hyperframes/agent-protocol";
import { FramesError, type FramesHost } from "../editing/frames.js";
import { FAKE_JPEG } from "./analysis.js";

/**
 * Deterministic in-memory frames host: every time is "captured" (a request past the end shows `duration - 0.04`),
 * times listed in `cachedTimes` are answered as cached, and `nextError` fails the next call once.
 */
export class FakeFramesHost implements FramesHost {
  readonly requests: CompositionFramesRequest[] = [];
  readonly signals: AbortSignal[] = [];
  readonly cachedTimes = new Set<number>();
  duration = 10;
  nextError: FramesError | null = null;

  async frames(
    request: CompositionFramesRequest,
    signal: AbortSignal,
  ): Promise<CompositionFramesResponse> {
    this.requests.push(request);
    this.signals.push(signal);
    if (this.nextError) {
      const error = this.nextError;
      this.nextError = null;
      throw error;
    }
    const width = request.width ?? 640;
    return {
      composition: request.composition ?? "index.html",
      duration: this.duration,
      frames: request.times.map((time) => ({
        time,
        capturedAt: time >= this.duration ? this.duration - 0.04 : time,
        mimeType: "image/jpeg",
        data: FAKE_JPEG,
        width,
        height: Math.round((width * 9) / 16),
        cached: this.cachedTimes.has(time),
      })),
    };
  }
}
