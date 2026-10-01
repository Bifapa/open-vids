import {
  compareQaPass,
  sameQaIssue,
  type ChatMode,
  type QaCheckResponse,
  type QaCheckRun,
  type QaIssue,
  type QaIssueDraft,
  type QaPassPhase,
  type QaPassState,
  type QaRenderOrigin,
  type QaReport,
  type QaReportInput,
  type QaVisionRun,
  type StoryAction,
  type TurnQaState,
  type TurnQaStatus,
  type TurnSummary,
} from "@hyperframes/agent-protocol";
import type { BackendPromptOutcome } from "../backend.js";
import type { Orchestrator, RuntimeRunResult, TurnAgentSetup } from "../agents/orchestrator.js";
import type { ChatService } from "../chats.js";
import type { LastRender } from "../editing/executor.js";
import type { EditingHost, RenderQuality } from "../editing/host.js";
import { LONG_RENDER_SECONDS } from "../editing/renderGuard.js";
import { errorMessage } from "../errors.js";
import type { TurnQa } from "./executor.js";
import {
  renderCorrectionPrompt,
  renderFinalPrompt,
  renderSkippedPrompt,
  renderVisionTask,
} from "./prompt.js";

/** Where the turn is in QA; the runner refuses tools accordingly (see `qaToolRefusal`). */
export type QaPhase = "correction" | "final" | null;

/** What the loop needs from the turn runner to talk to the Director. */
export interface QaDirector {
  /** Runs one Director prompt and resolves how it ended. */
  prompt(text: string): Promise<BackendPromptOutcome>;
  /** Re-prompts the Director with delegated runs it finished without collecting and with steering, as after its first reply. */
  settle(outcome: BackendPromptOutcome): Promise<BackendPromptOutcome>;
  /** Marks the Director's text written so far in the turn's reply as an interim progress note. */
  markInterim(): Promise<void>;
  /** Steering received while the Director was idle; it opens the next prompt. */
  takeSteering(): string[];
  setPhase(phase: QaPhase): void;
}

export interface QaLoopDeps {
  chats: ChatService;
  chatId: string;
  /** The live turn record; `qa` is kept on it so terminal turn events carry it. */
  turn: TurnSummary;
  qa: TurnQa;
  editing: EditingHost;
  /** What the Director's own `render_video` calls did: whether the user asked for a render, and the last render. */
  renders: { asked(): boolean; last(): LastRender | null };
  orchestrator: Orchestrator;
  setup: TurnAgentSetup;
  mode: ChatMode;
  action: StoryAction | null;
  /** The project's fingerprint when the turn started; null when the QA service could not say. */
  startFingerprint: string | null;
  director: QaDirector;
  /**
   * The Director was told (`<render-qa-pending>`) that a check follows its reply. When QA then does not run although
   * the project changed, its reply was interim and it is asked for the final answer.
   */
  instructed?: boolean;
  /** The turn's abort signal. */
  signal: AbortSignal;
  now: () => number;
}

/** Whether the turn is one QA may run in: normal turns, story builds and rebuilds (report-only); never plan/review/resolve. */
export function qaApplies(mode: ChatMode, action: StoryAction | null): boolean {
  return mode !== "story" || action === "build" || action === "rebuild";
}

interface RenderedPass {
  path: string;
  duration: number;
  width: number;
  height: number;
  hasAudio: boolean | null;
  quality: RenderQuality;
  /** The project fingerprint the render was made from. */
  fingerprint: string;
  /** `turn`: the Director's own render, reused; `qa`: rendered by QA for this pass. */
  origin: QaRenderOrigin;
}

type PassResult =
  | { kind: "aborted" }
  | { kind: "failed"; reason: string }
  | {
      kind: "reported";
      report: QaReport;
      issues: QaIssue[];
      resolved: QaIssue[];
      vision: QaVisionRun;
      render: RenderedPass | null;
      renderError: string | null;
    };

