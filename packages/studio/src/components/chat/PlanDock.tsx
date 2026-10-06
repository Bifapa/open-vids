import { useEffect, useId, useRef } from "react";
import { CaretRight } from "@phosphor-icons/react";
import type { ChatState } from "@hyperframes/agent-protocol";
import { useAgentStore } from "../../agent/agentContext";
import { currentPlanStep, type PlanTurn } from "../../agent/planDock";
import { useTranslation } from "../../i18n";
import { cn } from "../ui/cn";
import { chatFocus, chatPadX } from "./chatStyles";
import { PlanApprovalBar, PlanStepList } from "./PlanParts";
import { usePlanApproval } from "./usePlanApproval";

/**
 * The plan pinned between the chat header and the conversation, so it stays on screen at any scroll position:
 * the running turn's plan, or the newest proposal waiting for the user ("Carry out" / "Change" under it). Folded to
 * one line — the step the Director is on, "Step 3 of 7 · …" — and opens into the list, which scrolls inside its own
 * height. The folded/open choice is kept per turn in the store. `turn` is chosen by `dockedPlanTurn`; the feed
 * does not draw the plan of that turn again.
 */
export function PlanDock({ chat, turn }: { chat: ChatState; turn: PlanTurn }) {
  const { t } = useTranslation();
  const open = useAgentStore((state) => state.planOpen[turn.id] ?? false);
  const setPlanOpen = useAgentStore((state) => state.setPlanOpen);
  const approvalFor = usePlanApproval(chat);
  const listId = useId();
  const listRef = useRef<HTMLDivElement>(null);

  const { plan } = turn;
  const total = plan.steps.length;
  const current = currentPlanStep(plan.steps);
  const approval = approvalFor(turn);
  const currentId = current?.step.id;

  // An open list shows the step that is running, not the top of a long plan.
  useEffect(() => {
    const list = listRef.current;
    const row = list?.querySelector<HTMLElement>('[data-step-status="running"]');
    if (!list || !row) return;
    list.scrollTop = Math.max(0, row.offsetTop - (list.clientHeight - row.offsetHeight) / 2);
  }, [open, currentId]);

  return (
    <section
      aria-label={t("chat.plan.title")}
      data-testid="plan-dock"
      data-turn-id={turn.id}
      className="shrink-0 border-b border-border-subtle bg-bg-1"
    >
      <button
        type="button"
        aria-expanded={open}
        aria-controls={listId}
        onClick={() => setPlanOpen(turn.id, !open)}
        className={cn(
          "flex h-ctl w-full items-center gap-[5px] text-left text-sm text-fg",
          "transition-colors duration-hover hover:bg-surface-1",
          chatPadX,
          chatFocus,
        )}
      >
        <CaretRight
          aria-hidden
          className={cn(
            "size-icon-sm shrink-0 text-fg-3 transition-transform duration-expand",
            open && "rotate-90",
          )}
        />
        {current ? (
          <span data-testid="plan-dock-step" className="min-w-0 truncate font-medium">
            {t("chat.plan.dock.step", {
              step: current.index + 1,
              total,
              title: current.step.title,
            })}
          </span>
        ) : (
          <>
            <span className="font-semibold">{t("chat.plan.title")}</span>
            <span className="ml-auto text-xs whitespace-nowrap text-fg-3 tabular-nums">
              {plan.proposal
                ? t("chat.plan.dock.steps", { count: total })
                : t("chat.plan.progress", {
                    reached: plan.steps.filter((step) => step.status !== "pending").length,
                    total,
                  })}
            </span>
          </>
        )}
      </button>
      {open && (
        // Long plans scroll here, not in the page: the dock never takes more than a third of the panel.
        <div
          ref={listRef}
          tabIndex={0}
          className={cn(
            "relative max-h-[min(14rem,32vh)] overflow-y-auto overscroll-contain",
            chatFocus,
          )}
        >
          <PlanStepList id={listId} steps={plan.steps} className={cn("pt-0.5 pb-1.5", chatPadX)} />
        </div>
      )}
      {approval && <PlanApprovalBar approval={approval} className={chatPadX} />}
    </section>
  );
}
