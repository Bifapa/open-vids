import { TreeStructure } from "@phosphor-icons/react";
import { CHAT_MODES, type ChatMode } from "@hyperframes/agent-protocol";
import { useAgentStore } from "../../agent/agentContext";
import { runningTurn } from "../../agent/agentSelectors";
import { useDockLayoutStore } from "../dock/dockLayoutStore";
import { cn } from "../ui/cn";

const MODE_LABELS: Record<ChatMode, string> = { normal: "Normal", story: "Story" };

/** Normal | Story: what the chat's next turns do (edit the video, or plan it as the Story Graph). */
export function ChatModeSwitch() {
  const chat = useAgentStore((state) => state.chat);
  const setMode = useAgentStore((state) => state.setMode);
  const mode = chat?.chat.activeMode ?? "normal";
  const locked = chat === null || runningTurn(chat) !== null;
  return (
    <div
      role="radiogroup"
      aria-label="Chat mode"
      className="flex h-ctl shrink-0 items-center gap-0.5 rounded-md border border-border-input bg-bg-2 p-0.5"
    >
      {CHAT_MODES.map((option) => {
        const checked = option === mode;
        return (
          <button
            key={option}
            type="button"
            role="radio"
            aria-checked={checked}
            disabled={locked}
            title={
              option === "story"
                ? "Story mode: the agent plans the video as the Story Graph and leaves the timeline alone"
                : "Normal mode: the agent edits the video"
            }
            onClick={() => {
              if (!checked) void setMode(option);
            }}
            className={cn(
              "h-full rounded-sm px-2 text-step-10 font-medium outline-hidden transition-colors duration-hover",
              "focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-accent",
              "disabled:cursor-not-allowed disabled:opacity-50",
              checked ? "bg-hover text-text-0" : "text-text-3 enabled:hover:text-text-1",
            )}
          >
            {MODE_LABELS[option]}
          </button>
        );
      })}
    </div>
  );
}

/** Shown above the conversation in story mode: what the mode does, and the way to the canvas. */
export function StoryModeBanner() {
  const mode = useAgentStore((state) => state.chat?.chat.activeMode ?? "normal");
  const activatePanel = useDockLayoutStore((state) => state.activatePanel);
  if (mode !== "story") return null;
  return (
    <div
      className="flex shrink-0 items-center gap-2 border-b border-border bg-accent/5 px-3 py-1.5 text-step-11 text-text-2"
      data-testid="story-mode-banner"
    >
      <TreeStructure size={13} className="shrink-0 text-accent" aria-hidden />
      <span className="min-w-0 flex-1">
        Story mode: the agent plans the story and leaves the timeline alone.
      </span>
      <button
        type="button"
        onClick={() => activatePanel("story")}
        className="shrink-0 rounded-sm font-medium text-accent underline-offset-2 outline-hidden hover:underline focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-accent"
      >
        Open Story
      </button>
    </div>
  );
}
