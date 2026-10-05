import {
  QA_LIMITS,
  compareQaPass,
  findAcceptedQaIssue,
  sameQaIssue,
  type QaAcceptedIssue,
  type QaCheckResponse,
  type QaCheckRun,
  type QaIssue,
  type QaIssueDraft,
  type QaIssueSource,
  type QaRenderOrigin,
  type QaReport,
  type QaReportInput,
  type QaScope,
  type QaScopeNote,
  type QaVisionRun,
} from "@hyperframes/agent-protocol";
import type { RenderQuality } from "../editing/host.js";
import { errorMessage } from "../errors.js";
import type { QaLoopDeps } from "./deps.js";
import { QaToolError } from "./host.js";
import { classifyRenderFailure } from "./renderFailure.js";
import { noReview, reviewRender } from "./review.js";
import type { QaStateTracker } from "./state.js";

/** What the session has rendered so far: what cleanup may delete, and what the final report names. */
export interface QaRunSession {
  /** Previews this session rendered itself (never the Director's own render pass 1 reuses), in order. */
  produced: string[];
  /** The latest render of the session that succeeded. */
  latestRender: string | null;
}

export interface RenderedPass {
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

export interface PassHistory {
  previous: QaIssue[];
  fixed: Map<string, QaIssue>;
  reportId: string | null;
}

/** What one pass is to check, decided by the loop from the composition's length and what changed. */
export interface PassPlan {
  pass: number;
  limit: number;
  composition: string;
  startFingerprint: string;
  /** The Director's own render may stand in for this pass's (only the first pass has one). */
  mayReuse: boolean;
  /** Set: nothing is rendered; only the timeline is checked (why is in the note). */
  timelineOnly: QaScopeNote | null;
  /** Set: the render is checked deterministically and the visual review is skipped (why is in the note). */
  visionSkip: QaScopeNote | null;
}

export type PassResult =
  | { kind: "aborted" }
  | {
      kind: "failed";
      reason: string;
      reasonCode?: string;
      reasonParams?: Record<string, string | number>;
    }
  | {
      kind: "reported";
      report: QaReport;
      issues: QaIssue[];
      resolved: QaIssue[];
      vision: QaVisionRun;
      render: RenderedPass | null;
      renderError: string | null;
      scope: QaScope;
      scopeNote: QaScopeNote | null;
      suppressed: number;
    };

export const SKIPPED_VISION: QaVisionRun = {
  status: "skipped",
  reason: null,
  frames: 0,
  rounds: 0,
  model: null,
};

const SEVERITY_RANK: Record<QaIssueDraft["severity"], number> = { error: 0, warning: 1, info: 2 };

/**
 * The service refuses a report with more than `QA_LIMITS.issues` issues. The checks alone may reach that cap and Vision
 * adds its findings on top, so past the cap the most severe issues are kept (stable within a severity: checks first,
 * then Vision's findings).
 */
function capQaDrafts(drafts: QaIssueDraft[]): QaIssueDraft[] {
  if (drafts.length <= QA_LIMITS.issues) return drafts;
  return drafts
    .map((draft, index) => ({ draft, index }))
    .sort(
      (a, b) =>
        SEVERITY_RANK[a.draft.severity] - SEVERITY_RANK[b.draft.severity] || a.index - b.index,
    )
    .slice(0, QA_LIMITS.issues)
    .sort((a, b) => a.index - b.index)
    .map(({ draft }) => draft);
}

/**
 * The previous pass's issues this pass could not re-check (their source was not looked at: a visual review that did not
 * run, a render that was not made, checks that were skipped), as report-only drafts: they stay open instead of being
 * recorded as fixed, and never go to a correction. One that a draft of this pass already matches is not repeated.
 */
export function carryUnverified(
  previous: readonly QaIssue[],
  drafts: readonly QaIssueDraft[],
  verified: Readonly<Record<QaIssueSource, boolean>>,
): QaIssueDraft[] {
  return previous
    .filter(
      (issue) => !verified[issue.source] && !drafts.some((draft) => sameQaIssue(issue, draft)),
    )
    .map(
      (issue): QaIssueDraft => ({
        kind: issue.kind,
        severity: issue.severity,
        source: issue.source,
        check: issue.check,
        start: issue.start,
        end: issue.end,
        clipIds: issue.clipIds,
        subject: issue.subject,
        message: issue.message,
        fixable: false,
        owner: issue.owner,
        suggestion: issue.suggestion,
        notRechecked: true,
      }),
    );
}

const isAbort = (signal: AbortSignal, error: unknown): boolean =>
  signal.aborted ||
  (typeof error === "object" && error !== null && "code" in error && error.code === "aborted");

const minutes = (seconds: number): number => Number((seconds / 60).toFixed(1));

/** The note of a pass whose render checks ran out of time and fell back to the timeline. */
export function timeoutNote(): QaScopeNote {
  return {
    code: "check_timeout",
    message:
      "The render checks did not finish in time, so QA fell back to the timeline checks: the render itself was not measured.",
  };
}

/** The note of a composition too long to render unasked. */
export function tooLongNote(duration: number): QaScopeNote {
  return {
    code: "too_long",
    message: `The composition is ${minutes(duration)} minutes long and the user did not ask for a render, so QA checked the timeline without rendering it (a render that long takes many minutes). Ask for a render or an export to have it fully checked.`,
    params: { minutes: minutes(duration) },
  };
}

/** One render + check + review + report of a QA pass. */
export class QaPassRunner {
  constructor(
    private readonly deps: QaLoopDeps,
    private readonly tracker: QaStateTracker,
    private readonly session: QaRunSession,
  ) {}

