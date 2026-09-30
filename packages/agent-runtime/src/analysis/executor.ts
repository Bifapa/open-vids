import {
  ANALYSIS_LIMITS,
  EDIT_LIMITS,
  parseAnalyzeRequest,
  parseCutPlanRequest,
  parseFramesRequest,
  parseSaveSegmentsRequest,
  parseSaveVisionNotesRequest,
  isRecord,
  type ParsedAnalysis,
} from "@hyperframes/agent-protocol";
import type { HostToolResult } from "../backend.js";
import { EditingError, type EditingHost } from "../editing/host.js";
import { formatError } from "../editing/format.js";
import { errorMessage } from "../errors.js";
import {
  ANALYSIS_SECTIONS,
  formatAnalysisError,
  formatBuiltCut,
  formatCutPlan,
  unseenPictureProblems,
  formatFrames,
  formatOverview,
  formatSavedSegments,
  formatSavedVisionNotes,
  formatSection,
  formatShots,
  formatSilence,
  formatTranscript,
} from "./format.js";
import { AnalysisToolError, type AnalysisHost } from "./host.js";
import { JOB_POLL_MS, analyzeAndWait } from "./jobs.js";
import { problemsOnTimeline, roughCutBatch } from "./roughCut.js";
import { ANALYSIS_TOOL_NAMES, isAnalysisToolName, type AnalysisToolName } from "./tools.js";

export interface TurnAnalysisOptions {
  host: AnalysisHost;
  /** The editing host build_rough_cut writes through; null when the runtime has none. */
  editing: EditingHost | null;
  /** The turn's abort signal: aborting the turn cancels every running analysis job and read. */
  turnSignal: AbortSignal;
  /** How often a running job is polled (default 750 ms). */
  pollMs?: number;
}

const MARK_APPLIED_TIMEOUT_MS = 10_000;

const refuse = (text: string): HostToolResult => ({ text, isError: true });

const invalid = (message: string) => new AnalysisToolError("invalid_request", message);

function argsRecord(args: unknown): Record<string, unknown> {
  if (args === undefined || args === null) return {};
  if (!isRecord(args)) throw invalid("arguments must be a JSON object");
  return args;
}

/** Models send `null` for arguments they leave out; only `hook: null` (remove the hook) means something. */
function withoutNulls(args: unknown): unknown {
  if (!isRecord(args)) return args;
  return Object.fromEntries(
    Object.entries(args).filter(([key, value]) => value !== null || key === "hook"),
  );
}

function checked<T>(parsed: ParsedAnalysis<T>): T {
  if (!parsed.ok) throw new AnalysisToolError(parsed.error.code, parsed.error.message);
  return parsed.value;
}

function sourceOf(record: Record<string, unknown>): string {
  const { source } = record;
  if (typeof source !== "string" || source.trim().length === 0)
    throw invalid("source must be the project-relative path of a media file");
  if (source.length > ANALYSIS_LIMITS.pathChars)
    throw invalid(`source exceeds ${ANALYSIS_LIMITS.pathChars} characters`);
  return source;
}

const CLOCK_TIME = /^(?:(\d+):)?(\d{1,2}):(\d{2}(?:\.\d+)?)$/;

/** Seconds as a number, or as the `mm:ss.s` the transcript prints (models copy those). */
function timeArg(value: unknown, field: string): number | undefined {
  if (value === undefined) return undefined;
  let seconds: number | null = null;
  if (typeof value === "number") seconds = value;
  else if (typeof value === "string") {
    const match = CLOCK_TIME.exec(value.trim());
    seconds = match
      ? Number(match[1] ?? 0) * 3_600 + Number(match[2]) * 60 + Number(match[3])
      : Number(value);
  }
  if (
    seconds === null ||
    !Number.isFinite(seconds) ||
    seconds < 0 ||
    seconds > ANALYSIS_LIMITS.maxTime
  )
    throw invalid(`${field} must be seconds of the source (a number ≥ 0)`);
  return seconds;
}

