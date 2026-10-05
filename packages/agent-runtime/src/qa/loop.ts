import type {
  QaIssue,
  QaScope,
  QaScopeNote,
  QaVisionRun,
  TimelineSnapshot,
  TurnQaStatus,
} from "@hyperframes/agent-protocol";
import type { BackendPromptOutcome } from "../backend.js";
import { LONG_RENDER_SECONDS } from "../editing/renderGuard.js";
import { errorMessage } from "../errors.js";
import { summarizeChange, visionSkipReason } from "./changeScope.js";
import { qaApplies, type QaLoopDeps } from "./deps.js";
import {
  QaPassRunner,
  tooLongNote,
  type PassHistory,
  type PassPlan,
  type QaRunSession,
  type RenderedPass,
} from "./pass.js";
import {
  renderCorrectionPrompt,
  renderFinalPrompt,
  renderSkippedPrompt,
  renderUnchangedPrompt,
} from "./prompt.js";
import { QaStateTracker } from "./state.js";

export { qaApplies } from "./deps.js";
export type { QaDirector, QaLoopDeps, QaPhase } from "./deps.js";

/** How a QA loop ended: the English `reason` plus the `qa.reason.<reasonCode>` key the chat translates it by. */
interface QaEnd {
  status: TurnQaStatus;
  reason: string | null;
  reasonCode?: string;
  reasonParams?: Record<string, string | number>;
}

const isAbort = (signal: AbortSignal, error: unknown): boolean =>
  signal.aborted ||
  (typeof error === "object" && error !== null && "code" in error && error.code === "aborted");

type Planned =
  | { kind: "plan"; plan: PassPlan }
  | { kind: "aborted" }
  | { kind: "unreadable"; reason: string };

/**
 * Autonomous render QA of one turn: render → deterministic checks + the visual review → compare with the previous pass →
 * store the report → (if fixable issues remain and passes are left) a Director correction → the next pass. At most
 * `qaPasses` renders, so at most `qaPasses − 1` corrections; a correction that changes nothing ends the loop.
 * A pass checks only as much as it needs: a composition too long to render unasked gets the timeline checks, and a
 * re-check after a small or audio-only change skips the visual review. Afterwards the Director gets one final prompt to
 * report, during which the runner refuses every change.
 */
export class QaLoop {
  private readonly tracker: QaStateTracker;
  private readonly session: QaRunSession = { produced: [], latestRender: null };
  /** The timeline of the last pass that was planned: what the next pass's change is measured against. */
  private checkedTimeline: TimelineSnapshot | null = null;
  private finished = false;

