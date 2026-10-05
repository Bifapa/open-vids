import type { AgentRun, ExecutionPlan, PlanStepStatus } from "@hyperframes/agent-protocol";
import type { HostToolResult } from "../backend.js";
import { autoPlan } from "./autoPlan.js";
import type { OrchestratorDeps } from "./orchestrator.js";
import { done, refuse } from "./runRecord.js";
import { parsePlanArgs, parseProposalArgs } from "./toolArgs.js";

type PlanDeps = Pick<
  OrchestratorDeps,
  "chats" | "chatId" | "turn" | "now" | "signal" | "projectFingerprint"
>;

/**
 * The plan of a Director turn: the one the Director publishes (`update_plan`), the proposal it makes when the user
 * decides first (`propose_plan`), and — until the Director publishes its own — the compact plan derived from its runs.
 */
export class PlanKeeper {
  /** The Director published its own plan; the automatic run-based plan stops. */
  private planned = false;
  /** The plan is a proposal awaiting the user's approval ("Carry out the plan"); project-changing tools refuse. */
  private proposal = false;
  private fingerprint: string | null = null;
  /** The automatic plan's final step once the turn has ended. */
  private assembled: PlanStepStatus | null = null;

  constructor(private readonly deps: PlanDeps) {}

  /** The turn ended: the automatic plan's last step closes accordingly. */
  close(completed: boolean): void {
    this.assembled = completed ? "done" : "skipped";
  }

  async propose(args: unknown): Promise<HostToolResult> {
    const parsed = parseProposalArgs(args);
    if (!parsed.ok) return refuse(parsed.message);
    this.fingerprint =
      (await this.deps.projectFingerprint?.(this.deps.signal).catch(() => null)) ?? null;
    const plan: ExecutionPlan = {
      steps: parsed.value.steps.map((step, index) => ({
        id: `step-${index + 1}`,
        ...step,
        status: "pending",
      })),
      updatedAt: this.deps.now(),
      proposal: true,
      ...(this.fingerprint && { projectFingerprint: this.fingerprint }),
    };
    this.planned = true;
    this.proposal = true;
    await this.publish(plan);
    return done(
      "Plan proposed: the user decides. The project-changing tools are unavailable for the rest of this turn — end it with a short summary of the plan and stop.",
    );
  }

  async update(args: unknown): Promise<HostToolResult> {
    const parsed = parsePlanArgs(args);
    if (!parsed.ok) return refuse(parsed.message);
    const plan: ExecutionPlan = {
      steps: parsed.value.steps.map((step, index) => ({ id: `step-${index + 1}`, ...step })),
      updatedAt: this.deps.now(),
      // A plan published after the proposal is still the proposal: the user's buttons stay until a new turn runs.
      ...(this.proposal && {
        proposal: true,
        ...(this.fingerprint && { projectFingerprint: this.fingerprint }),
      }),
    };
    this.planned = true;
    await this.publish(plan);
    return done("Plan updated.");
  }

  /**
   * Normal mode always shows a compact plan once work is delegated: one step per run the Director started plus the
   * final assembly step. Runs the runtime started itself (a Render QA review) are not steps of the user's plan.
   */
  async sync(runs: readonly AgentRun[]): Promise<void> {
    if (this.planned) return;
    const plan = autoPlan(runs, this.assembled, this.deps.now());
    if (plan) await this.publish(plan);
  }

  private async publish(plan: ExecutionPlan): Promise<void> {
    this.deps.turn.plan = plan;
    await this.deps.chats.emit(this.deps.chatId, {
      type: "plan.updated",
      turnId: this.deps.turn.id,
      plan,
    });
  }
}