function planArg(record: Record<string, unknown>): string {
  const { plan } = record;
  if (typeof plan !== "string" || plan.trim().length === 0 || plan.length > ANALYSIS_LIMITS.idChars)
    throw invalid("plan must be a plan id such as cut-1");
  return plan.trim();
}

/**
 * The analysis tools of one running turn, bound to that turn's project and abort signal. Like the editing executor
 * it tracks its in-flight calls so {@link shutdown} can stop the turn's analysis before the checkpoint transaction
 * closes: running jobs are cancelled, a build_rough_cut whose edit already reached Studio is awaited to its end, and
 * no new call is accepted afterwards.
 */
export class TurnAnalysis {
  private accepting = true;
  private readonly stop = new AbortController();
  private readonly inflight = new Set<Promise<unknown>>();
  private readonly planRanges = new Map<string, number>();

  constructor(private readonly options: TurnAnalysisOptions) {}

  /** Ranges (= clips) of a plan this turn has planned or built, for the activity label of build_rough_cut. */
  planClips(plan: string): number | undefined {
    return this.planRanges.get(plan);
  }

  execute(name: string, args: unknown, callSignal: AbortSignal): Promise<HostToolResult> {
    if (!this.accepting)
      return Promise.resolve(refuse("The turn is finishing; analysis is closed."));
    if (!isAnalysisToolName(name)) return Promise.resolve(refuse(`Unknown analysis tool ${name}.`));
    const signal = AbortSignal.any([callSignal, this.options.turnSignal, this.stop.signal]);
    const call = this.run(name, args, signal).catch((error: unknown): HostToolResult => {
      if (error instanceof AnalysisToolError) return refuse(formatAnalysisError(error));
      if (error instanceof EditingError) return refuse(formatError(error));
      return refuse(`internal: ${errorMessage(error, "The analysis call failed")}`);
    });
    this.inflight.add(call);
    void call.finally(() => this.inflight.delete(call));
    return call;
  }

  /** Stops accepting calls, cancels running jobs and reads, and waits for every started call to end. */
  async shutdown(): Promise<void> {
    this.accepting = false;
    this.stop.abort();
    await Promise.allSettled([...this.inflight]);
  }

  private async run(
    name: AnalysisToolName,
    args: unknown,
    signal: AbortSignal,
  ): Promise<HostToolResult> {
    const { host } = this.options;
    switch (name) {
      case ANALYSIS_TOOL_NAMES.analyze: {
        const request = checked(parseAnalyzeRequest(withoutNulls(args)));
        const job = await analyzeAndWait(host, request, signal, this.options.pollMs ?? JOB_POLL_MS);
        return { text: formatOverview(await host.overview(request.source, signal), job) };
      }
      case ANALYSIS_TOOL_NAMES.read: {
        const record = argsRecord(withoutNulls(args));
        const source = sourceOf(record);
        const section =
          record.section === undefined
            ? "overview"
            : ANALYSIS_SECTIONS.find((candidate) => candidate === record.section);
        if (!section) throw invalid(`section must be one of ${ANALYSIS_SECTIONS.join(", ")}`);
        if (section === "silence")
          return { text: formatSilence(await host.artifact(source, "silence", signal)) };
        if (section === "shots")
          return { text: formatShots(await host.artifact(source, "shots", signal)) };
        const overview = await host.overview(source, signal);
        return {
          text:
            section === "overview" ? formatOverview(overview) : formatSection(section, overview),
        };
      }
      case ANALYSIS_TOOL_NAMES.transcript: {
        const record = argsRecord(withoutNulls(args));
        const source = sourceOf(record);
        const from = timeArg(record.from, "from");
        const to = timeArg(record.to, "to");
        if (from !== undefined && to !== undefined && to <= from)
          throw invalid("to must be after from");
        const window = { ...(from !== undefined && { from }), ...(to !== undefined && { to }) };
        const [view, issues] = await Promise.all([
          host.transcript(source, window, signal),
          // Marks are a courtesy: a transcript that reads fine must not fail because the overview did.
          host.overview(source, signal).then(
            (overview) => overview.takes?.issues ?? [],
            () => [],
          ),
        ]);
        return { text: formatTranscript(view, issues) };
      }
      case ANALYSIS_TOOL_NAMES.segments: {
        const request = checked(parseSaveSegmentsRequest(args));
        return { text: formatSavedSegments(await host.saveSegments(request, signal)) };
      }
      case ANALYSIS_TOOL_NAMES.frames: {
        const request = checked(parseFramesRequest(withoutNulls(args)));
        const { frames } = await host.frames(request, signal);
        return {
          text: formatFrames(request.source, frames),
          images: frames.map((frame) => ({ mimeType: frame.mimeType, data: frame.data })),
        };
      }
      case ANALYSIS_TOOL_NAMES.vision: {
        const request = checked(parseSaveVisionNotesRequest(args));
        return {
          text: formatSavedVisionNotes(
            request.notes.length,
            await host.saveVisionNotes(request, signal),
          ),
        };
      }
      case ANALYSIS_TOOL_NAMES.plan: {
        const request = checked(parseCutPlanRequest(withoutNulls(args)));
        const plan = await host.planCut(request, signal);
        this.planRanges.set(plan.id, plan.ranges.length);
        // The planner cannot see pictures: say which detected picture problems stay in this cut unseen by Vision.
        const overview = await host.overview(plan.source, signal).catch(() => null);
        const unseen = unseenPictureProblems(plan.ranges, overview?.visionTargets ?? []);
        return { text: [formatCutPlan(plan), unseen].filter(Boolean).join("\n") };
      }
      case ANALYSIS_TOOL_NAMES.build:
        return this.buildRoughCut(args, signal);
    }
  }

