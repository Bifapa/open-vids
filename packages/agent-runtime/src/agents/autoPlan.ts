import {
  isAgentRunTerminal,
  type AgentRun,
  type AgentRunStatus,
  type ExecutionPlan,
  type PlanStepStatus,
} from "@hyperframes/agent-protocol";

const stepStatus = (status: AgentRunStatus): PlanStepStatus => {
  if (status === "queued") return "pending";
  if (status === "running") return "running";
  if (status === "completed") return "done";
  return status === "failed" ? "failed" : "skipped";
};

/**
 * The compact plan Normal mode shows once work is delegated, derived from the runs the Director started (one step per
 * run) plus the final assembly step. Runs the runtime started itself (a Render QA review) are not steps of the user's
 * plan. Null when the Director started nothing.
 */
export function autoPlan(
  runs: readonly AgentRun[],
  assembled: PlanStepStatus | null,
  now: number,
): ExecutionPlan | null {
  if (runs.length === 0) return null;
  return {
    steps: [
      ...runs.map((run) => ({
        id: `run-${run.id}`,
        title: run.title,
        status: stepStatus(run.status),
        agent: run.agent,
      })),
      {
        id: "assemble",
        title: "Review and assemble the result",
        status:
          assembled ??
          (runs.every((run) => isAgentRunTerminal(run.status)) ? "running" : "pending"),
        agent: "director",
      },
    ],
    updatedAt: now,
  };
}
