import { AGENT_DISPLAY_NAMES, type AgentId } from "@hyperframes/agent-protocol";
import { cn } from "../ui/cn";

const MONOGRAMS: Record<AgentId, string> = {
  director: "M",
  editor: "E",
  vision: "V",
  motion: "MD",
  research: "R",
  audio: "A",
  jev: "J",
};

/** What the chat calls an agent: the Director leads the conversation as "Main". */
export function chatAgentName(agent: AgentId): string {
  return agent === "director" ? "Main" : AGENT_DISPLAY_NAMES[agent];
}

/** An agent's identity by letter (never by hue): a 16 px tile beside its name. Decorative. */
export function AgentMonogram({
  agent,
  off = false,
  className,
}: {
  agent: AgentId;
  /** A disabled agent: the tile loses its fill. */
  off?: boolean;
  className?: string;
}) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "inline-flex size-4 shrink-0 select-none items-center justify-center rounded-xs border border-border",
        "font-mono text-2xs leading-none font-semibold uppercase",
        off ? "bg-transparent text-fg-3" : "bg-surface-2 text-fg-2",
        className,
      )}
    >
      {MONOGRAMS[agent]}
    </span>
  );
}
