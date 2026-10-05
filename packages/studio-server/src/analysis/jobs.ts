import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import type { AnalysisJob, ComputedStage, StageResult } from "@hyperframes/agent-protocol";
import { AnalysisFailure, isAnalysisFailure } from "./errors.js";
import type { StageReporter } from "./stages.js";

/** How long a finished job stays pollable. */
export const FINISHED_JOB_TTL_MS = 10 * 60 * 1000;
/** A cancel waits this long for the running work to stop before it reports the job cancelled anyway. */
const CANCEL_GRACE_MS = 3_000;

interface Entry {
  projectDir: string;
  key: string;
  job: AnalysisJob;
  controller: AbortController;
  done: Promise<void>;
  weights: Partial<Record<ComputedStage, number>>;
  want: JobWant;
  total: number;
  finishedWeight: number;
  current: ComputedStage | null;
}

function snapshot(job: AnalysisJob): AnalysisJob {
  return { ...job, results: [...job.results], error: job.error ? { ...job.error } : null };
}

export interface StartJob {
  projectDir: string;
  /** Project-relative path of the source. */
  source: string;
  /** The stages the job will report on, and the share of the progress bar each takes. */
  weights: Partial<Record<ComputedStage, number>>;
  /** What the request asks of those stages, for deciding whether a later request may join this job. */
  want: JobWant;
  /** The work. Resolves when every stage concluded (whatever the outcomes); rejects with `cancelled` when aborted. */
  run: (reporter: StageReporter) => Promise<void>;
}

export interface JobWant {
  /** Spoken-language hint of the transcript; undefined = detected. */
  language: string | undefined;
  /** Stages recomputed even when fresh. */
  force: readonly ComputedStage[];
}

/** What a running job leaves undone of a request, phrased to follow "is already being analysed"; "" when nothing. */
function unmetBy(running: Entry, request: StartJob): string {
  const planned = Object.keys(running.weights);
  const missing = Object.keys(request.weights).filter((stage) => !planned.includes(stage));
  if (missing.length > 0) return ` without ${missing.join(", ")}`;
  const unforced = request.want.force.filter((stage) => !running.want.force.includes(stage));
  if (unforced.length > 0) return ` without recomputing ${unforced.join(", ")}`;
  const transcribes = request.weights.transcript !== undefined;
  const language = request.want.language;
  const hinted = language !== undefined || request.want.force.length > 0;
  if (transcribes && hinted && language !== running.want.language) {
    return running.want.language
      ? ` in language "${running.want.language}"`
      : " with the language detected";
  }
  return "";
}

/**
 * Analysis jobs: one running job per (project, source), which a second request joins instead of starting another.
 * Finished jobs stay in memory for ten minutes so a client can poll for the outcome.
 */
export class JobRegistry {
  private readonly byId = new Map<string, Entry>();
  private readonly running = new Map<string, Entry>();

  constructor(private readonly now: () => number = Date.now) {}

  /**
   * Starts a job, or returns the running job of the same source when it will do what the request asks. A request
   * the running job would not satisfy (a forced recompute, another language, stages it does not run) is refused:
   * joining it would report success for work that never happens.
   */
  start(options: StartJob): AnalysisJob {
    this.prune();
    const key = `${options.projectDir}\0${options.source}`;
    const joined = this.running.get(key);
    if (joined) {
      const unmet = unmetBy(joined, options);
      if (unmet) {
        throw new AnalysisFailure(
          "conflict",
          `${options.source} is already being analysed${unmet}; wait for that analysis to finish, then ask again`,
        );
      }
      return { ...snapshot(joined.job), joined: true };
    }

    const controller = new AbortController();
    const total = Object.values(options.weights).reduce((sum, weight) => sum + weight, 0);
    const job: AnalysisJob = {
      id: `job-${randomUUID().slice(0, 8)}`,
      source: options.source,
      status: "running",
      stage: null,
      progress: 0,
      results: [],
      error: null,
      startedAt: this.now(),
      finishedAt: null,
    };
    const entry: Entry = {
      projectDir: options.projectDir,
      key,
      job,
      controller,
      done: Promise.resolve(),
      weights: options.weights,
      want: options.want,
      total: Math.max(total, 1),
      finishedWeight: 0,
      current: null,
    };
    this.byId.set(job.id, entry);
    this.running.set(key, entry);
    entry.done = this.execute(entry, options.run);
    return snapshot(job);
  }

