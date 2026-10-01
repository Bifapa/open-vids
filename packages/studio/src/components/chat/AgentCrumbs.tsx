import { Fragment } from "react";
import type { AgentRun, WorkerAgentId } from "@hyperframes/agent-protocol";
import type { ThreadId } from "../../agent/agentSelectors";
import { useTranslation } from "../../i18n";
import { cn } from "../ui/cn";
import { chatAgentName } from "./AgentMonogram";
import { chatFocus } from "./chatStyles";

/**
 * The agent that handed `agent` its work when every one of its runs came from the same specialist (Jev called by
 * the Editor): that agent sits between Main and it in the path. Null when Main started it.
 */
function callerOf(runs: readonly AgentRun[], agent: WorkerAgentId): WorkerAgentId | null {
  let caller: WorkerAgentId | null = null;
  for (const run of runs) {
    if (run.agent !== agent) continue;
    const parent = run.parentRunId ? runs.find((item) => item.id === run.parentRunId) : undefined;
    if (!parent) return null;
    if (caller && caller !== parent.agent) return null;
    caller = parent.agent;
  }
  return caller;
}

const crumbClass = cn(
  "inline-flex h-ctl-xs min-w-0 shrink items-center truncate rounded-sm px-1.5 text-xs whitespace-nowrap",
  chatFocus,
);

function Sep({ className }: { className?: string }) {
  return (
    <span aria-hidden className={cn("shrink-0 text-xs text-fg-disabled select-none", className)}>
      /
    </span>
  );
}

/**
 * `Main / Editor / Jev` in the context row of a subagent view: quiet metadata, not navigation chrome. The
 * middle crumb collapses to `…` on a narrow dock.
 */
export function AgentCrumbs({
  runs,
  active,
  onSelect,
}: {
  runs: readonly AgentRun[];
  active: WorkerAgentId;
  onSelect: (thread: ThreadId) => void;
}) {
  const { t } = useTranslation();
  const caller = callerOf(runs, active);
  const link = cn(crumbClass, "text-fg-3 hover:bg-surface-2 hover:text-fg");
  return (
    <nav
      aria-label={t("chat.crumbs.label")}
      className="flex min-w-0 shrink items-center overflow-hidden"
    >
      <button type="button" className={link} onClick={() => onSelect("main")}>
        {chatAgentName("director")}
      </button>
      {caller && (
        <Fragment>
          <Sep className="@max-[299px]/chat:hidden" />
          <button
            type="button"
            className={cn(link, "@max-[299px]/chat:hidden")}
            onClick={() => onSelect(caller)}
          >
            {chatAgentName(caller)}
          </button>
          <Sep className="hidden @max-[299px]/chat:inline" />
          <button
            type="button"
            aria-label={t("chat.crumbs.openThread", { name: chatAgentName(caller) })}
            className={cn(
              link,
              "hidden min-w-ctl-xs justify-center px-1 @max-[299px]/chat:inline-flex",
            )}
            onClick={() => onSelect(caller)}
          >
            …
          </button>
        </Fragment>
      )}
      <Sep />
      <button
        type="button"
        aria-current="page"
        className={cn(crumbClass, "shrink-0 cursor-default font-medium text-fg-2")}
      >
        {chatAgentName(active)}
      </button>
    </nav>
  );
}