const isAbort = (signal: AbortSignal, error: unknown): boolean =>
  signal.aborted ||
  (typeof error === "object" && error !== null && "code" in error && error.code === "aborted");

const SKIPPED_VISION: QaVisionRun = {
  status: "skipped",
  reason: null,
  frames: 0,
  rounds: 0,
  model: null,
};

const minutes = (seconds: number): string => `${Number((seconds / 60).toFixed(1))} minutes`;

function tooLongReason(duration: number): string {
  return `The composition is ${minutes(duration)} long and the user did not ask for a render, so QA did not render it (a render that long takes many minutes). Ask for a render or an export to have it checked.`;
}

/**
 * Autonomous render QA of one turn: render → deterministic checks + Vision's review → compare with the previous pass →
 * store the report → (if fixable issues remain and passes are left) a Director correction → the next pass. At most
 * `qaPasses` renders, so at most `qaPasses − 1` corrections; a correction that changes nothing ends the loop.
 * Afterwards the Director gets one final prompt to report, during which the runner refuses every change.
 */
export class QaLoop {
  private state: TurnQaState | null = null;
  /** Previews this session rendered itself (never the Director's own render pass 1 reuses), in order. */
  private readonly produced: string[] = [];
  /** The latest render of the session that succeeded: what the final report names and cleanup keeps. */
  private latestRender: string | null = null;
  private finished = false;

  constructor(private readonly deps: QaLoopDeps) {}

  /**
   * Runs QA after the Director's work (and its follow-ups) completed with `outcome`; resolves the outcome the turn
   * should finish with (`aborted` when the turn was stopped during QA). Never throws for QA failures: they are recorded
   * in the turn's QA state.
   */
  async run(outcome: BackendPromptOutcome): Promise<BackendPromptOutcome> {
    try {
      return await this.execute(outcome);
    } catch (error) {
      // The Director's prompt failed or the chat could not be written: the turn fails, QA did not finish.
      if (this.state?.status === "running") {
        await this.settleState("aborted", errorMessage(error, "The turn ended during QA.")).catch(
          () => undefined,
        );
      }
      await this.finishSession();
      throw error;
    }
  }

  // ── The loop ───────────────────────────────────────────────────────────────