  get(projectDir: string, id: string): AnalysisJob | null {
    this.prune();
    const entry = this.byId.get(id);
    return entry && entry.projectDir === projectDir ? snapshot(entry.job) : null;
  }

  /** The running job of a source, if any. */
  runningFor(projectDir: string, source: string): AnalysisJob | null {
    const entry = this.running.get(`${projectDir}\0${source}`);
    return entry ? snapshot(entry.job) : null;
  }

  /** Aborts the job (killing its child processes) and resolves with its final state; null for an unknown job. */
  async cancel(projectDir: string, id: string): Promise<AnalysisJob | null> {
    const entry = this.byId.get(id);
    if (!entry || entry.projectDir !== projectDir) return null;
    if (entry.job.status === "running") {
      entry.controller.abort();
      const stopWaiting = new AbortController();
      const grace = delay(CANCEL_GRACE_MS, undefined, { signal: stopWaiting.signal }).catch(
        () => undefined,
      );
      await Promise.race([entry.done, grace]);
      stopWaiting.abort();
      if (entry.job.status === "running") {
        this.finish(entry, "cancelled", new AnalysisFailure("cancelled", "Analysis was cancelled"));
      }
    }
    return snapshot(entry.job);
  }

  /** Aborts every running job (server shutdown). */
  abortAll(): void {
    for (const entry of this.running.values()) entry.controller.abort();
  }

  private async execute(entry: Entry, run: StartJob["run"]): Promise<void> {
    const { job } = entry;
    const live = () => job.status === "running";
    const reporter: StageReporter = {
      signal: entry.controller.signal,
      begin: (stage) => {
        if (!live()) return;
        entry.current = stage;
        job.stage = stage;
      },
      advance: (fraction) => {
        if (!live() || !entry.current) return;
        const share = (entry.weights[entry.current] ?? 0) * Math.min(1, Math.max(0, fraction));
        this.setProgress(entry, entry.finishedWeight + share);
      },
      finish: (result: StageResult) => {
        if (!live()) return;
        job.results.push(result);
        entry.finishedWeight += entry.weights[result.stage] ?? 0;
        entry.current = null;
        job.stage = null;
        this.setProgress(entry, entry.finishedWeight);
      },
    };
    try {
      await run(reporter);
      if (!live()) return;
      const failed = job.results.find((result) => result.outcome === "failed");
      if (failed) {
        this.finish(
          entry,
          "failed",
          new AnalysisFailure("failed", `${failed.stage}: ${failed.detail ?? "failed"}`),
        );
      } else {
        this.setProgress(entry, entry.total);
        this.finish(entry, "completed", null);
      }
    } catch (error) {
      if (!live()) return;
      if (isAnalysisFailure(error) && error.error.code === "cancelled") {
        this.finish(entry, "cancelled", error);
      } else {
        const message = error instanceof Error ? error.message : String(error);
        this.finish(
          entry,
          "failed",
          isAnalysisFailure(error) ? error : new AnalysisFailure("failed", message),
        );
      }
    }
  }

  private setProgress(entry: Entry, weight: number): void {
    const progress = Math.round(Math.min(100, (weight / entry.total) * 100) * 10) / 10;
    entry.job.progress = Math.max(entry.job.progress, progress);
  }

  private finish(
    entry: Entry,
    status: "completed" | "failed" | "cancelled",
    failure: AnalysisFailure | null,
  ): void {
    entry.job.status = status;
    entry.job.stage = null;
    entry.job.error = failure ? failure.error : null;
    entry.job.finishedAt = this.now();
    entry.current = null;
    if (this.running.get(entry.key) === entry) this.running.delete(entry.key);
  }

  private prune(): void {
    const cutoff = this.now() - FINISHED_JOB_TTL_MS;
    for (const [id, entry] of this.byId) {
      const finishedAt = entry.job.finishedAt;
      if (finishedAt !== null && finishedAt < cutoff) this.byId.delete(id);
    }
  }
}
