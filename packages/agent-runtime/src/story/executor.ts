import {
  isRecord,
  parseStoryBuildRequest,
  parseStoryEditRequest,
  parseStoryRebuildRequest,
  type ParsedStory,
  type StoryActionOptions,
  type StoryView,
} from "@hyperframes/agent-protocol";
import type { HostToolResult } from "../backend.js";
import { errorMessage } from "../errors.js";
import { STORY_SECTIONS, formatStory, formatStoryPage, type StoryPageRequest } from "./format.js";
import { StoryToolError, type StoryHost } from "./host.js";
import {
  formatStoryBuild,
  formatStoryEdit,
  formatStoryError,
  formatStoryRebuild,
} from "./results.js";
import { STORY_TOOL_NAMES, isStoryToolName, type StoryToolName } from "./tools.js";

export interface TurnStoryOptions {
  host: StoryHost;
  /** The running turn: recorded on review summaries and stamped on the clips a build creates. */
  turnId: string;
  /** The turn's abort signal: aborting the turn aborts every in-flight read. */
  turnSignal: AbortSignal;
  /** The user's choices for a build/rebuild turn; the tools apply them and the model cannot widen them. */
  storyOptions: StoryActionOptions | null;
  /** The runtime has the voiceover host: the model is told whether each narration has its generated voice. */
  voice?: boolean;
}

const refuse = (text: string): HostToolResult => ({ text, isError: true });

function argsRecord(args: unknown): Record<string, unknown> {
  if (args === undefined || args === null) return {};
  if (!isRecord(args))
    throw new StoryToolError("invalid_request", "arguments must be a JSON object");
  return args;
}

/** The user's choices are not the model's to give: whatever it sends for them is dropped. */
const TURN_POLICY_KEYS = ["chapters", "manualEdits", "allowLocked"] as const;

function modelArgs(args: unknown): Record<string, unknown> {
  const record = withoutNulls(argsRecord(args), new Set());
  for (const key of TURN_POLICY_KEYS) delete record[key];
  return record;
}

function checked<T>(parsed: ParsedStory<T>): T {
  if (!parsed.ok)
    throw new StoryToolError(parsed.error.code, parsed.error.message, parsed.error.opIndex);
  return parsed.value;
}

/** `read_story`'s arguments: a chapter or a section (not both), and the offset to continue from. */
function readRequest(args: unknown): StoryPageRequest {
  const record = withoutNulls(argsRecord(args), new Set());
  const { chapter, section, offset = 0 } = record;
  if (chapter !== undefined && (typeof chapter !== "string" || chapter.trim().length === 0))
    throw new StoryToolError("invalid_request", "chapter must be a chapter id such as ch1");
  if (typeof offset !== "number" || !Number.isInteger(offset) || offset < 0)
    throw new StoryToolError("invalid_request", "offset must be a whole number from 0");
  if (section === undefined)
    return { ...(chapter !== undefined && { chapter: chapter.trim() }), offset };
  const known = STORY_SECTIONS.find((candidate) => candidate === section);
  if (!known)
    throw new StoryToolError(
      "invalid_request",
      `section must be one of ${STORY_SECTIONS.join(", ")}`,
    );
  if (chapter !== undefined)
    throw new StoryToolError("invalid_request", "pass either chapter or section, not both");
  return { section: known, offset };
}

/** Fields where `null` is a real value (clear it); everywhere else models send `null` for "not given". */
const MEANINGFUL_NULL = new Set([
  "previewFrame",
  "sourceOut",
  "asset",
  "bpm",
  "skill",
  "duration",
  "neededDuration",
  "offset",
  "captionPreset",
  "composition",
]);

function withoutNulls(record: Record<string, unknown>, keep: ReadonlySet<string>) {
  return Object.fromEntries(
    Object.entries(record).filter(([key, value]) => value !== null || keep.has(key)),
  );
}

/** One node's or update's fields: nulls for omitted fields go, and so do nulls inside source range inputs. */
function cleanFields(fields: Record<string, unknown>): Record<string, unknown> {
  const cleaned = withoutNulls(fields, MEANINGFUL_NULL);
  if (Array.isArray(cleaned.sourceRanges)) {
    cleaned.sourceRanges = cleaned.sourceRanges.map((range: unknown) =>
      isRecord(range) ? withoutNulls(range, new Set()) : range,
    );
  }
  return cleaned;
}

