import type { AnalysisJob, AnalyzeRequest } from "@hyperframes/agent-protocol";
import { AnalysisToolError, type AnalysisHost } from "./host.js";

export const JOB_POLL_MS = 750;
const CANCEL_TIMEOUT_MS = 10_000;

/** Resolves after `ms`, or rejects with an `aborted` error the moment the signal fires. */
function pause(ms: number, signal: AbortSignal): Promise<void> {
  const { promise, resolve, reject } = Promise.withResolvers<void>();
  if (signal.aborted) {
    reject(cancelled());
    return promise;
  }
  const onAbort = () => {
    clearTimeout(timer);
    reject(cancelled());
  };
  const timer = setTimeout(() => {
    signal.removeEventListener("abort", onAbort);
    resolve();
  }, ms);
  signal.addEventListener("abort", onAbort, { once: true });
  return promise;
}

const cancelled = () => new AnalysisToolError("aborted", "The analysis was cancelled.");

/**
 * Starts (or joins) the analysis job of a source and polls it until it has finished. Aborting the call cancels the
 * job on the service — its child processes (ffmpeg, the recognizer) must not outlive the turn — and rejects with
 * `aborted`. A job this call only joined (one the user or another agent had already started) is left running: the
 * service shares it between callers and cancels it for all of them. A start the running job would not satisfy
 * (force, another language) is refused by the service with `conflict`, which is passed on with what to do next.
 * A job cancelled by someone else, or one that failed without finishing any stage, rejects with its own
 * error; a job where some stages finished is returned with every stage's outcome.
 */
export async function analyzeAndWait(
  host: AnalysisHost,
  request: AnalyzeRequest,
  signal: AbortSignal,
  pollMs: number = JOB_POLL_MS,
): Promise<AnalysisJob> {
  let job: AnalysisJob;
  try {
    job = await host.startJob(request, signal);
  } catch (error) {
    // The service refuses a request the running job would not satisfy (force, another language) instead of joining it.
    if (error instanceof AnalysisToolError && error.code === "conflict") {
      throw new AnalysisToolError(
        "conflict",
        `${error.message}. Nothing was started. To wait for the running analysis, call analyze_media for this source again without force or language; repeat this request afterwards if you still need it.`,
      );
    }
    throw error;
  }
  // A joined job is shared with whoever started it (the Media panel, another agent): cancelling it would kill theirs.
  const startedHere = job.joined !== true;
  try {
    while (job.status === "running") {
      await pause(pollMs, signal);
      job = await host.getJob(job.id, signal);
    }
  } catch (error) {
    if (signal.aborted) {
      if (startedHere)
        await host.cancelJob(job.id, AbortSignal.timeout(CANCEL_TIMEOUT_MS)).catch(() => undefined);
      throw cancelled();
    }
    throw error;
  }
  // One failed stage (e.g. speakers) must not hide the stages that did finish: the overview reports each stage's
  // outcome and detail, so a partial analysis is still returned; only a job with nothing usable is an error.
  const usable = job.results.some(
    (result) => result.outcome === "computed" || result.outcome === "cached",
  );
  if (job.status === "failed" && !usable) {
    throw new AnalysisToolError(
      job.error?.code ?? "failed",
      job.error?.message ?? "The analysis failed.",
    );
  }
  if (job.status === "cancelled") {
    throw new AnalysisToolError("cancelled", "The analysis was cancelled before it finished.");
  }
  return job;
}
