import { useId } from "react";
import { CaretRight } from "@phosphor-icons/react";
import type { ExecutionPlan } from "@hyperframes/agent-protocol";
import { useAgentStore } from "../../agent/agentContext";
import { useTranslation } from "../../i18n";
import { cn } from "../ui/cn";
import { chatFocus, chatMeasureWide } from "./chatStyles";
import { PlanApprovalBar, PlanStepList, type PlanApproval } from "./PlanParts";

/**
 * The Director's compact plan of a turn in the feed, "n of m" in its head, folded until the user opens it (the choice
 * is kept per turn in the store, shared with the pinned dock the plan comes from). The plan of a running turn, and
 * the newest proposal waiting for the user, are in the dock instead (`PlanDock`); an older proposal still waiting
 * carries its "Carry out" / "Change" buttons here, and says when it is out of date ("Carry out anyway").
 */
export function PlanView({
  plan,
  turnId,
  approval,
}: {
  plan: ExecutionPlan;
  turnId: string;
  approval?: PlanApproval | undefined;
}) {
  const { t } = useTranslation();
  const open = useAgentStore((state) => state.planOpen[turnId] ?? false);
  const setPlanOpen = useAgentStore((state) => state.setPlanOpen);
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
        onClick={() => setPlanOpen(turnId, !open)}
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
      {open && <PlanStepList id={listId} steps={plan.steps} className="px-2 pt-0.5 pb-[7px]" />}
      {approval && plan.proposal && <PlanApprovalBar approval={approval} className="px-2" />}
    </section>
  );
}
