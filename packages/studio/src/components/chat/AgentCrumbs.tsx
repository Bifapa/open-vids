import { useMemo } from "react";
import { AGENT_DISPLAY_NAMES, type AgentRun } from "@hyperframes/agent-protocol";
import { agentCrumbs, type ThreadId } from "../../agent/agentSelectors";
import { cn } from "../ui/cn";

function Crumb({
  label,
  active,
  live,
  first,
  onSelect,
}: {
  label: string;
  active: boolean;
  live: boolean;
  first: boolean;
  onSelect: () => void;
}) {
  return (
    <li className="flex shrink-0 items-center gap-0.5">
      {!first && (
        <span aria-hidden className="px-0.5 text-text-5">
          /
        </span>
      )}
      <button
        type="button"
        aria-current={active ? "page" : undefined}
        onClick={onSelect}
        className={cn(
          "flex h-5 items-center gap-1 rounded-sm px-1.5 outline-hidden transition-colors duration-hover",
          "focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-accent",
          active ? "bg-hover font-medium text-text-0" : "text-text-3 hover:text-text-1",
        )}
      >
        {label}
        {live && (
          <>
            <span
              aria-hidden
              className="size-1.5 animate-pulse rounded-full bg-accent motion-reduce:animate-none"
            />
            <span className="sr-only">(working)</span>
          </>
        )}
      </button>
    </li>
  );
}

/**
 * `Main / Editor / Vision`: the clean chat plus every agent that worked in it, in order of first appearance.
 * One level only; each crumb switches the conversation to that agent's runs.
 */
export function AgentCrumbs({
  runs,
  active,
  onSelect,
}: {
  runs: readonly AgentRun[];
  active: ThreadId;
  onSelect: (thread: ThreadId) => void;
}) {
  const crumbs = useMemo(() => agentCrumbs(runs), [runs]);
  if (crumbs.length === 0) return null;
  return (
    <nav aria-label="Agent threads" className="min-w-0">
      <ol className="flex min-w-0 items-center overflow-x-auto text-step-11">
        <Crumb
          first
          label="Main"
          active={active === "main"}
          live={false}
          onSelect={() => onSelect("main")}
        />
        {crumbs.map((crumb) => (
          <Crumb
            key={crumb.agent}
            first={false}
            label={AGENT_DISPLAY_NAMES[crumb.agent]}
            active={active === crumb.agent}
            live={crumb.live}
            onSelect={() => onSelect(crumb.agent)}
          />
        ))}
      </ol>
    </nav>
  );
}