  async run(plan: PassPlan, history: PassHistory): Promise<PassResult> {
    const { deps, tracker } = this;
    const { signal } = deps;
    const { preset } = deps.setup.execution;
    const { pass } = plan;

    let scope: QaScope = plan.timelineOnly
      ? "timeline"
      : plan.visionSkip
        ? "deterministic"
        : "full";
    let scopeNote: QaScopeNote | null = plan.timelineOnly ?? plan.visionSkip;
    await tracker.setScope(pass, { scope, ...(scopeNote && { scopeNote }) });

    // ── Render (or reuse the Director's own, when it shows the project as it is now) ──
    let rendered: RenderedPass | null = null;
    let renderError: string | null = null;
    if (!plan.timelineOnly) {
      await tracker.setPhase(pass, "rendering");
      try {
        rendered = await this.obtainRender(plan);
      } catch (error) {
        if (isAbort(signal, error)) return { kind: "aborted" };
        const failure = classifyRenderFailure(error);
        if (failure.kind === "environment") {
          return {
            kind: "failed",
            reason: `The render could not run (${failure.reason}). That comes from this machine or Studio, not from the project, so no edit can fix it.`,
            reasonCode: "render_environment",
            reasonParams: { reason: failure.reason },
          };
        }
        renderError = failure.reason;
      }
      if (signal.aborted) return { kind: "aborted" };
    }

    let check: QaCheckResponse | null = null;
    let vision: QaVisionRun = SKIPPED_VISION;
    let drafts: QaIssueDraft[];
    let checks: QaCheckRun[];
    let accepted: readonly QaAcceptedIssue[] = [];
    if (!plan.timelineOnly && !rendered) {
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
      vision = {
        ...SKIPPED_VISION,
        reason: "The render failed, so there was nothing to review.",
        reasonCode: "vision_render_failed",
      };
    } else {
      await tracker.setPhase(pass, "checking");
      const checked = await this.runChecks(plan, rendered);
      if (checked.kind !== "ok") return checked;
      check = checked.check;
      if (checked.degraded) {
        scope = "timeline";
        scopeNote = timeoutNote();
        await tracker.setScope(pass, { scope, scopeNote });
      }
      accepted = await this.loadAccepted();
      drafts = [...check.issues];
      if (scope === "timeline") {
        vision = noReview(
          "skipped",
          "Vision did not review: only the timeline was checked.",
          "vision_timeline_only",
        ).vision;
      } else if (plan.visionSkip && rendered) {
        vision = noReview(
          "skipped",
          plan.visionSkip.message,
          `vision_${plan.visionSkip.code}`,
        ).vision;
      } else if (rendered) {
        await tracker.setPhase(pass, "reviewing");
        const review = await reviewRender(deps, {
          pass,
          limit: plan.limit,
          render: rendered,
          check,
          previous: history.previous,
          accepted,
        });
        if (review === "aborted") return { kind: "aborted" };
        vision = review.vision;
        for (const finding of review.findings) {
          if (!drafts.some((known) => sameQaIssue(known, finding))) drafts.push(finding);
        }
      }
      checks = [
        ...check.checks.filter((entry) => entry.id !== "vision"),
        {
          id: "vision",
          status: vision.status,
          detail: vision.reason,
        },
      ];
      if (checked.degraded) checks = degradedChecks(checks);
    }
    if (signal.aborted) return { kind: "aborted" };

    // What this pass looked at: issues of anything it did not look at stay open as "not re-checked".
    const looked = rendered !== null && scope !== "timeline";
    const ran = (...ids: string[]): boolean =>
      ids.every((id) => {
        const entry = check?.checks.find((candidate) => candidate.id === id);
        return entry === undefined || entry.status === "ran" || entry.status === "skipped";
      });
    drafts.push(
      ...carryUnverified(history.previous, drafts, {
        render: looked && ran("black_frames", "frozen_frames", "audio"),
        layout: looked && ran("layout"),
        timeline: check !== null,
        vision: vision.status === "ran",
      }),
    );
    const kept = accepted.length
      ? drafts.filter(
          (draft) => !findAcceptedQaIssue(draft, check?.composition ?? plan.composition, accepted),
        )
      : drafts;
    const suppressed = drafts.length - kept.length;
    const open = capQaDrafts(kept);

    const { issues, resolved } = compareQaPass({
      pass,
      drafts: open,
      previous: history.previous,
      fixedEarlier: [...history.fixed.values()],
    });
    const report: QaReportInput = {
      sessionId: deps.turn.id,
      turnId: deps.turn.id,
      chatId: deps.chatId,
      pass,
      passLimit: plan.limit,
      preset,
      composition: check?.composition ?? plan.composition,
      fingerprint: rendered?.fingerprint ?? plan.startFingerprint,
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
      scope,
      ...(scopeNote && { scopeNote }),
      suppressed,
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
      scope,
      scopeNote,
      suppressed,
    };
  }

