import { useMemo } from "react";
import {
  AGENT_DISPLAY_NAMES,
  type AgentModelCatalog,
  type AgentRun,
  type ChatState,
  type WorkerAgentId,
} from "@hyperframes/agent-protocol";
import { useAgentStore } from "../../agent/agentContext";
import { describeTurnError } from "../../agent/agentErrors";
import { agentThread, displayModelName, findModel } from "../../agent/agentSelectors";
import { EFFORT_LABELS, RUN_STATUS_LABELS } from "./agentLabels";
import { AssistantBlock, TaskBubble } from "./Messages";
import { formatDuration } from "./relativeTime";
import { RunStatus } from "./RunStatus";

function RunHeader({
  run,
  caller,
  catalog,
}: {
  run: AgentRun;
  /** Who started the run when it was not the Director (a specialist calling Jev). */
  caller: string | null;
  catalog: AgentModelCatalog | null;
}) {
  const model = run.model
    ? displayModelName(run.model, findModel(catalog, run.model))
    : "Default model";
  const details = [RUN_STATUS_LABELS[run.status], model];
  if (run.thinking) details.push(`${EFFORT_LABELS[run.thinking]} thinking`);

  return (
    <header className="flex flex-col gap-0.5 border-b border-hairline pb-1.5">
      <div className="flex items-center gap-1.5">
        <RunStatus status={run.status} showLabel={false} />
        <h3 className="min-w-0 flex-1 truncate text-step-12 font-medium text-text-0">
          {run.title}
        </h3>
        {run.endedAt !== undefined && (
          <span className="shrink-0 text-step-10 tabular-nums text-text-4">
            {formatDuration(run.endedAt - run.startedAt)}
          </span>
        )}
      </div>
      <p className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-step-10 text-text-3">
        <span>{details.join(" · ")}</span>
        {run.routedByDirector && (
          <span
            className="rounded-sm bg-accent/10 px-1 text-accent"
            title="The Director picked this model or effort for the task, within the limits you set."
          >
            routed by Director
          </span>
        )}
        {caller && <span className="rounded-sm bg-surface px-1 text-text-2">from {caller}</span>}
      </p>
      {run.status === "failed" && run.error && (
        <p role="alert" className="text-step-11 text-danger">
          {describeTurnError(run.error.code, run.error.message)}
        </p>
      )}
    </header>
  );
}

/**
 * One agent's work in this chat: every run it did, oldest first, each as its task (and any follow-ups)
 * followed by its full reply: thinking, activity, text, and the Jev calls it made.
 */
export function AgentThread({ chat, agent }: { chat: ChatState; agent: WorkerAgentId }) {
  const catalog = useAgentStore((state) => state.models);
  const threads = useMemo(() => agentThread(chat, agent), [chat, agent]);
  const name = AGENT_DISPLAY_NAMES[agent];

  if (threads.length === 0) {
    return (
      <p className="px-3 py-6 text-center text-step-11 text-text-3">{name} has no tasks here.</p>
    );
  }
  return (
    <>
      {threads.map(({ run, messages }) => {
        const parent = run.parentRunId
          ? chat.runs.find((candidate) => candidate.id === run.parentRunId)
          : undefined;
        return (
          <article
            key={run.id}
            aria-label={`${name}: ${run.title}`}
            data-run-id={run.id}
            className="flex flex-col gap-2"
          >
            <RunHeader
              run={run}
              caller={parent ? AGENT_DISPLAY_NAMES[parent.agent] : null}
              catalog={catalog}
            />
            {messages.map((message) =>
              message.role === "task" ? (
                <TaskBubble key={message.id} message={message} />
              ) : (
                <AssistantBlock key={message.id} message={message} />
              ),
            )}
          </article>
        );
      })}
    </>
  );
}
