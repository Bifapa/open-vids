import {
  PRESET_KINDS,
  isRecord,
  parseApplyEditsRequest,
  type EditorContext,
} from "@hyperframes/agent-protocol";
import type { HostToolResult } from "../backend.js";
import { errorMessage } from "../errors.js";
import {
  formatEditResult,
  formatError,
  formatInventory,
  formatPresets,
  formatRender,
  formatTimeline,
} from "./format.js";
import { EditingError, RENDER_QUALITIES, type EditingHost, type RenderQuality } from "./host.js";
import { EDITING_TOOL_NAMES, isEditingToolName, type EditingToolName } from "./tools.js";
import { formatExportCheck } from "../research/format.js";
import type { ResearchHost } from "../research/host.js";
import { LONG_RENDER_SECONDS, asksForRender, longRenderRefusal } from "./renderGuard.js";

export interface TurnEditingOptions {
  host: EditingHost;
  /** The editor state Studio captured when the user sent the message; reported by inspect_timeline. */
  editorContext?: EditorContext | undefined;
  /** The turn's abort signal: aborting the turn aborts every in-flight edit and render. */
  turnSignal: AbortSignal;
  /** What the user wrote to this turn so far; `render_video` refuses a long composition unless one of these asks for a render. */
  userRequests?: readonly string[];
  /** The running turn: stamped on every `edit_timeline` batch so the service can attribute the edits to it. */
  turnId?: string | undefined;
  /** The research host: a finished render reports the license warnings and credits of the researched assets it ships. */
  research?: ResearchHost | undefined;
  /**
   * The project's fingerprint (see the QA service): read just before a render starts, so render QA can tell whether
   * the Director's own render still shows the current project. Null when it cannot be read; absent without QA.
   */
  fingerprint?: ((signal: AbortSignal) => Promise<string | null>) | undefined;
}

/** The last render the turn made with `render_video`, and the state of the project it was made from. */
export interface LastRender {
  path: string;
  quality: RenderQuality;
  /** The composition asked for; undefined = the project's main composition. */
  composition: string | undefined;
  /** The project fingerprint before the render started; null when unknown. */
  fingerprint: string | null;
}

const refuse = (text: string): HostToolResult => ({ text, isError: true });

const invalid = (message: string) => new EditingError("invalid_request", message);

/** Reads an optional string argument; anything else is a refusal the model can correct. */
function optionalString(
  args: Record<string, unknown>,
  key: string,
  max: number,
): string | undefined {
  const value = args[key];
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.length === 0 || value.length > max) {
    throw invalid(`${key} must be a non-empty string of at most ${max} characters`);
  }
  return value;
}

function argsRecord(args: unknown): Record<string, unknown> {
  if (args === undefined || args === null) return {};
  if (!isRecord(args)) throw invalid("arguments must be a JSON object");
  return args;
}

/**
 * The editing tools of one running turn, bound to that turn's project, editor context and abort signal. It tracks its
 * in-flight calls so {@link shutdown} can stop the turn's editing before the checkpoint transaction closes: after it
 * resolves nothing this executor started can still write to the project, and no new call is accepted.
 */
export class TurnEditing {
  private accepting = true;
  private readonly stop = new AbortController();
  private readonly inflight = new Set<Promise<unknown>>();

  private readonly requests: string[];
  private lastRenderOutput: LastRender | null = null;

  constructor(private readonly options: TurnEditingOptions) {
    this.requests = [...(options.userRequests ?? [])];
  }

  /** The user sent another message to this turn (steering): it may ask for a render. */
  noteUserRequest(text: string): void {
    this.requests.push(text);
  }

  /** Whether the user asked for a render, an export or a video file in this turn. */
  userAskedForRender(): boolean {
    return this.requests.some(asksForRender);
  }

  /** The turn's last successful `render_video`, if any. */
  lastRender(): LastRender | null {
    return this.lastRenderOutput;
  }