  /**
   * Plan → timeline in one atomic batch through the editing path (so it belongs to the turn's checkpoint and Revert
   * undoes it), then the plan is recorded as applied. Everything that can fail is read before the batch is sent; once
   * it is on its way it is awaited to its end and the record is written even if the turn is stopping.
   */
  private async buildRoughCut(args: unknown, signal: AbortSignal): Promise<HostToolResult> {
    const { host, editing } = this.options;
    if (!editing)
      throw new AnalysisToolError("unavailable", "Editing is not available in this runtime.");
    const record = argsRecord(withoutNulls(args));
    const planId = planArg(record);
    const composition =
      typeof record.composition === "string" && record.composition.length > 0
        ? record.composition
        : undefined;
    const { track = 0 } = record;
    if (
      typeof track !== "number" ||
      !Number.isInteger(track) ||
      track < 0 ||
      track > EDIT_LIMITS.maxTrack
    )
      throw invalid(`track must be an integer from 0 to ${EDIT_LIMITS.maxTrack}`);

    const plan = await host.getCut(planId, signal);
    this.planRanges.set(plan.id, plan.ranges.length);
    const [timeline, overview] = await Promise.all([
      editing.timeline(composition, signal),
      host.overview(plan.source, signal),
    ]);
    const batch = roughCutBatch({ plan, timeline, composition, track });
    if (signal.aborted)
      throw new AnalysisToolError("aborted", "The turn is stopping; the rough cut was not built.");
    const response = await editing.apply(batch.request, signal);

    const built = response.results.find((result) => result.op === "add_sequence");
    const clips = built?.clipIds?.length ?? plan.ranges.length;
    let recordFailure: string | null = null;
    try {
      await host.markApplied(
        plan.id,
        { composition: response.timeline.composition.path, version: response.timeline.version },
        AbortSignal.timeout(MARK_APPLIED_TIMEOUT_MS),
      );
    } catch (error) {
      recordFailure = errorMessage(error, "unknown error");
    }
    return {
      text: formatBuiltCut({
        plan,
        track,
        clips,
        length: batch.length,
        replacedClips: batch.replacedClips,
        timeline: response.timeline,
        problems: problemsOnTimeline(plan, overview.shots?.problems ?? []),
        recordFailure,
      }),
    };
  }
}