  private async execute(outcome: BackendPromptOutcome): Promise<BackendPromptOutcome> {
    const { deps } = this;
    const { signal } = deps;
    if (!qaApplies(deps.mode, deps.action)) return outcome;
    const { budget, preset } = deps.setup.execution;

    let current: string;
    try {
      current = await deps.qa.fingerprint(signal);
    } catch (error) {
      if (isAbort(signal, error)) return outcome;
      if (budget.qaPasses === 0) return outcome;
      return this.skip(
        outcome,
        `Render QA could not tell whether the project changed (${errorMessage(error, "Studio's QA service did not answer")}).`,
      );
    }
    if (deps.startFingerprint === null) {
      if (budget.qaPasses === 0) return outcome;
      return this.skip(
        outcome,
        "Render QA could not tell whether the project changed (Studio's QA service did not answer when the turn started).",
      );
    }
    if (current === deps.startFingerprint) {
      // Nothing changed — but a render this turn made of the project as it is (the user asked for a video file) is a
      // deliverable, and a deliverable is checked like any edit.
      const last = deps.renders.last();
      if (last === null || last.fingerprint !== current) return outcome;
      if (last.composition !== undefined) {
        // `composition: "index.html"` names the main composition explicitly; any other composition is not checked.
        const main = await deps.editing
          .timeline(undefined, signal)
          .then((snapshot) => snapshot.composition.path)
          .catch(() => null);
        if (last.composition !== main) return outcome;
      }
    }
    if (budget.qaPasses === 0) return this.skip(outcome, "Render QA is off");

    let duration: number;
    let composition: string;
    try {
      const snapshot = await deps.editing.timeline(undefined, signal);
      duration = snapshot.composition.duration;
      composition = snapshot.composition.path;
    } catch (error) {
      if (isAbort(signal, error)) return outcome;
      return this.skip(
        outcome,
        `Render QA could not read the timeline (${errorMessage(error, "the editing service did not answer")}).`,
      );
    }
    if (!deps.renders.asked() && duration > LONG_RENDER_SECONDS)
      return this.skip(outcome, tooLongReason(duration));

    this.state = {
      status: "running",
      preset,
      passLimit: budget.qaPasses,
      passes: [],
      reason: null,
    };
    await this.publish();
    // QA really runs: what the Director said so far is an interim note, the final report follows the check.
    await deps.director.markInterim();

    const history = {
      previous: [] as QaIssue[],
      fixed: new Map<string, QaIssue>(),
      reportId: null as string | null,
    };
    let lastRender: RenderedPass | null = null;
    let lastIssues: QaIssue[] = [];
    let lastVision: QaVisionRun | null = null;
    let lastRenderError: string | null = null;
    let corrections = 0;
    let end: { status: TurnQaStatus; reason: string | null } = {
      status: "issues_remain",
      reason: null,
    };
    let startFingerprint = current;
    const limit = budget.qaPasses;

    for (let pass = 1; pass <= limit; pass += 1) {
      if (pass > 1) {
        const blocked = await this.guard();
        if (blocked?.kind === "aborted") return this.abort();
        if (blocked) {
          end = {
            status: blocked.kind === "failed" ? "failed" : "issues_remain",
            reason: blocked.reason,
          };
          break;
        }
      }
      await this.startPass(pass);
      const result = await this.runPass({
        pass,
        limit,
        composition,
        history,
        startFingerprint,
        mayReuse: pass === 1,
      });
      if (result.kind === "aborted") return this.abort();
      if (result.kind === "failed") {
        end = { status: "failed", reason: result.reason };
        await this.endPass(pass, "failed", { error: result.reason });
        break;
      }

      const { report, issues, resolved, vision, render, renderError } = result;
      history.previous = issues;
      history.reportId = report.id;
      for (const fixed of resolved) history.fixed.set(fixed.id, fixed);
      for (const issue of issues) history.fixed.delete(issue.id);
      lastIssues = issues;
      lastVision = vision;
      lastRender = render ?? lastRender;
      lastRenderError = renderError;

      let decision: { status: TurnQaStatus; reason: string | null } | null = null;
      if (issues.length === 0) decision = { status: "passed", reason: null };
      else if (renderError && (pass === limit || deps.action === "rebuild"))
        decision = { status: "failed", reason: `The render failed: ${renderError}` };
      else if (!issues.some((issue) => issue.fixable))
        decision = { status: "issues_remain", reason: "No open issue can be fixed by an edit." };
      else if (pass === limit)
        decision = { status: "issues_remain", reason: "The pass limit was reached." };
      else if (deps.action === "rebuild")
        decision = {
          status: "issues_remain",
          reason:
            "A rebuild turn is report-only: only rebuild_story may change the timeline, so nothing was corrected.",
        };
      await this.endPass(pass, decision?.status === "failed" ? "failed" : "done", {
        reportId: report.id,
        renderPath: render?.path ?? null,
        counts: report.counts,
        vision: vision.status,
        error: renderError,
      });
      if (decision) {
        end = decision;
        break;
      }

      // Correction: the Director delegates the fixes; the next pass verifies them with a new render.
      await this.setPhase(pass, "correcting");
      corrections += 1;
      const correction = await this.correct({
        pass,
        limit,
        issues,
        resolved,
        render,
        renderError,
        vision,
      });
      if (correction === "aborted") return this.abort();
      await this.setPhase(pass, "corrected");

      let after: string;
      try {
        after = await deps.qa.fingerprint(signal);
      } catch (error) {
        if (isAbort(signal, error)) return this.abort();
        end = {
          status: "failed",
          reason: `QA could not read the project after the correction (${errorMessage(error, "Studio's QA service did not answer")}).`,
        };
        break;
      }
      if (after === report.fingerprint) {
        end = {
          status: "issues_remain",
          reason:
            "The correction changed nothing in the project, so QA stopped instead of repeating the same render.",
        };
        break;
      }
      startFingerprint = after;
    }

    try {
      await this.settleState(end.status, end.reason);
    } finally {
      await this.finishSession();
    }
    // The Director reports only now, after QA: no edit, delegation or render is allowed in this last prompt. What it
    // wrote while correcting ("fixed, re-checking now") is progress, not the answer.
    await deps.director.markInterim();
    deps.director.setPhase("final");
    try {
      const final = await deps.director.prompt(
        renderFinalPrompt({
          status: end.status,
          reason: end.reason,
          passes: this.state?.passes.length ?? 0,
          limit: budget.qaPasses,
          corrections,
          lastRender: lastRender
            ? { path: lastRender.path, duration: lastRender.duration, quality: lastRender.quality }
            : null,
          renderError: lastRenderError,
          vision: lastVision,
          open: lastIssues,
          fixed: [...history.fixed.values()],
          steering: deps.director.takeSteering(),
        }),
      );
      return await deps.director.settle(final);
    } finally {
      deps.director.setPhase(null);
    }
  }

