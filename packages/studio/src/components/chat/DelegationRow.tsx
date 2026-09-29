import { ArrowElbowDownRight, CaretRight } from "@phosphor-icons/react";
import { AGENT_DISPLAY_NAMES, isAgentRunTerminal } from "@hyperframes/agent-protocol";
import { useAgentStore } from "../../agent/agentContext";
import { describeTurnError } from "../../agent/agentErrors";
import { runCurrentStep } from "../../agent/agentSelectors";
import { cn } from "../ui/cn";
import { RunStatus } from "./RunStatus";

/**
 * Where work was handed to another agent: who took it, the task, how it is going (its live step while it
 * runs, its outcome once it ends). A milestone, not a transcript: the detail is one click away, in the
 * agent's own thread.
 */
export function DelegationRow({ runId }: { runId: string }) {
  const run = useAgentStore((state) => state.chat?.runs.find((item) => item.id === runId) ?? null);
  const currentStep = useAgentStore((state) =>
    state.chat && run ? runCurrentStep(state.chat.messages, run) : null,
  );
  const selectThread = useAgentStore((state) => state.selectThread);
  if (!run) return null;

  const name = AGENT_DISPLAY_NAMES[run.agent];
  const live = !isAgentRunTerminal(run.status);
  let outcome = run.summary;
  if (run.status === "failed" && run.error) {
    outcome = describeTurnError(run.error.code, run.error.message);
  }
  let step = currentStep ?? "Working…";
  if (run.status === "queued") step = "Waiting to start…";

  return (
    <button
      type="button"
      data-testid="delegation-row"
      data-run-id={run.id}
      title={`Open ${name}'s thread`}
      onClick={() => selectThread(run.agent)}
      className={cn(
        "group flex w-full flex-col gap-1 rounded-md border border-hairline bg-bg-2 px-2 py-1.5 text-left",
        "outline-hidden transition-colors duration-hover hover:border-border-strong hover:bg-hover/40",
        "focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-accent",
      )}
    >
      <span className="flex w-full items-center gap-1.5">
        <span className="shrink-0 rounded-sm bg-surface px-1.5 py-px text-step-10 font-medium text-text-1">
          {name}
        </span>
        <span className="min-w-0 flex-1 truncate text-step-11 text-text-1">{run.title}</span>
        <RunStatus status={run.status} />
        <CaretRight
          size={10}
          weight="bold"
          aria-hidden
          className="shrink-0 text-text-4 transition-colors group-hover:text-text-2"
        />
      </span>
      {live ? (
        <span className="flex min-w-0 items-center gap-1 pl-0.5 text-step-10 text-text-3">
          <ArrowElbowDownRight size={10} aria-hidden className="shrink-0 text-text-4" />
          <span data-testid="delegation-step" className="truncate">
            {step}
          </span>
        </span>
      ) : (
        outcome && (
          <span
            data-testid="delegation-outcome"
            className={cn(
              "line-clamp-2 pl-0.5 text-step-11 leading-snug",
              run.status === "failed" ? "text-danger" : "text-text-2",
            )}
          >
            {outcome}
          </span>
        )
      )}
    </button>
  );
}
