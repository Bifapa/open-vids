import { Check, Minus, WarningCircle } from "@phosphor-icons/react";
import type { PlanStep, PlanStepStatus } from "@hyperframes/agent-protocol";
import { useTranslation } from "../../i18n";
import { Button } from "../ui/Button";
import { cn } from "../ui/cn";
import { StatusDot } from "../ui/Status";
import { PLAN_STATUS_LABELS } from "./agentLabels";
import { chatAgentName } from "./AgentMonogram";
import { usePlanVoiceDialect } from "./usePlanVoiceDialect";
import { VoiceTaggedText } from "./VoiceTaggedText";

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

/** The plan's steps, one row each: the mark, the title, who does it. `className` carries the padding. */
export function PlanStepList({
  steps,
  id,
  className,
}: {
  steps: readonly PlanStep[];
  id?: string;
  className?: string;
}) {
  const { t } = useTranslation();
  const dialect = usePlanVoiceDialect(steps);
  return (
    <ol id={id} className={cn("grid gap-px", className)}>
      {steps.map((step) => (
        <li
          key={step.id}
          data-step-status={step.status}
          className={cn(
            "flex min-h-ctl-xs items-start gap-2 py-[3px] text-sm leading-4",
            STEP_TEXT[step.status],
          )}
        >
          <span aria-hidden className="inline-flex h-4 w-3.5 shrink-0 items-center justify-center">
            <StepMark status={step.status} />
          </span>
          <span className="min-w-0 flex-1 [overflow-wrap:anywhere]">
            <VoiceTaggedText text={step.title} dialect={dialect} />
          </span>
          <span className="sr-only">{t(PLAN_STATUS_LABELS[step.status])}</span>
          {step.agent && step.agent !== "director" && (
            <span className="shrink-0 text-xs font-normal text-fg-3">
              {chatAgentName(step.agent)}
            </span>
          )}
        </li>
      ))}
    </ol>
  );
}

/**
 * A plan proposal's decision: "Carry out" / "Change" (or "Carry out anyway" and the out-of-date note), and why they
 * are disabled while an agent runs. `className` carries the padding.
 */
export function PlanApprovalBar({
  approval,
  className,
}: {
  approval: PlanApproval;
  className?: string;
}) {
  const { t } = useTranslation();
  return (
    <div className={cn("grid gap-1 border-t border-border-subtle py-1.5", className)}>
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
  );
}