  /**
   * Before a pass after a correction: the correction may have grown the composition past what QA renders unasked.
   * Null = go on.
   */
  private async guard(): Promise<
    { kind: "aborted" } | { kind: "failed" | "stopped"; reason: string } | null
  > {
    const { deps } = this;
    try {
      const snapshot = await deps.editing.timeline(undefined, deps.signal);
      if (!deps.renders.asked() && snapshot.composition.duration > LONG_RENDER_SECONDS)
        return { kind: "stopped", reason: tooLongReason(snapshot.composition.duration) };
      return null;
    } catch (error) {
      if (isAbort(deps.signal, error)) return { kind: "aborted" };
      return {
        kind: "failed",
        reason: `QA could not read the timeline (${errorMessage(error, "the editing service did not answer")}).`,
      };
    }
  }

  /** One render + check + review + report. */
  private async runPass(input: {
    pass: number;
    limit: number;
    composition: string;
    history: { previous: QaIssue[]; fixed: Map<string, QaIssue>; reportId: string | null };
    startFingerprint: string;
    /** The Director's own render may stand in for this pass's (only the first pass has one). */
    mayReuse: boolean;
  }): Promise<PassResult> {
    const { deps } = this;
    const { signal } = deps;
    const { budget, preset } = deps.setup.execution;
    const { pass, history } = input;

    // ── Render (or reuse the Director's own, when it shows the project as it is now) ──
    await this.setPhase(pass, "rendering");
    let rendered: RenderedPass | null = null;
    let renderError: string | null = null;
    try {
      rendered = await this.obtainRender(input.startFingerprint, input.mayReuse, input.composition);
    } catch (error) {
      if (isAbort(signal, error)) return { kind: "aborted" };
      renderError = errorMessage(error, "The render failed");
    }
    if (signal.aborted) return { kind: "aborted" };

    let check: QaCheckResponse | null = null;
    let vision: QaVisionRun = SKIPPED_VISION;
    let drafts: QaIssueDraft[];
    let checks: QaCheckRun[];
    if (!rendered) {
      const reason = renderError ?? "The render failed";
      drafts = [
        {
          kind: "render_failed",
          severity: "error",
          source: "render",
          check: "render",
          start: 0,
          end: 0,
          clipIds: [],
          subject: "render",
          message: `The composition could not be rendered: ${reason}`,
          fixable: true,
          owner: "editor",
          suggestion:
            "Inspect the timeline for what breaks the render (missing or unreadable files, invalid clips or a broken composition) and fix it.",
        },
      ];
      checks = [{ id: "render", status: "failed", detail: reason }];
      vision = { ...SKIPPED_VISION, reason: "The render failed, so there was nothing to review." };
    } else {
      await this.setPhase(pass, "checking");
      try {
        check = await deps.qa.check(
          {
            render: rendered.path,
            composition: input.composition,
            framesPerMinute: budget.qaFramesPerMinute,
            maxFrames: budget.qaMaxFrames,
          },
          signal,
        );
      } catch (error) {
        if (isAbort(signal, error)) return { kind: "aborted" };
        return {
          kind: "failed",
          reason: `The render checks failed (${errorMessage(error, "Studio's QA service did not answer")}).`,
        };
      }
      await this.setPhase(pass, "reviewing");
      const review = await this.review(pass, input.limit, rendered, check, history.previous);
      if (review === "aborted") return { kind: "aborted" };
      vision = review.vision;
      drafts = [...check.issues];
      for (const finding of review.findings) {
        if (!drafts.some((known) => sameQaIssue(known, finding))) drafts.push(finding);
      }
      checks = [
        ...check.checks.filter((entry) => entry.id !== "vision"),
        {
          id: "vision",
          status:
            vision.status === "ran"
              ? "ran"
              : vision.status === "failed"
                ? "failed"
                : vision.status === "unavailable"
                  ? "unavailable"
                  : "skipped",
          detail: vision.reason,
        },
      ];
    }
    if (signal.aborted) return { kind: "aborted" };

    const { issues, resolved } = compareQaPass({
      pass,
      drafts,
      previous: history.previous,
      fixedEarlier: [...history.fixed.values()],
    });
    const fingerprint = rendered?.fingerprint ?? input.startFingerprint;
    const report: QaReportInput = {
      sessionId: deps.turn.id,
      turnId: deps.turn.id,
      chatId: deps.chatId,
      pass,
      passLimit: input.limit,
      preset,
      composition: check?.composition ?? input.composition,
      fingerprint,
      timelineVersion: check?.timelineVersion ?? null,
      render: rendered && {
        path: rendered.path,
        duration: rendered.duration,
        width: rendered.width,
        height: rendered.height,
        hasAudio: rendered.hasAudio,
        quality: rendered.quality,
        origin: rendered.origin,
      },
      renderError,
      checks,
      vision,
      issues,
      resolved,
      previousReportId: history.reportId,
    };
    let saved: QaReport;
    try {
      saved = await deps.qa.saveReport(report, signal);
    } catch (error) {
      if (isAbort(signal, error)) return { kind: "aborted" };
      return {
        kind: "failed",
        reason: `The QA report could not be stored (${errorMessage(error, "Studio's QA service did not answer")}).`,
      };
    }
    return {
      kind: "reported",
      report: saved,
      issues,
      resolved,
      vision,
      render: rendered,
      renderError,
    };
  }

