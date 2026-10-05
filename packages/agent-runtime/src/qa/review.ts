import type {
  QaAcceptedIssue,
  QaCheckResponse,
  QaIssue,
  QaIssueDraft,
  QaVisionRun,
} from "@hyperframes/agent-protocol";
import type { RuntimeRunResult } from "../agents/orchestrator.js";
import { errorMessage } from "../errors.js";
import type { QaLoopDeps } from "./deps.js";
import type { QaReviewOutcome } from "./executor.js";
import { renderVisionTask } from "./prompt.js";

export interface ReviewInput {
  pass: number;
  limit: number;
  render: { path: string; duration: number };
  check: QaCheckResponse;
  /** The issues open after the previous pass. */
  previous: readonly QaIssue[];
  accepted: readonly QaAcceptedIssue[];
}

export interface ReviewResult {
  vision: QaVisionRun;
  findings: QaIssueDraft[];
}

/** A review that did not look at anything: `status` says why, `reasonCode` is its `qa.reason.<code>` key. */
export function noReview(
  status: QaVisionRun["status"],
  reason: string,
  reasonCode: string,
  reviewer?: QaVisionRun["reviewer"],
): ReviewResult {
  return {
    vision: {
      status,
      reason,
      reasonCode,
      frames: 0,
      rounds: 0,
      model: null,
      ...(reviewer && { reviewer }),
    },
    findings: [],
  };
}

/**
 * The visual review of one pass's render, by Vision in its own run — or, when Vision is off in the chat, by the Director
 * itself (the runtime puts the same task to it with the review tools opened for it and everything else refused).
 * `"aborted"` when the turn was stopped during it.
 */
export async function reviewRender(
  deps: QaLoopDeps,
  input: ReviewInput,
): Promise<ReviewResult | "aborted"> {
  const { budget } = deps.setup.execution;
  const reviewer = deps.setup.enabled.includes("vision") ? "vision" : "director";
  const samples = input.check.samples.slice(0, budget.qaMaxFrames);
  if (samples.length === 0)
    return noReview("skipped", "The checks planned no frame to look at.", "vision_no_frames");

  deps.qa.openReview({
    reviewer,
    pass: input.pass,
    render: input.render.path,
    duration: input.render.duration,
    samples,
    maxFrames: budget.qaMaxFrames,
    critiqueRounds: budget.critiqueRounds,
  });
  const task = renderVisionTask({
    pass: input.pass,
    limit: input.limit,
    render: input.render.path,
    composition: input.check.composition,
    duration: input.render.duration,
    samples,
    deterministic: input.check.issues,
    previousVision: input.previous.filter((issue) => issue.source === "vision"),
    budget,
    reviewer,
    accepted: input.accepted,
  });
  let run: RuntimeRunResult | null = null;
  let failure: string | null = null;
  try {
    run =
      reviewer === "vision"
        ? await runVision(deps, input.pass, task)
        : await runDirector(deps, task);
  } catch (error) {
    failure = errorMessage(
      error,
      reviewer === "vision" ? "Vision could not start" : "The review could not run",
    );
  }
  const closed = deps.qa.closeReview();
  if (deps.signal.aborted || run?.status === "aborted") return "aborted";
  return outcomeOf(closed, run, failure, reviewer);
}

async function runVision(deps: QaLoopDeps, pass: number, task: string): Promise<RuntimeRunResult> {
  return deps.orchestrator.runInternal({
    agent: "vision",
    title: `Render QA · pass ${pass}`,
    titleCode: "render_qa_pass",
    titleParams: { pass },
    task,
  });
}

async function runDirector(deps: QaLoopDeps, task: string): Promise<RuntimeRunResult> {
  const { director } = deps;
  director.setPhase("review");
  try {
    const outcome = await director.prompt(task);
    // What the Director said around the review is progress, not the answer.
    await director.markInterim();
    return { status: outcome === "completed" ? "completed" : "aborted", error: null, model: null };
  } finally {
    director.setPhase(null);
  }
}

function outcomeOf(
  closed: QaReviewOutcome,
  run: RuntimeRunResult | null,
  failure: string | null,
  reviewer: "vision" | "director",
): ReviewResult {
  const base = {
    frames: closed.frames,
    rounds: closed.rounds,
    model: run?.model ?? null,
    ...(reviewer === "director" && { reviewer }),
  };
  const who = reviewer === "vision" ? "Vision's" : "The Director's";
  if (failure !== null)
    return { vision: { status: "failed", reason: failure, ...base }, findings: [] };
  if (run && run.status !== "completed") {
    const why = run.error ?? `The run ${run.status}.`;
    return {
      vision: {
        status: "failed",
        reason: closed.reported
          ? `${who} run failed after reporting its findings (${why}).`
          : `${who} run failed (${why}).`,
        ...base,
      },
      findings: closed.findings,
    };
  }
  if (!closed.reported) {
    return {
      vision: {
        status: "failed",
        reason: `${reviewer === "vision" ? "Vision" : "The Director"} finished without reporting any findings, so its review did not count.`,
        reasonCode: "vision_no_findings",
        ...base,
      },
      findings: [],
    };
  }
  return { vision: { status: "ran", reason: null, ...base }, findings: closed.findings };
}
