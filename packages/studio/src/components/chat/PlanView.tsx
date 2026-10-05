import { useId, useState } from "react";
import { CaretRight, Check, Minus, WarningCircle } from "@phosphor-icons/react";
import type { ExecutionPlan, PlanStepStatus } from "@hyperframes/agent-protocol";
import { useTranslation } from "../../i18n";
import { Button } from "../ui/Button";
import { cn } from "../ui/cn";
import { StatusDot } from "../ui/Status";
import { PLAN_STATUS_LABELS } from "./agentLabels";
import { chatAgentName } from "./AgentMonogram";
import { chatFocus, chatMeasureWide } from "./chatStyles";

function StepMark({ status }: { status: PlanStepStatus }) {
  switch (status) {
    case "done":
      return <Check aria-hidden weight="bold" className="size-icon-sm text-success" />;
    case "running":
      return <StatusDot tone="running" />;
    case "failed":
      return <WarningCircle aria-hidden weight="fill" className="size-icon-sm text-error" />;
    case "skipped":
      return <Minus aria-hidden className="size-icon-sm text-fg-disabled" />;
    case "pending":
      return <StatusDot tone="off" />;
  }
}

const STEP_TEXT: Record<PlanStepStatus, string> = {
  done: "text-fg-3",
  running: "font-medium text-fg",
  failed: "text-fg-2",
  skipped: "text-fg-disabled line-through",
  pending: "text-fg-2",
};

/** What the plan proposal's buttons need: busy, whether the proposal is out of date, why they are disabled. */
export interface PlanApproval {
  busy: boolean;
  /** Another turn ran after the proposal: the project and the conversation may have moved on. */
  stale: boolean;
  /** Why Carry out and Change are disabled right now (another run is active), or null. */
  reason: string | null;
  onExecute: () => void;
  onRevise: () => void;
}

/**
 * The Director's compact plan for a turn, "n of m" in its head: open while the turn runs, folded once it ends
 * (the user can still open it). A plan proposal (`plan.proposal`) is the user's to run or change: it carries the
 * "Carry out" / "Change" buttons once finished, and says when it is out of date ("Carry out anyway").
 */
export function PlanView({
  plan,
  live,
  approval,
}: {
  plan: ExecutionPlan;
  live: boolean;
  approval?: PlanApproval | undefined;
}) {
  const { t } = useTranslation();
  const [choice, setChoice] = useState<boolean | null>(null);
  const open = choice ?? live;
  const listId = useId();
  if (plan.steps.length === 0) return null;
  const reached = plan.steps.filter((step) => step.status !== "pending").length;

  return (
    <section
      aria-label={t("chat.plan.title")}
      data-testid="turn-plan"
      className={cn(
        "overflow-hidden rounded-md border border-border-subtle bg-bg-1",
        chatMeasureWide,
      )}
    >
      <button
        type="button"
        aria-expanded={open}
        aria-controls={listId}
        onClick={() => setChoice(!open)}
        className={cn(
          "flex h-ctl w-full items-center gap-[5px] pr-2 pl-[5px] text-left text-sm font-semibold text-fg",
          "transition-colors duration-hover hover:bg-surface-1",
          chatFocus,
        )}
      >
        <CaretRight
          aria-hidden
          className={cn(
            "size-icon-sm text-fg-3 transition-transform duration-expand",
            open && "rotate-90",
          )}
        />
        <span>{t("chat.plan.title")}</span>
        <span className="ml-auto text-xs font-normal whitespace-nowrap text-fg-3 tabular-nums">
          {t("chat.plan.progress", { reached, total: plan.steps.length })}
        </span>
      </button>
      {open && (
        <ol id={listId} className="grid gap-px px-2 pt-0.5 pb-[7px]">
          {plan.steps.map((step) => (
            <li
              key={step.id}
              data-step-status={step.status}
              className={cn(
                "flex min-h-ctl-xs items-start gap-2 py-[3px] text-sm leading-4",
                STEP_TEXT[step.status],
              )}
            >
              <span
                aria-hidden
                className="inline-flex h-4 w-3.5 shrink-0 items-center justify-center"
              >
                <StepMark status={step.status} />
              </span>
              <span className="min-w-0 flex-1 [overflow-wrap:anywhere]">{step.title}</span>
              <span className="sr-only">{t(PLAN_STATUS_LABELS[step.status])}</span>
              {step.agent && step.agent !== "director" && (
                <span className="shrink-0 text-xs font-normal text-fg-3">
                  {chatAgentName(step.agent)}
                </span>
              )}
            </li>
          ))}
        </ol>
      )}
      {approval && plan.proposal && (
        <div className="grid gap-1 border-t border-border-subtle px-2 py-1.5">
          {approval.stale && (
            <p data-testid="plan-stale" className="text-xs leading-[15px] text-warning">
              {t("chat.plan.stale")}
            </p>
          )}
          <div className="flex flex-wrap items-center gap-1.5">
            <Button
              size="sm"
              disabled={approval.busy || approval.reason !== null}
              onClick={approval.onExecute}
            >
              {approval.stale ? t("chat.plan.executeAnyway") : t("chat.plan.execute")}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              disabled={approval.busy || approval.reason !== null}
              onClick={approval.onRevise}
            >
              {t("chat.plan.revise")}
            </Button>
            {approval.reason !== null && (
              <span data-testid="plan-blocked" className="text-xs leading-4 text-fg-3">
                {approval.reason}
              </span>
            )}
          </div>
        </div>
      )}
    </section>
  );
}
