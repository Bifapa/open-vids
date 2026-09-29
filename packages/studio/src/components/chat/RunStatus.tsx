import {
  Check,
  CircleNotch,
  Clock,
  MinusCircle,
  PauseCircle,
  StopCircle,
  WarningCircle,
} from "@phosphor-icons/react";
import type { AgentRunStatus } from "@hyperframes/agent-protocol";
import { cn } from "../ui/cn";
import { RUN_STATUS_LABELS } from "./agentLabels";

function Glyph({ status }: { status: AgentRunStatus }) {
  switch (status) {
    case "queued":
      return <Clock size={12} aria-hidden className="text-text-3" />;
    case "running":
      return (
        <CircleNotch
          size={12}
          weight="bold"
          aria-hidden
          className="animate-spin text-accent motion-reduce:animate-none"
        />
      );
    case "completed":
      return <Check size={12} weight="bold" aria-hidden className="text-accent" />;
    case "failed":
      return <WarningCircle size={12} weight="fill" aria-hidden className="text-danger" />;
    case "aborted":
      return <StopCircle size={12} aria-hidden className="text-text-3" />;
    case "cancelled":
      return <MinusCircle size={12} aria-hidden className="text-text-3" />;
    case "interrupted":
      return <PauseCircle size={12} aria-hidden className="text-container" />;
  }
}

/** A run's state as a glyph plus its word; the word can be dropped where space is tight. */
export function RunStatus({
  status,
  showLabel = true,
  className,
}: {
  status: AgentRunStatus;
  showLabel?: boolean;
  className?: string;
}) {
  const label = RUN_STATUS_LABELS[status];
  return (
    <span
      data-run-status={status}
      className={cn("inline-flex shrink-0 items-center gap-1 text-step-10 text-text-3", className)}
    >
      <Glyph status={status} />
      <span className={showLabel ? undefined : "sr-only"}>{label}</span>
    </span>
  );
}
