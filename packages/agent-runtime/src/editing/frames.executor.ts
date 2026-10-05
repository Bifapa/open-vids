import { isRecord, parseCompositionFramesRequest } from "@hyperframes/agent-protocol";
import type { HostToolResult } from "../backend.js";
import {
  compositionFrameImages,
  formatCompositionFrames,
  FramesError,
  type FramesHost,
} from "./frames.js";
import { isFramesToolName } from "./frames.tools.js";

export interface TurnFramesOptions {
  host: FramesHost;
  /** The turn's abort signal: aborting the turn stops a running capture. */
  turnSignal: AbortSignal;
  /**
   * Most frames this turn may have captured (the turn's Execution Quality `analysisFramesPerSource`, reused as the
   * per-turn composition frame budget); frames served from the cache do not count. Absent = no cap.
   */
  frameBudget?: number;
}

const refuse = (text: string): HostToolResult => ({ text, isError: true });

/** Models send `null` for arguments they leave out. */
function withoutNulls(args: unknown): unknown {
  if (!isRecord(args)) return args;
  return Object.fromEntries(Object.entries(args).filter(([, value]) => value !== null));
}

/**
 * The composition-frame tool of one running turn, bound to that turn's project and abort signal. Like the other turn
 * executors it tracks its in-flight calls so {@link shutdown} ends a running capture before the checkpoint closes, and
 * accepts no call afterwards.
 */
export class TurnFrames {
  private accepting = true;
  private readonly stop = new AbortController();
  private readonly inflight = new Set<Promise<unknown>>();
  /** Frames this turn has asked Studio to capture and that were not cached (including calls still running). */
  private used = 0;

  constructor(private readonly options: TurnFramesOptions) {}

  execute(name: string, args: unknown, callSignal: AbortSignal): Promise<HostToolResult> {
    if (!this.accepting)
      return Promise.resolve(refuse("The turn is finishing; frames are closed."));
    if (!isFramesToolName(name)) return Promise.resolve(refuse(`Unknown frames tool ${name}.`));
    const signal = AbortSignal.any([callSignal, this.options.turnSignal, this.stop.signal]);
    const call = this.look(args, signal).catch((error: unknown): HostToolResult => {
      if (error instanceof FramesError) {
        return refuse(error.code === "aborted" ? error.message : `${error.code}: ${error.message}`);
      }
      const reason = error instanceof Error ? error.message : String(error);
      return refuse(`internal: ${reason}`);
    });
    this.inflight.add(call);
    void call.finally(() => this.inflight.delete(call));
    return call;
  }

  /** Stops accepting calls, aborts a running capture and waits for every started call to end. */
  async shutdown(): Promise<void> {
    this.accepting = false;
    this.stop.abort();
    await Promise.allSettled([...this.inflight]);
  }

  private async look(args: unknown, signal: AbortSignal): Promise<HostToolResult> {
    const parsed = parseCompositionFramesRequest(withoutNulls(args));
    if (!parsed.ok) return refuse(`${parsed.error.code}: ${parsed.error.message}`);
    const request = parsed.value;
    const cap = this.options.frameBudget;
    const asked = request.times.length;
    if (cap !== undefined && this.used + asked > cap) {
      const left = Math.max(0, cap - this.used);
      return refuse(
        `Frame budget reached: ${this.used} of ${cap} frames were captured in this turn (the turn's Execution Quality budget) and this call asks for ${asked}. ${left > 0 ? `Ask for at most ${left} ${left === 1 ? "frame" : "frames"}` : "Work from the frames you already saw and the timeline"}; a call is checked by its size, and frames of a project that has not changed since they were captured come from the cache and are given back afterwards.`,
      );
    }
    // Reserved before the await, so parallel calls of one assistant message share the budget.
    this.used += asked;
    try {
      const response = await this.options.host.frames(request, signal);
      // Cached frames cost nothing: give them back.
      this.used -= response.frames.filter((frame) => frame.cached).length;
      return { text: formatCompositionFrames(response), images: compositionFrameImages(response) };
    } catch (error) {
      this.used -= asked;
      throw error;
    }
  }
}
