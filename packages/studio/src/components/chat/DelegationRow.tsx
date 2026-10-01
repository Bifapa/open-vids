import type { AgentRunStatus } from "@hyperframes/agent-protocol";
import { useAgentStore } from "../../agent/agentContext";
import { describeTurnError } from "../../agent/agentErrors";
import { runCurrentStep } from "../../agent/agentSelectors";
import { useTranslation } from "../../i18n";
import { cn } from "../ui/cn";
import { AgentMonogram, chatAgentName } from "./AgentMonogram";
import {
  WORK_ROW_TONE,
  WORK_STATE_TEXT,
  WorkTail,
  WorkText,
  workRowGrid,
  type WorkState,
} from "./ActivityRow";
import { chatFocus, selItem } from "./chatStyles";

const RUN_STATE: Record<AgentRunStatus, WorkState> = {
  queued: "pending",
  running: "running",
  completed: "done",
  failed: "failed",
  aborted: "skipped",
  cancelled: "skipped",
  interrupted: "failed",
};

/**
 * Where work was handed to another agent, as a Working-list row: who took it, its live step while it runs,
 * its outcome once it ends. One click opens the agent's own thread.
 */
export function DelegationRow({ runId }: { runId: string }) {
  const run = useAgentStore((state) => state.chat?.runs.find((item) => item.id === runId) ?? null);
  const currentStep = useAgentStore((state) =>
    state.chat && run ? runCurrentStep(state.chat.messages, run) : null,
  );
  const selectThread = useAgentStore((state) => state.selectThread);
  const { t } = useTranslation();
  if (!run) return null;

  const state = RUN_STATE[run.status];
  const name = chatAgentName(run.agent);
  let outcome = state === "running" || state === "pending" ? null : run.summary;
  if (run.status === "failed" && run.error) {
    outcome = describeTurnError(run.error.code, run.error.message);
  }
  let step = run.title;
  if (run.status === "queued") step = t("chat.delegation.waiting");
  else if (state === "running") step = currentStep ?? run.title;

  return (
    <li>
      <button
        type="button"
        data-testid="delegation-row"
        data-run-id={run.id}
        aria-label={t("chat.delegation.open", { name, step, state: t(WORK_STATE_TEXT[state]) })}
        onClick={() => selectThread(run.agent)}
        className={cn(workRowGrid, WORK_ROW_TONE[state], selItem, "hover:text-fg", chatFocus)}
      >
        <AgentMonogram agent={run.agent} />
        <WorkText agent={run.agent} state={state}>
          <span
            data-testid={state === "running" || state === "pending" ? "delegation-step" : undefined}
          >
            {step}
          </span>
        </WorkText>
        <span data-run-status={run.status} className="contents">
          <WorkTail state={state} startedAt={run.startedAt} endedAt={run.endedAt} />
        </span>
        {outcome && (
          <span
            data-testid="delegation-outcome"
            className={cn(
              "col-start-2 col-end-[-1] line-clamp-2 text-xs leading-[15px]",
              run.status === "failed" ? "text-error" : "text-fg-3",
            )}
          >
            {outcome}
          </span>
        )}
      </button>
    </li>
  );
}