  /**
   * The render of a pass. Pass 1 reuses the Director's own render when it was made from the project as it is now
   * (nothing changed since it started); otherwise the composition is rendered in draft quality — or, when the user
   * asked for a render or the Director itself rendered a deliverable in this turn, in the quality of the Director's
   * last render (else standard), so a correction never downgrades the file the user gets.
   */
  private async obtainRender(
    startFingerprint: string,
    mayReuse: boolean,
    composition: string,
  ): Promise<RenderedPass> {
    const { deps } = this;
    const { signal } = deps;
    const last = deps.renders.last();
    if (
      mayReuse &&
      last &&
      (last.composition === undefined || last.composition === composition) &&
      last.fingerprint === startFingerprint
    ) {
      try {
        const media = await deps.editing.probe(last.path, signal);
        if (media.duration && media.width && media.height) {
          this.latestRender = last.path;
          return {
            path: last.path,
            duration: media.duration,
            width: media.width,
            height: media.height,
            hasAudio: media.hasAudio ?? null,
            quality: last.quality,
            fingerprint: startFingerprint,
            origin: "turn",
          };
        }
      } catch (error) {
        if (isAbort(signal, error)) throw error;
        // The file cannot be read any more: render again.
      }
    }
    const quality: RenderQuality = last
      ? last.quality
      : deps.renders.asked()
        ? "standard"
        : "draft";
    const fingerprint = startFingerprint;
    const output = await deps.editing.render({ quality }, signal, () => undefined);
    this.produced.push(output.path);
    this.latestRender = output.path;
    return {
      path: output.path,
      duration: output.duration,
      width: output.width,
      height: output.height,
      hasAudio: output.hasAudio,
      quality,
      fingerprint,
      origin: "qa",
    };
  }

