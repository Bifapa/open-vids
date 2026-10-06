import { useMemo } from "react";
import type { ChatState, TurnSummary } from "@hyperframes/agent-protocol";
import { useAgentStore, useAgentStoreApi } from "../../agent/agentContext";
import { useComposerRequestStore } from "../../agent/composerRequest";
import { NEW_CHAT_DRAFT } from "../../agent/agentDraftChat";
import { awaitsApproval } from "../../agent/planDock";
import { carriedOutProposalIds } from "../../agent/retryTurn";
import { useTranslation } from "../../i18n";
import type { PlanApproval } from "./PlanParts";

/**
 * The buttons of a plan proposal, for a turn of `chat`. A proposal is the user's to run or change: the last turn's is
 * current; once another turn ran after it, it is out of date — still offered ("Carry out anyway") unless a later
 * turn already carried it out. Undefined for any turn that is not a proposal waiting for the user.
 */
export function usePlanApproval(chat: ChatState): (turn: TurnSummary) => PlanApproval | undefined {
  const { t } = useTranslation();
  const activeTurn = useAgentStore((state) => state.activeTurn);
  const pending = useAgentStore((state) => state.pending);
  const executePlan = useAgentStore((state) => state.startPlanExecution);
  const store = useAgentStoreApi();
  const carriedOut = useMemo(() => carriedOutProposalIds(chat), [chat]);
  const lastTurn = chat.turns.at(-1);

  return (turn) =>
    awaitsApproval(turn, carriedOut)
      ? {
          busy: pending !== null,
          stale: turn.id !== lastTurn?.id,
          reason: activeTurn ? t("chat.plan.waitForAgent") : null,
          onExecute: () => void executePlan(turn.id),
          onRevise: () => {
            // Nothing to type on its own: start the message the way a change request reads, never over a draft.
            // The draft is read now, not subscribed to: typing must not re-render the whole conversation.
            const { chatId, drafts, setDraft } = store.getState();
            if ((drafts[chatId ?? NEW_CHAT_DRAFT] ?? "").trim() === "")
              setDraft(t("chat.plan.revisePrefix"));
            useComposerRequestStore.getState().focus();
          },
        }
      : undefined;
}
