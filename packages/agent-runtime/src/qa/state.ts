import type {
  ExecutionQualityPreset,
  QaPassPhase,
  QaPassProgress,
  QaPassState,
  TurnQaState,
  TurnQaStatus,
} from "@hyperframes/agent-protocol";
import type { QaLoopDeps } from "./deps.js";

/** A render's progress is published when it moved this many percent, or this long after the last publication. */
const PROGRESS_STEP = 3;
const PROGRESS_INTERVAL_MS = 1000;

/** What a pass records when it ends. */
export type PassDetails = Partial<
  Pick<
    QaPassState,
    "reportId" | "renderPath" | "counts" | "vision" | "error" | "scope" | "scopeNote" | "suppressed"
  >
>;

/**
 * The turn's QA state as the chat sees it: it owns the live `TurnQaState`, keeps the turn record current and emits
 * `qa.updated`. Publications are serialized so a slow one never lands after a newer one.
 */
export class QaStateTracker {
  state: TurnQaState | null = null;
  private tail: Promise<unknown> = Promise.resolve();
  private lastProgress: { percent: number; at: number } | null = null;

  constructor(private readonly deps: Pick<QaLoopDeps, "chats" | "chatId" | "turn" | "now">) {}

  /** QA runs: the state is `running` with no pass yet. */
  async begin(preset: ExecutionQualityPreset, passLimit: number): Promise<void> {
    this.state = { status: "running", preset, passLimit, passes: [], reason: null };
    await this.publish();
  }

  /** QA did not run. */
  async skipped(preset: ExecutionQualityPreset, passLimit: number, reason: string): Promise<void> {
    this.state = { status: "skipped", preset, passLimit, passes: [], reason };
    await this.publish();
  }

  get passCount(): number {
    return this.state?.passes.length ?? 0;
  }

  pass(number: number): QaPassState | undefined {
    return this.state?.passes.find((entry) => entry.pass === number);
  }

  async startPass(number: number): Promise<void> {
    this.lastProgress = null;
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

  async setPhase(number: number, phase: QaPassPhase): Promise<void> {
    const pass = this.pass(number);
    if (!pass) return;
    pass.phase = phase;
    if (phase !== "rendering") delete pass.progress;
    await this.publish();
  }

  /** What the pass checks and why (also what the turn's QA reports as its scope). */
  async setScope(number: number, details: Pick<PassDetails, "scope" | "scopeNote">): Promise<void> {
    const pass = this.pass(number);
    if (!pass || !this.state) return;
    Object.assign(pass, details);
    if (details.scope) this.state.scope = details.scope;
    await this.publish();
  }

  /** Render progress of a pass: published when it moved enough or enough time passed, never flooding the chat. */
  progress(number: number, progress: QaPassProgress): void {
    const pass = this.pass(number);
    if (!pass || pass.phase !== "rendering") return;
    const percent = Math.max(0, Math.min(100, Math.round(progress.percent)));
    const now = this.deps.now();
    const last = this.lastProgress;
    if (
      last &&
      percent < 100 &&
      percent - last.percent < PROGRESS_STEP &&
      now - last.at < PROGRESS_INTERVAL_MS
    )
      return;
    this.lastProgress = { percent, at: now };
    pass.progress = { percent, stage: progress.stage };
    void this.publish().catch(() => undefined);
  }

  async endPass(number: number, phase: QaPassPhase, details: PassDetails): Promise<void> {
    const pass = this.pass(number);
    if (!pass) return;
    Object.assign(pass, details, { phase, endedAt: this.deps.now() });
    delete pass.progress;
    await this.publish();
  }

  /** A pass that did not finish when the turn was stopped. */
  abortOpenPasses(): void {
    const now = this.deps.now();
    for (const pass of this.state?.passes ?? []) {
      if (pass.phase === "done" || pass.phase === "corrected" || pass.phase === "failed") continue;
      pass.phase = "aborted";
      pass.endedAt = now;
      delete pass.progress;
    }
  }

  async settle(
    status: TurnQaStatus,
    reason: string | null,
    reasonCode?: string,
    reasonParams?: Record<string, string | number>,
  ): Promise<void> {
    if (!this.state) return;
    this.state.status = status;
    this.state.reason = reason;
    if (reasonCode !== undefined) this.state.reasonCode = reasonCode;
    if (reasonParams !== undefined) this.state.reasonParams = reasonParams;
    await this.publish();
  }

  /** The session ended: which passes' renders are still in the project (the rest were QA's own previews). */
  async markKept(removed: readonly string[]): Promise<void> {
    if (!this.state) return;
    for (const pass of this.state.passes) {
      if (pass.renderPath !== null) pass.renderKept = !removed.includes(pass.renderPath);
    }
    await this.publish();
  }

  /** Keeps the live turn's QA current and tells the chat. */
  publish(): Promise<unknown> {
    const { state } = this;
    if (!state) return Promise.resolve();
    const qa = structuredClone(state);
    this.deps.turn.qa = qa;
    const next = this.tail
      .catch(() => undefined)
      .then(() =>
        this.deps.chats.emit(this.deps.chatId, {
          type: "qa.updated",
          turnId: this.deps.turn.id,
          qa,
        }),
      );
    this.tail = next;
    return next;
  }
}