  /** Vision's review of the render; `"aborted"` when the turn was stopped during it. */
  private async review(
    pass: number,
    limit: number,
    rendered: RenderedPass,
    check: QaCheckResponse,
    previous: readonly QaIssue[],
  ): Promise<{ vision: QaVisionRun; findings: QaIssueDraft[] } | "aborted"> {
    const { deps } = this;
    const { budget } = deps.setup.execution;
    const none = (status: QaVisionRun["status"], reason: string) => ({
      vision: { status, reason, frames: 0, rounds: 0, model: null },
      findings: [] as QaIssueDraft[],
    });
    if (!deps.setup.enabled.includes("vision"))
      return none("unavailable", "Vision is not enabled in this chat.");
    const samples = check.samples.slice(0, budget.qaMaxFrames);
    if (samples.length === 0) return none("skipped", "The checks planned no frame to look at.");

    deps.qa.openReview({
      pass,
      render: rendered.path,
      duration: rendered.duration,
      samples,
      maxFrames: budget.qaMaxFrames,
      critiqueRounds: budget.critiqueRounds,
    });
    let run: RuntimeRunResult | null = null;
    let failure: string | null = null;
    try {
      run = await deps.orchestrator.runInternal({
        agent: "vision",
        title: `Render QA · pass ${pass}`,
        task: renderVisionTask({
          pass,
          limit,
          render: rendered.path,
          composition: check.composition,
          duration: rendered.duration,
          samples,
          deterministic: check.issues,
          previousVision: previous.filter((issue) => issue.source === "vision"),
          budget,
        }),
      });
    } catch (error) {
      failure = errorMessage(error, "Vision could not start");
    }
    const closed = deps.qa.closeReview();
    if (deps.signal.aborted) return "aborted";
    const base = { frames: closed.frames, rounds: closed.rounds, model: run?.model ?? null };
    if (failure !== null)
      return { vision: { status: "failed", reason: failure, ...base }, findings: [] };
    if (run && run.status !== "completed") {
      const why = run.error ?? `The run ${run.status}.`;
      return {
        vision: {
          status: "failed",
          reason: closed.reported
            ? `Vision's run failed after reporting its findings (${why}).`
            : `Vision's run failed (${why}).`,
          ...base,
        },
        findings: closed.findings,
      };
    }
    if (!closed.reported) {
      return {
        vision: {
          status: "failed",
          reason: "Vision finished without reporting any findings, so its review did not count.",
          ...base,
        },
        findings: [],
      };
    }
    return { vision: { status: "ran", reason: null, ...base }, findings: closed.findings };
  }

  /** The Director's correction turn: prompt, then collect the delegated runs like after its first reply. */
  private async correct(input: {
    pass: number;
    limit: number;
    issues: QaIssue[];
    resolved: QaIssue[];
    render: RenderedPass | null;
    renderError: string | null;
    vision: QaVisionRun;
  }): Promise<"done" | "aborted"> {
    const { deps } = this;
    deps.director.setPhase("correction");
    try {
      const prompt = renderCorrectionPrompt({
        pass: input.pass,
        limit: input.limit,
        render: input.render && { path: input.render.path, duration: input.render.duration },
        renderError: input.renderError,
        vision: input.vision,
        issues: input.issues,
        resolved: input.resolved,
        enabled: deps.setup.enabled,
        steering: deps.director.takeSteering(),
      });
      const outcome = await deps.director.settle(await deps.director.prompt(prompt));
      return outcome === "aborted" || deps.signal.aborted ? "aborted" : "done";
    } finally {
      deps.director.setPhase(null);
    }
  }

