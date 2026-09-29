import { useId, useState } from "react";
import {
  CaretRight,
  Check,
  Circle,
  CircleNotch,
  ListChecks,
  MinusCircle,
  WarningCircle,
} from "@phosphor-icons/react";
import {
  AGENT_DISPLAY_NAMES,
  type ExecutionPlan,
  type PlanStepStatus,
} from "@hyperframes/agent-protocol";
import { cn } from "../ui/cn";
import { PLAN_STATUS_LABELS } from "./agentLabels";

function StepGlyph({ status }: { status: PlanStepStatus }) {
  switch (status) {
    case "pending":
      return <Circle size={11} aria-hidden className="shrink-0 text-text-4" />;
    case "running":
      return (
        <CircleNotch
          size={11}
          weight="bold"
          aria-hidden
          className="shrink-0 animate-spin text-accent motion-reduce:animate-none"
        />
      );
    case "done":
      return <Check size={11} weight="bold" aria-hidden className="shrink-0 text-accent" />;
    case "failed":
      return <WarningCircle size={11} weight="fill" aria-hidden className="shrink-0 text-danger" />;
    case "skipped":
      return <MinusCircle size={11} aria-hidden className="shrink-0 text-text-4" />;
  }
}

/** "2 of 4 done · 1 failed": the whole plan in one line, for when it is folded. */
function planSummary(plan: ExecutionPlan): string {
  const count = (status: PlanStepStatus) =>
    plan.steps.filter((step) => step.status === status).length;
  const parts = [`${count("done")} of ${plan.steps.length} done`];
  if (count("failed") > 0) parts.push(`${count("failed")} failed`);
  if (count("skipped") > 0) parts.push(`${count("skipped")} skipped`);
  return parts.join(" · ");
}

/**
 * The Director's compact plan for a turn: open while the turn runs, folded to one line once it ends (the
 * user can still open it). Informational only; nothing here waits for approval.
 */
export function PlanView({ plan, live }: { plan: ExecutionPlan; live: boolean }) {
  const [choice, setChoice] = useState<boolean | null>(null);
  const open = choice ?? live;
  const listId = useId();
  if (plan.steps.length === 0) return null;

  return (
    <section
      aria-label="Plan"
      data-testid="turn-plan"
      className="rounded-md border border-hairline bg-bg-2"
    >
      <button
        type="button"
        aria-expanded={open}
        aria-controls={listId}
        onClick={() => setChoice(!open)}
        className={cn(
          "flex w-full items-center gap-1.5 rounded-md px-2 py-1 text-left text-step-11 outline-hidden",
          "transition-colors duration-hover hover:bg-hover/40",
          "focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-accent",
        )}
      >
        <ListChecks size={13} aria-hidden className="shrink-0 text-text-3" />
        <span className="font-medium text-text-1">Plan</span>
        <span className="min-w-0 flex-1 truncate text-text-3">{planSummary(plan)}</span>
        <CaretRight
          size={10}
          weight="bold"
          aria-hidden
          className={cn(
            "shrink-0 text-text-4 transition-transform duration-expand",
            open && "rotate-90",
          )}
        />
      </button>
      {open && (
        <ol id={listId} className="flex flex-col gap-0.5 border-t border-hairline px-2 py-1.5">
          {plan.steps.map((step) => (
            <li
              key={step.id}
              data-step-status={step.status}
              className="flex items-center gap-1.5 text-step-11"
            >
              <StepGlyph status={step.status} />
              <span
                className={cn(
                  "min-w-0 flex-1 truncate",
                  step.status === "running" && "text-text-0",
                  step.status === "skipped" && "text-text-4 line-through",
                  step.status !== "running" && step.status !== "skipped" && "text-text-2",
                )}
              >
                {step.title}
              </span>
              <span className="sr-only">{PLAN_STATUS_LABELS[step.status]}</span>
              {step.agent && (
                <span className="shrink-0 text-step-10 text-text-4">
                  {AGENT_DISPLAY_NAMES[step.agent]}
                </span>
              )}
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