function cleanOperation(operation: unknown): unknown {
  if (!isRecord(operation)) return operation;
  const cleaned = withoutNulls(operation, MEANINGFUL_NULL);
  for (const key of ["node", "set"]) {
    const nested = cleaned[key];
    if (isRecord(nested)) cleaned[key] = cleanFields(nested);
  }
  return cleaned;
}

/**
 * The story tools of one running turn, bound to that turn's project and abort signal. Like the editing and analysis
 * executors it tracks its in-flight calls so {@link shutdown} can stop the turn's story work before the checkpoint
 * transaction closes: an edit or build that already reached the service is awaited to its end, and no new call is
 * accepted afterwards, so no story write can land after the checkpoint ends.
 */
export class TurnStory {
  private accepting = true;
  private built = false;
  private readonly stop = new AbortController();
  private readonly inflight = new Set<Promise<unknown>>();

  constructor(private readonly options: TurnStoryOptions) {}

  /** The view as the model reads it: what the voice host knows about narration is left out without the host. */
  private shown(view: StoryView): StoryView {
    if (this.options.voice === true) return view;
    return {
      ...view,
      facts: Object.fromEntries(
        Object.entries(view.facts).map(([id, facts]) => [
          id,
          {
            timeline: facts.timeline,
            ...(facts.materialDuration !== undefined && {
              materialDuration: facts.materialDuration,
            }),
          },
        ]),
      ),
    };
  }

  /** A real (not dry-run) `build_story` succeeded in this turn: the graph is frozen until the turn ends. */
  hasBuilt(): boolean {
    return this.built;
  }

  execute(name: string, args: unknown, callSignal: AbortSignal): Promise<HostToolResult> {
    if (!this.accepting)
      return Promise.resolve(refuse("The turn is finishing; the story is closed."));
    if (!isStoryToolName(name)) return Promise.resolve(refuse(`Unknown story tool ${name}.`));
    const signal = AbortSignal.any([callSignal, this.options.turnSignal, this.stop.signal]);
    const call = this.run(name, args, signal).catch((error: unknown): HostToolResult => {
      if (error instanceof StoryToolError) return refuse(formatStoryError(error));
      return refuse(`internal: ${errorMessage(error, "The story call failed")}`);
    });
    this.inflight.add(call);
    void call.finally(() => this.inflight.delete(call));
    return call;
  }

  /**
   * The story as the turn's prompt shows it (text plus the view it was made from); never throws (a turn must start
   * even if the story is unreadable).
   */
  async snapshot(signal: AbortSignal): Promise<{ graph: string | null; view: StoryView | null }> {
    try {
      const view = await this.options.host.view(signal);
      return { graph: formatStory(this.shown(view), 10_000), view };
    } catch {
      return { graph: null, view: null };
    }
  }

  /** Stops accepting calls, cancels running reads, and waits for every started call to end. */
  async shutdown(): Promise<void> {
    this.accepting = false;
    this.stop.abort();
    await Promise.allSettled([...this.inflight]);
  }

  private async run(
    name: StoryToolName,
    args: unknown,
    signal: AbortSignal,
  ): Promise<HostToolResult> {
    const { host, turnId, storyOptions } = this.options;
    switch (name) {
      case STORY_TOOL_NAMES.read:
        return { text: formatStoryPage(this.shown(await host.view(signal)), readRequest(args)) };
      case STORY_TOOL_NAMES.edit: {
        if (this.built)
          return refuse(
            "The story was already built in this turn, so the graph is frozen until the turn ends: edit_story is refused. Place late material on the timeline with edit_timeline, and tell the user what a later Build Story or a new edit should change.",
          );
        const record = withoutNulls(argsRecord(args), new Set());
        const operations = Array.isArray(record.operations)
          ? record.operations.map(cleanOperation)
          : record.operations;
        const request = checked(parseStoryEditRequest({ ...record, operations, turnId }));
        return { text: formatStoryEdit(await host.edit(request, signal)) };
      }
      case STORY_TOOL_NAMES.build: {
        const allowLocked = storyOptions?.allowLocked;
        const request = checked(
          parseStoryBuildRequest({
            ...modelArgs(args),
            turnId,
            ...(allowLocked && { allowLocked }),
          }),
        );
        const result = await host.build(request, signal);
        if (!result.dryRun) this.built = true;
        return { text: formatStoryBuild(result) };
      }
      case STORY_TOOL_NAMES.rebuild: {
        const request = checked(
          parseStoryRebuildRequest({ ...modelArgs(args), turnId, ...storyOptions }),
        );
        return { text: formatStoryRebuild(await host.rebuild(request, signal)) };
      }
    }
  }
}