  // ── State ──────────────────────────────────────────────────────────────────

  private async skip(outcome: BackendPromptOutcome, reason: string): Promise<BackendPromptOutcome> {
    const { budget, preset } = this.deps.setup.execution;
    this.state = {
      status: "skipped",
      preset,
      passLimit: budget.qaPasses,
      passes: [],
      reason,
    };
    await this.publish();
    if (!this.deps.instructed || outcome !== "completed" || this.deps.signal.aborted)
      return outcome;
    // The Director promised a check that is not coming: its reply so far is interim, the final answer follows now.
    const { director } = this.deps;
    await director.markInterim();
    director.setPhase("final");
    try {
      const final = await director.prompt(renderSkippedPrompt(reason, director.takeSteering()));
      return await director.settle(final);
    } finally {
      director.setPhase(null);
    }
  }

  private async abort(): Promise<BackendPromptOutcome> {
    const state = this.state;
    if (state) {
      const now = this.deps.now();
      for (const pass of state.passes) {
        if (pass.phase === "done" || pass.phase === "corrected" || pass.phase === "failed")
          continue;
        pass.phase = "aborted";
        pass.endedAt = now;
      }
    }
    try {
      await this.settleState("aborted", "The turn was stopped while Render QA was running.");
    } finally {
      await this.finishSession();
    }
    return "aborted";
  }

  /**
   * Ends the QA session on the service once: its intermediate QA previews go, the latest successful render stays (the
   * deliverable the final report names) and so does any render of the Director's own. Best-effort: the turn's
   * outcome never depends on it (see `TurnQa.finishSession`), and it runs even after the turn was stopped.
   */
  private async finishSession(): Promise<void> {
    if (this.finished || !this.state || this.state.passes.length === 0) return;
    this.finished = true;
    await this.deps.qa.finishSession(this.deps.turn.id, {
      keep: this.latestRender,
      ...(this.produced.length > 0 && { produced: [...this.produced] }),
    });
  }

  private async settleState(status: TurnQaStatus, reason: string | null): Promise<void> {
    if (!this.state) return;
    this.state.status = status;
    this.state.reason = reason;
    await this.publish();
  }

  private pass(number: number): QaPassState | undefined {
    return this.state?.passes.find((entry) => entry.pass === number);
  }

  private async startPass(number: number): Promise<void> {
    this.state?.passes.push({
      pass: number,
      phase: "rendering",
      reportId: null,
      renderPath: null,
      counts: null,
      vision: null,
      error: null,
      startedAt: this.deps.now(),
    });
    await this.publish();
  }

  private async setPhase(number: number, phase: QaPassPhase): Promise<void> {
    const pass = this.pass(number);
    if (!pass) return;
    pass.phase = phase;
    await this.publish();
  }

  private async endPass(
    number: number,
    phase: QaPassPhase,
    details: Partial<Pick<QaPassState, "reportId" | "renderPath" | "counts" | "vision" | "error">>,
  ): Promise<void> {
    const pass = this.pass(number);
    if (!pass) return;
    Object.assign(pass, details, { phase, endedAt: this.deps.now() });
    await this.publish();
  }

  /** Keeps the live turn's QA current and tells the chat. */
  private async publish(): Promise<void> {
    const { state } = this;
    if (!state) return;
    const qa = structuredClone(state);
    this.deps.turn.qa = qa;
    await this.deps.chats.emit(this.deps.chatId, {
      type: "qa.updated",
      turnId: this.deps.turn.id,
      qa,
    });
  }
}