  /**
   * The checks of the pass: on the render (and the timeline), or on the timeline alone. A render check that runs out of
   * time falls back to the timeline checks instead of failing the pass (`degraded`).
   */
  private async runChecks(
    plan: PassPlan,
    rendered: RenderedPass | null,
  ): Promise<
    | { kind: "ok"; check: QaCheckResponse; degraded: boolean }
    | { kind: "aborted" }
    | { kind: "failed"; reason: string }
  > {
    const { deps } = this;
    const { signal } = deps;
    const { budget } = deps.setup.execution;
    const timelineOnly = () => deps.qa.checkTimeline({ composition: plan.composition }, signal);
    try {
      const check = rendered
        ? await deps.qa.check(
            {
              render: rendered.path,
              composition: plan.composition,
              framesPerMinute: budget.qaFramesPerMinute,
              maxFrames: budget.qaMaxFrames,
            },
            signal,
          )
        : await timelineOnly();
      return { kind: "ok", check, degraded: false };
    } catch (error) {
      if (isAbort(signal, error)) return { kind: "aborted" };
      if (rendered && error instanceof QaToolError && error.code === "timeout") {
        try {
          return { kind: "ok", check: await timelineOnly(), degraded: true };
        } catch (fallback) {
          if (isAbort(signal, fallback)) return { kind: "aborted" };
          return {
            kind: "failed",
            reason: `The render checks timed out and the timeline checks failed too (${errorMessage(fallback, "Studio's QA service did not answer")}).`,
          };
        }
      }
      return {
        kind: "failed",
        reason: `The render checks failed (${errorMessage(error, "Studio's QA service did not answer")}).`,
      };
    }
  }

  /** The issues the user marked intentional; an unreachable list means none (QA never fails for it). */
  private async loadAccepted(): Promise<readonly QaAcceptedIssue[]> {
    try {
      return (await this.deps.qa.accepted(this.deps.signal)).items;
    } catch {
      return [];
    }
  }

  /**
   * The render of a pass. Pass 1 reuses the Director's own render when it was made from the project as it is now
   * (nothing changed since it started); otherwise the composition is rendered in draft quality — or, when the user
   * asked for a render or the Director itself rendered a deliverable in this turn, in the quality of the Director's
   * last render (else standard), so a correction never downgrades the file the user gets.
   */
  private async obtainRender(plan: PassPlan): Promise<RenderedPass> {
    const { deps, session } = this;
    const { signal } = deps;
    const last = deps.renders.last();
    if (
      plan.mayReuse &&
      last &&
      (last.composition === undefined || last.composition === plan.composition) &&
      last.fingerprint === plan.startFingerprint
    ) {
      try {
        const media = await deps.editing.probe(last.path, signal);
        if (media.duration && media.width && media.height) {
          session.latestRender = last.path;
          return {
            path: last.path,
            duration: media.duration,
            width: media.width,
            height: media.height,
            hasAudio: media.hasAudio ?? null,
            quality: last.quality,
            fingerprint: plan.startFingerprint,
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
    const output = await deps.editing.render({ quality }, signal, (progress) =>
      this.tracker.progress(plan.pass, { percent: progress.progress, stage: progress.stage }),
    );
    session.produced.push(output.path);
    session.latestRender = output.path;
    return {
      path: output.path,
      duration: output.duration,
      width: output.width,
      height: output.height,
      hasAudio: output.hasAudio,
      quality,
      fingerprint: plan.startFingerprint,
      origin: "qa",
    };
  }
}

/** The render-measured checks of a pass whose checks timed out: they did not run, whatever the fallback said. */
function degradedChecks(checks: readonly QaCheckRun[]): QaCheckRun[] {
  return checks.map((entry) => {
    if (entry.id === "render")
      return {
        ...entry,
        status: "ran",
        detail: "The composition was rendered, but its render checks did not finish in time.",
      };
    if (["black_frames", "frozen_frames", "audio", "layout"].includes(entry.id))
      return {
        ...entry,
        status: "failed",
        detail: "The render checks did not finish in time; only the timeline was checked.",
      };
    return entry;
  });
}