  constructor(private readonly deps: QaLoopDeps) {
    this.tracker = new QaStateTracker(deps);
  }

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
      if (this.tracker.state?.status === "running") {
        await this.tracker
          .settle("aborted", errorMessage(error, "The turn ended during QA."))
          .catch(() => undefined);
      }
      await this.finishSession();
      throw error;
    }
  }

  // ── The loop ───────────────────────────────────────────────────────────────

  private async execute(outcome: BackendPromptOutcome): Promise<BackendPromptOutcome> {
    const { deps, tracker } = this;
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
      if (last === null || last.fingerprint !== current) return this.closeUnchanged(outcome);
      if (last.composition !== undefined) {
        // `composition: "index.html"` names the main composition explicitly; any other composition is not checked.
        const main = await deps.editing
          .timeline(undefined, signal)
          .then((snapshot) => snapshot.composition.path)
          .catch(() => null);
        if (last.composition !== main)
          return this.closeUnchanged(outcome, { composition: last.composition, path: last.path });
      }
    }
    if (budget.qaPasses === 0) return this.skip(outcome, "Render QA is off");

    const history: PassHistory = { previous: [], fixed: new Map(), reportId: null };
    const first = await this.plan(1, budget.qaPasses, current, history);
    if (first.kind === "aborted") return outcome;
    if (first.kind === "unreadable") return this.skip(outcome, first.reason);

    await tracker.begin(preset, budget.qaPasses);
    // QA really runs: what the Director said so far is an interim note, the final report follows the check.
    await deps.director.markInterim();

    const runner = new QaPassRunner(deps, tracker, this.session);
    let lastRender: RenderedPass | null = null;
    let lastIssues: QaIssue[] = [];
    let lastVision: QaVisionRun | null = null;
    let lastRenderError: string | null = null;
    let lastScope: QaScope | null = null;
    let lastScopeNote: QaScopeNote | null = null;
    let lastSuppressed = 0;
    let corrections = 0;
    let end: QaEnd = { status: "issues_remain", reason: null };
    let startFingerprint = current;
    const limit = budget.qaPasses;
    let planned: Planned = first;

    for (let pass = 1; pass <= limit; pass += 1) {
      if (pass > 1) {
        planned = await this.plan(pass, limit, startFingerprint, history);
        if (planned.kind === "aborted") return this.abort();
        if (planned.kind === "unreadable") {
          end = { status: "failed", reason: planned.reason };
          break;
        }
      }
      if (planned.kind !== "plan") return this.abort();
      await tracker.startPass(pass);
      const result = await runner.run(planned.plan, history);
      if (result.kind === "aborted") return this.abort();
      if (result.kind === "failed") {
        end = {
          status: "failed",
          reason: result.reason,
          ...(result.reasonCode !== undefined && { reasonCode: result.reasonCode }),
          ...(result.reasonParams !== undefined && { reasonParams: result.reasonParams }),
        };
        await tracker.endPass(pass, "failed", { error: result.reason });
        break;
      }

      const {
        report,
        issues,
        resolved,
        vision,
        render,
        renderError,
        scope,
        scopeNote,
        suppressed,
      } = result;
      history.previous = issues;
      history.reportId = report.id;
      for (const fixed of resolved) history.fixed.set(fixed.id, fixed);
      for (const issue of issues) history.fixed.delete(issue.id);
      lastIssues = issues;
      lastVision = vision;
      lastRender = render ?? lastRender;
      lastRenderError = renderError;
      lastScope = scope;
      lastScopeNote = scopeNote;
      lastSuppressed = suppressed;

      const decision = this.decide({ pass, limit, issues, renderError });
      await tracker.endPass(pass, decision?.status === "failed" ? "failed" : "done", {
        reportId: report.id,
        renderPath: render?.path ?? null,
        counts: report.counts,
        vision: vision.status,
        error: renderError,
        scope,
        ...(scopeNote && { scopeNote }),
        suppressed,
      });
      if (decision) {
        end = decision;
        break;
      }

      // Correction: the Director delegates the fixes; the next pass verifies them with a new render.
      await tracker.setPhase(pass, "correcting");
      corrections += 1;
      const correction = await this.correct({
        pass,
        limit,
        issues,
        resolved,
        render,
        renderError,
        vision,
        scope,
        scopeNote,
        suppressed,
      });
      if (correction === "aborted") return this.abort();
      await tracker.setPhase(pass, "corrected");

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
          reasonCode: "correction_no_change",
        };
        break;
      }
      startFingerprint = after;
    }

    try {
      await tracker.settle(end.status, end.reason, end.reasonCode, end.reasonParams);
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
          passes: tracker.passCount,
          limit: budget.qaPasses,
          corrections,
          lastRender: lastRender
            ? { path: lastRender.path, duration: lastRender.duration, quality: lastRender.quality }
            : null,
          renderError: lastRenderError,
          vision: lastVision,
          scope: lastScope,
          scopeNote: lastScopeNote,
          suppressed: lastSuppressed,
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
   * What the pass after `history` is to check: the composition's length decides whether it is rendered (a composition
   * over the long-render limit is checked on the timeline alone unless the user asked for a render), and how much the
   * project changed since the last check decides whether the visual review is needed.
   */
  private async plan(
    pass: number,
    limit: number,
    startFingerprint: string,
    history: PassHistory,
  ): Promise<Planned> {
    const { deps } = this;
    let snapshot: TimelineSnapshot;
    try {
      snapshot = await deps.editing.timeline(undefined, deps.signal);
    } catch (error) {
      if (isAbort(deps.signal, error)) return { kind: "aborted" };
      return {
        kind: "unreadable",
        reason:
          pass === 1
            ? `Render QA could not read the timeline (${errorMessage(error, "the editing service did not answer")}).`
            : `QA could not read the timeline (${errorMessage(error, "the editing service did not answer")}).`,
      };
    }
    const { duration, path } = snapshot.composition;
    const timelineOnly =
      !deps.renders.asked() && duration > LONG_RENDER_SECONDS ? tooLongNote(duration) : null;
    const base = pass === 1 ? deps.startTimeline : this.checkedTimeline;
    this.checkedTimeline = snapshot;

    // A visual issue still waiting for its re-check needs the review, whatever the change was.
    const waiting = history.previous.some(
      (issue) => issue.source === "vision" && issue.fixable && issue.notRechecked !== true,
    );
    let visionSkip: QaScopeNote | null = null;
    if (!timelineOnly && !waiting && base) {
      const change = summarizeChange(base, snapshot);
      const reason = visionSkipReason(change);
      if (reason === "audio_only") {
        visionSkip = {
          code: "audio_only",
          message:
            "Only audio changed since the last check, so the visual review was skipped (the picture is the same); the render's deterministic checks still ran.",
        };
      } else if (reason === "small_change" && change) {
        visionSkip = {
          code: "small_change",
          message: `Only ${change.retimed} existing ${change.retimed === 1 ? "clip was" : "clips were"} retimed since the last check, so the visual review was skipped; the render's deterministic checks still ran.`,
          params: { count: change.retimed },
        };
      }
    }
    return {
      kind: "plan",
      plan: {
        pass,
        limit,
        composition: path,
        startFingerprint,
        mayReuse: pass === 1,
        timelineOnly,
        visionSkip,
      },
    };
  }

  /** Whether the pass ends QA, and how. Null: a correction follows. */
  private decide(input: {
    pass: number;
    limit: number;
    issues: readonly QaIssue[];
    renderError: string | null;
  }): QaEnd | null {
    const { pass, limit, issues, renderError } = input;
    if (issues.length === 0) return { status: "passed", reason: null };
    if (renderError && (pass === limit || this.deps.action === "rebuild"))
      return {
        status: "failed",
        reason: `The render failed: ${renderError}`,
        reasonCode: "render_failed",
        reasonParams: { reason: renderError },
      };
    if (!issues.some((issue) => issue.fixable))
      return issues.every((issue) => issue.notRechecked === true)
        ? {
            status: "issues_remain",
            reason:
              "Issues reported earlier could not be re-checked in this pass, so nothing was corrected.",
            reasonCode: "not_rechecked",
          }
        : {
            status: "issues_remain",
            reason: "No open issue can be fixed by an edit.",
            reasonCode: "no_fixable_issues",
          };
    if (pass === limit)
      return {
        status: "issues_remain",
        reason: "The pass limit was reached.",
        reasonCode: "pass_limit",
      };
    if (this.deps.action === "rebuild")
      return {
        status: "issues_remain",
        reason:
          "A rebuild turn is report-only: only rebuild_story may change the timeline, so nothing was corrected.",
        reasonCode: "rebuild_report_only",
      };
    return null;
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
    scope: QaScope;
    scopeNote: QaScopeNote | null;
    suppressed: number;
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
        scope: input.scope,
        scopeNote: input.scopeNote,
        suppressed: input.suppressed,
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
    await this.tracker.skipped(preset, budget.qaPasses, reason);
    return this.closeInterim(outcome, (steering) => renderSkippedPrompt(reason, steering));
  }

  /**
   * The turn changed nothing that QA checks, so no check follows. A Director that tried to change the project (an edit
   * that did not land, a teammate whose work did not land) or rendered something may have promised one or reported
   * success: it owes a closing answer. A turn that only talked or read gets nothing extra. `unchecked` names a render
   * the Director made of a composition QA does not check.
   */
  private async closeUnchanged(
    outcome: BackendPromptOutcome,
    unchecked: { composition: string; path: string } | null = null,
  ): Promise<BackendPromptOutcome> {
    if (!this.deps.workAttempted()) return outcome;
    return this.closeInterim(outcome, (steering) => renderUnchangedPrompt(steering, unchecked));
  }

  /**
   * The Director promised a check that is not coming: its reply so far is interim, the final answer follows now. Only
   * a Director that was told a check would follow (and finished normally) is asked; the user's steering is taken only
   * once the prompt is going out, so it is never lost with a prompt that is not sent.
   */
  private async closeInterim(
    outcome: BackendPromptOutcome,
    buildPrompt: (steering: readonly string[]) => string,
  ): Promise<BackendPromptOutcome> {
    if (!this.deps.instructed || outcome !== "completed" || this.deps.signal.aborted)
      return outcome;
    const { director } = this.deps;
    await director.markInterim();
    director.setPhase("final");
    try {
      return await director.settle(await director.prompt(buildPrompt(director.takeSteering())));
    } finally {
      director.setPhase(null);
    }
  }

  private async abort(): Promise<BackendPromptOutcome> {
    this.tracker.abortOpenPasses();
    try {
      await this.tracker.settle("aborted", "The turn was stopped while Render QA was running.");
    } finally {
      await this.finishSession();
    }
    return "aborted";
  }

  /**
   * Ends the QA session on the service once: its intermediate QA previews go, the latest successful render stays (the
   * deliverable the final report names) and so does any render of the Director's own. Best-effort: the turn's
   * outcome never depends on it (see `TurnQa.finishSession`), and it runs even after the turn was stopped. What the
   * service deleted tells the card which passes' renders are still there.
   */
  private async finishSession(): Promise<void> {
    if (this.finished || this.tracker.state === null || this.tracker.passCount === 0) return;
    this.finished = true;
    const { produced, latestRender } = this.session;
    const response = await this.deps.qa.finishSession(this.deps.turn.id, {
      keep: latestRender,
      ...(produced.length > 0 && { produced: [...produced] }),
    });
    if (response) await this.tracker.markKept(response.removedRenders).catch(() => undefined);
  }
}
