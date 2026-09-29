import { useEffect, useRef, useState } from "react";
import { ArrowLeft, PencilSimple } from "@phosphor-icons/react";
import { isThinkingEffort, type ThinkingEffort } from "@hyperframes/agent-protocol";
import { useAgentStore } from "../../agent/agentContext";
import { effortChoices, resolveModel, runningTurn } from "../../agent/agentSelectors";
import { cn } from "../ui/cn";
import { IconButton } from "../ui/IconButton";
import { Select, type SelectOption } from "../ui/Select";
import { ModelPicker } from "./ModelPicker";

const EFFORT_LABELS: Record<ThinkingEffort, string> = {
  off: "Off",
  minimal: "Minimal",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra high",
  max: "Max",
};

function EditableTitle({
  title,
  disabled,
  onCommit,
}: {
  title: string;
  disabled: boolean;
  onCommit: (title: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(title);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (editing) inputRef.current?.select();
  }, [editing]);

  const finish = (commit: boolean) => {
    setEditing(false);
    if (commit && draft.trim() && draft.trim() !== title) onCommit(draft.trim());
  };

  if (editing) {
    return (
      <input
        ref={inputRef}
        value={draft}
        aria-label="Chat title"
        maxLength={200}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={() => finish(true)}
        onKeyDown={(event) => {
          if (event.key === "Enter") finish(true);
          else if (event.key === "Escape") finish(false);
        }}
        className="h-ctl-sm min-w-0 flex-1 rounded-sm border border-border-strong bg-input px-1.5 text-step-12 font-medium text-text-0 outline-hidden focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-accent"
      />
    );
  }
  return (
    <button
      type="button"
      disabled={disabled}
      title={disabled ? "The title can't change while the agent is working." : "Rename chat"}
      aria-label={`Chat title: ${title}. Rename`}
      onClick={() => {
        setDraft(title);
        setEditing(true);
      }}
      className={cn(
        "group flex min-w-0 flex-1 items-center gap-1 rounded-sm px-1 py-0.5 text-left text-step-12 font-medium text-text-0",
        "outline-hidden transition-colors duration-hover enabled:hover:bg-hover",
        "focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-accent",
        "disabled:cursor-default",
      )}
    >
      <span className="truncate">{title}</span>
      {!disabled && (
        <PencilSimple
          size={11}
          aria-hidden
          className="shrink-0 text-text-4 opacity-0 transition-opacity duration-hover group-hover:opacity-100 group-focus-visible:opacity-100"
        />
      )}
    </button>
  );
}

function EffortControl({ locked }: { locked: boolean }) {
  const models = useAgentStore((state) => state.models);
  const explicit = useAgentStore((state) => state.chat?.chat.mainAgentModel ?? null);
  const thinking = useAgentStore((state) => state.chat?.chat.thinking ?? null);
  const setThinking = useAgentStore((state) => state.setThinking);

  const { info } = resolveModel(explicit, models);
  const choices = effortChoices(info);
  const defaultEffort = models?.defaultThinking ?? null;

  const options: SelectOption[] = [
    {
      value: "default",
      label: defaultEffort ? `Default (${EFFORT_LABELS[defaultEffort]})` : "Default",
    },
    ...choices.map((effort) => ({ value: effort, label: EFFORT_LABELS[effort] })),
  ];
  const value = thinking ?? "default";
  if (!options.some((option) => option.value === value)) {
    options.push({ value, label: isThinkingEffort(value) ? EFFORT_LABELS[value] : value });
  }

  return (
    <div
      className="w-32 shrink-0"
      title={choices.length === 0 ? "This model has no adjustable thinking effort." : undefined}
    >
      <Select
        label="Thinking effort"
        value={choices.length === 0 ? "default" : value}
        options={choices.length === 0 ? [{ value: "default", label: "Thinking: fixed" }] : options}
        disabled={locked || choices.length === 0}
        onCommit={(next) => {
          if (next === "default") void setThinking(null);
          else if (isThinkingEffort(next)) void setThinking(next);
        }}
        className="h-ctl-sm"
      />
    </div>
  );
}

/** Back to history, the chat's title, and its two model controls. */
export function ChatHeader() {
  const chat = useAgentStore((state) => state.chat);
  const models = useAgentStore((state) => state.models);
  const modelsFailed = useAgentStore((state) => state.modelsFailed);
  const closeChat = useAgentStore((state) => state.closeChat);
  const renameChat = useAgentStore((state) => state.renameChat);
  const setModel = useAgentStore((state) => state.setModel);
  const locked = runningTurn(chat) !== null;

  return (
    <header className="flex shrink-0 flex-col gap-1.5 border-b border-border px-2 py-2">
      <div className="flex items-center gap-1">
        <IconButton
          aria-label="Back to chats"
          size="sm"
          icon={<ArrowLeft size={14} aria-hidden />}
          onClick={closeChat}
        />
        <EditableTitle
          key={chat?.chat.id}
          title={chat?.chat.title ?? ""}
          disabled={locked || chat === null}
          onCommit={(title) => void renameChat(title)}
        />
      </div>
      <div className="flex items-center gap-1.5">
        <div className="min-w-0 flex-1">
          <ModelPicker
            catalog={models}
            catalogFailed={modelsFailed}
            explicit={chat?.chat.mainAgentModel ?? null}
            disabled={locked || chat === null}
            onSelect={(model) => void setModel(model)}
          />
        </div>
        <EffortControl locked={locked || chat === null} />
      </div>
    </header>
  );
}
