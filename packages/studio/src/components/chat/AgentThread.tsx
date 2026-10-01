import { useMemo } from "react";
import {
  type AgentModelCatalog,
  type AgentRun,
  type ChatState,
  type WorkerAgentId,
} from "@hyperframes/agent-protocol";
import { useAgentStore } from "../../agent/agentContext";
import { describeTurnError } from "../../agent/agentErrors";
import { agentThread, displayModelName, findModel } from "../../agent/agentSelectors";
import { useTranslation } from "../../i18n";
import { cn } from "../ui/cn";
import { EFFORT_LABELS, RUN_STATUS_LABELS } from "./agentLabels";
import { chatAgentName } from "./AgentMonogram";
import { chatMeasure } from "./chatStyles";
import { AssistantBlock, TaskBrief } from "./Messages";
import { formatDuration } from "./relativeTime";

/** "Done · Sonnet · High thinking · 42s": how the run went, beside its brief's label. */
function RunMeta({
  run,
  caller,
  catalog,
}: {
  run: AgentRun;
  /** Who started the run when it was not the Director (a specialist calling Jev). */
  caller: string | null;
  catalog: AgentModelCatalog | null;
}) {
  const { t } = useTranslation();
  const details = [
    t(RUN_STATUS_LABELS[run.status]),
    run.model
      ? displayModelName(run.model, findModel(catalog, run.model))
      : t("chat.run.defaultModel"),
  ];
  if (run.thinking)
    details.push(t("chat.run.thinking", { effort: t(EFFORT_LABELS[run.thinking]) }));
  if (run.endedAt !== undefined) details.push(formatDuration(run.endedAt - run.startedAt));
  return (
    <>
      <span data-run-status={run.status} className="font-normal tabular-nums">
        · {details.join(" · ")}
      </span>
      {run.routedByDirector && (
        <span className="font-normal" title={t("chat.run.routedTitle")}>
          · {t("chat.run.routed")}
        </span>
      )}
      {caller && <span className="font-normal">· {t("chat.run.via", { name: caller })}</span>}
    </>
  );
}

/**
 * One agent's work in this chat (the subagent view): every run it did, oldest first, each as its brief
 * ("Task from Main") and any follow-ups, then its reply — activity list, findings, the Jev calls it made.
 */
export function AgentThread({ chat, agent }: { chat: ChatState; agent: WorkerAgentId }) {
  const { t } = useTranslation();
  const catalog = useAgentStore((state) => state.models);
  const threads = useMemo(() => agentThread(chat, agent), [chat, agent]);
  const name = chatAgentName(agent);

  if (threads.length === 0) {
    return (
      <p className="py-6 text-center text-xs text-fg-3">{t("chat.thread.noTasks", { name })}</p>
    );
  }
  return (
    <>
      {threads.map(({ run, messages }) => {
        const parent = run.parentRunId
          ? chat.runs.find((candidate) => candidate.id === run.parentRunId)
          : undefined;
        const firstTaskId = messages.find((message) => message.role === "task")?.id;
        return (
          <article
            key={run.id}
            aria-label={t("chat.thread.runLabel", { name, title: run.title })}
            data-run-id={run.id}
            className="grid min-w-0 gap-3.5 @max-[299px]/chat:gap-3 @min-[440px]/chat:gap-4"
          >
            {messages.map((message) =>
              message.role === "task" ? (
                <TaskBrief
                  key={message.id}
                  message={message}
                  meta={
                    message.id === firstTaskId ? (
                      <RunMeta
                        run={run}
                        caller={parent ? chatAgentName(parent.agent) : null}
                        catalog={catalog}
                      />
                    ) : undefined
                  }
                />
              ) : (
                <AssistantBlock
                  key={message.id}
                  message={message}
                  workLabel={t("chat.thread.activity", { name })}
                />
              ),
            )}
            {run.status === "failed" && run.error && (
              <p role="alert" className={cn("text-xs leading-4 text-error", chatMeasure)}>
                {describeTurnError(run.error.code, run.error.message)}
              </p>
            )}
          </article>
        );
      })}
    </>
  );
}
