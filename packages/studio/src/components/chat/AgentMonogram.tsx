import type { AgentId } from "@hyperframes/agent-protocol";
import { t, useTranslation, type TranslationKey } from "../../i18n";
import { cn } from "../ui/cn";
import { AGENT_NAME_KEYS } from "./agentLabels";

const MONOGRAMS: Record<AgentId, TranslationKey> = {
  director: "chat.agent.monogram.director",
  editor: "chat.agent.monogram.editor",
  vision: "chat.agent.monogram.vision",
  motion: "chat.agent.monogram.motion",
  research: "chat.agent.monogram.research",
  audio: "chat.agent.monogram.audio",
  jev: "chat.agent.monogram.jev",
};

/** What the chat calls an agent: the Director leads the conversation as "Main". Call it while rendering. */
export function chatAgentName(agent: AgentId): string {
  return t(agent === "director" ? "chat.agent.main" : AGENT_NAME_KEYS[agent]);
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
  const { t } = useTranslation();
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
      {t(MONOGRAMS[agent])}
    </span>
  );
}
