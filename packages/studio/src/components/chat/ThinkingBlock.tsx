import { useId, useState } from "react";
import { CaretRight } from "@phosphor-icons/react";
import type { ThinkingPart } from "@hyperframes/agent-protocol";
import { cn } from "../ui/cn";
import { formatDuration } from "./relativeTime";

/** The model's reasoning: closed by default, a live pulse while it streams, `Thought for Ns` after. */
export function ThinkingBlock({ part, live }: { part: ThinkingPart; live: boolean }) {
  const [open, setOpen] = useState(false);
  const panelId = useId();
  const streaming = live && !part.done;
  let label = "Thought";
  if (streaming) label = "Thinking…";
  else if (part.endedAt !== undefined) {
    label = `Thought for ${formatDuration(part.endedAt - part.startedAt)}`;
  }

  return (
    <div className="text-step-11 text-text-3">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => setOpen((value) => !value)}
        className={cn(
          "group inline-flex items-center gap-1 rounded-sm py-0.5 pr-1 text-text-3 outline-hidden",
          "transition-colors duration-hover hover:text-text-1",
          "focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-accent",
        )}
      >
        <CaretRight
          size={10}
          weight="bold"
          aria-hidden
          className={cn("transition-transform duration-expand", open && "rotate-90")}
        />
        <span className={cn(streaming && "animate-pulse motion-reduce:animate-none")}>{label}</span>
      </button>
      {open && (
        <div
          id={panelId}
          className="mt-1 whitespace-pre-wrap break-words border-l border-border-strong pl-2.5 leading-relaxed text-text-3"
        >
          {part.text || "Nothing to show yet."}
        </div>
      )}
    </div>
  );
}