  execute(
    name: string,
    args: unknown,
    callSignal: AbortSignal,
    progress?: (percent: number) => void,
  ): Promise<HostToolResult> {
    if (!this.accepting)
      return Promise.resolve(refuse("The turn is finishing; editing is closed."));
    if (!isEditingToolName(name)) return Promise.resolve(refuse(`Unknown editing tool ${name}.`));
    const signal = AbortSignal.any([callSignal, this.options.turnSignal, this.stop.signal]);
    const call = this.run(name, args, signal, progress).catch((error: unknown): HostToolResult => {
      if (error instanceof EditingError) return refuse(formatError(error));
      return refuse(`internal: ${errorMessage(error, "The editing call failed")}`);
    });
    this.inflight.add(call);
    void call.finally(() => this.inflight.delete(call));
    return call;
  }

  /** Stops accepting calls, cancels running renders and reads, and waits for every started call to end. */
  async shutdown(): Promise<void> {
    this.accepting = false;
    this.stop.abort();
    await Promise.allSettled([...this.inflight]);
  }

  /**
   * What the render's composition ships from outside the project: license warnings and credits of the researched
   * assets it uses. It is a report, never a gate: a check that cannot run is noted and the render stands.
   */
  private async licenseReport(
    composition: string | undefined,
    signal: AbortSignal,
  ): Promise<string | null> {
    const { research, host } = this.options;
    if (!research) return null;
    try {
      const path = composition ?? (await host.timeline(undefined, signal)).composition.path;
      return formatExportCheck(await research.exportCheck(path, signal)) || null;
    } catch (error) {
      if (signal.aborted) return null;
      return `License check: could not be run (${errorMessage(error, "unknown error")}); tell the user the licenses of imported assets were not checked — the Sources panel shows them.`;
    }
  }

  private async run(
    name: EditingToolName,
    args: unknown,
    signal: AbortSignal,
    progress?: (percent: number) => void,
  ): Promise<HostToolResult> {
    const { host, editorContext } = this.options;
    switch (name) {
      case EDITING_TOOL_NAMES.project:
        return { text: formatInventory(await host.inventory(signal)) };
      case EDITING_TOOL_NAMES.timeline: {
        const composition = optionalString(argsRecord(args), "composition", 1_024);
        return { text: formatTimeline(await host.timeline(composition, signal), editorContext) };
      }
      case EDITING_TOOL_NAMES.edit: {
        const request = parseApplyEditsRequest(args);
        if (!request.ok)
          throw new EditingError(request.error.code, request.error.message, request.error.opIndex);
        // The turn is the runtime's to name: whatever id the model sent is replaced.
        const { turnId } = this.options;
        const batch = turnId === undefined ? request.value : { ...request.value, turnId };
        return { text: formatEditResult(await host.apply(batch, signal)) };
      }
      case EDITING_TOOL_NAMES.presets: {
        const record = argsRecord(args);
        const kind = PRESET_KINDS.find((candidate) => candidate === record.kind);
        if (!kind) throw invalid(`kind must be one of ${PRESET_KINDS.join(", ")}`);
        const query = optionalString(record, "query", 200);
        return { text: formatPresets(kind, await host.presets(kind, query, signal)) };
      }
      case EDITING_TOOL_NAMES.render: {
        const record = argsRecord(args);
        const composition = optionalString(record, "composition", 1_024);
        const quality: RenderQuality | undefined =
          record.quality === undefined
            ? "standard"
            : RENDER_QUALITIES.find((candidate) => candidate === record.quality);
        if (!quality) throw invalid(`quality must be one of ${RENDER_QUALITIES.join(", ")}`);
        // A long render is offered, never started unasked (it would tie the machine up for many minutes).
        let target: string | undefined;
        if (!this.userAskedForRender()) {
          const snapshot = await host.timeline(composition, signal);
          target = snapshot.composition.path;
          if (snapshot.composition.duration > LONG_RENDER_SECONDS)
            return refuse(longRenderRefusal(snapshot.composition.duration));
        }
        const fingerprint = await this.options.fingerprint?.(signal).catch(() => null);
        const output = await host.render(
          { ...(composition && { composition }), quality },
          signal,
          (update) => progress?.(update.progress),
        );
        this.lastRenderOutput = {
          path: output.path,
          quality,
          composition,
          fingerprint: fingerprint ?? null,
        };
        const licenses = await this.licenseReport(composition ?? target, signal);
        return { text: licenses ? `${formatRender(output)}\n\n${licenses}` : formatRender(output) };
      }
    }
  }
}
