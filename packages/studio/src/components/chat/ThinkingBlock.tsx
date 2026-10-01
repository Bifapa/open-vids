import { useId, useState } from "react";
import { Brain, CaretRight } from "@phosphor-icons/react";
import type { ThinkingPart } from "@hyperframes/agent-protocol";
import { useTranslation } from "../../i18n";
import { cn } from "../ui/cn";
import { chatFocus, chatMeasure } from "./chatStyles";
import { formatDuration } from "./relativeTime";
import { useNow } from "./useNow";

/** The model's reasoning: collapsed by default at metadata weight; `Thinking…` while it streams, `Thought for Ns` after. */
export function ThinkingBlock({ part, live }: { part: ThinkingPart; live: boolean }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const panelId = useId();
  const streaming = live && !part.done;
  const now = useNow(streaming);
  let meta = "";
  if (streaming) meta = formatDuration(now - part.startedAt);
  else if (part.endedAt !== undefined)
    meta = t("chat.thinking.thoughtFor", {
      duration: formatDuration(part.endedAt - part.startedAt),
    });

  return (
    <section className={cn("grid min-w-0 justify-items-start", chatMeasure)}>
      <button
        type="button"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => setOpen((value) => !value)}
        className={cn(
          "-ml-1 inline-flex h-ctl-xs items-center gap-1 rounded-sm pr-1.5 pl-[3px] text-xs font-medium text-fg-3",
          "transition-colors duration-hover hover:bg-surface-2 hover:text-fg-2",
          chatFocus,
        )}
      >
        <CaretRight
          aria-hidden
          className={cn("size-icon-sm transition-transform duration-expand", open && "rotate-90")}
        />
        <Brain aria-hidden className="size-icon-sm" />
        <span className={cn(streaming && "animate-pulse motion-reduce:animate-none")}>
          {streaming ? t("chat.thinking.live") : t("chat.thinking.title")}
        </span>
        {meta && <span className="font-normal tabular-nums text-fg-3">{meta}</span>}
      </button>
      {open && (
        <div
          id={panelId}
          className="mt-[3px] ml-[3px] border-l border-border py-px pl-[11px] text-sm leading-[17px] whitespace-pre-wrap text-fg-3 [overflow-wrap:anywhere] text-pretty"
        >
          {part.text || t("chat.thinking.empty")}
        </div>
      )}
    </section>
  );
}
