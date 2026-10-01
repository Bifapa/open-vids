import { useEffect, useRef, useState } from "react";
import { ClockCounterClockwise, DotsThree, PencilSimple, Plus } from "@phosphor-icons/react";
import type { AgentRunStatus, ChatState, ChatSummary } from "@hyperframes/agent-protocol";
import { useAgentStore } from "../../agent/agentContext";
import { activeThread, runningTurn, type ThreadId } from "../../agent/agentSelectors";
import { openSettings } from "../settings/settingsStore";
import { cn } from "../ui/cn";
import { IconButton } from "../ui/IconButton";
import { Menu, MenuItem, MenuSeparator } from "../ui/Menu";
import { StatusDot, type StatusDotTone } from "../ui/Status";
import { AgentCrumbs } from "./AgentCrumbs";
import { chatFocus } from "./chatStyles";
import { formatElapsed } from "./relativeTime";
import { useNow } from "./useNow";

interface HeaderStatus {
  label: string;
  tone: StatusDotTone;
  /** When the work being timed started; set only while it runs. */
  since: number | null;
}

const RUN_STATUS: Record<AgentRunStatus, Omit<HeaderStatus, "since">> = {
  queued: { label: "Queued", tone: "off" },
  running: { label: "Working", tone: "running" },
  completed: { label: "Done", tone: "ok" },
  failed: { label: "Failed", tone: "error" },
  aborted: { label: "Stopped", tone: "off" },
  cancelled: { label: "Stopped", tone: "off" },
  interrupted: { label: "Interrupted", tone: "warn" },
};

/** The open chat's state (or, in a subagent view, that agent's latest run). */
function liveStatus(chat: ChatState, thread: ThreadId): HeaderStatus {
  if (thread !== "main") {
    const run = chat.runs.filter((item) => item.agent === thread).pop();
    if (run) {
      const status = RUN_STATUS[run.status];
      return {
        label: status.label,
        tone: status.tone,
        since: run.status === "running" ? run.startedAt : null,
      };
    }
  }
  const running = runningTurn(chat);
  if (running) return { label: "Working", tone: "running", since: running.startedAt };
  const last = chat.turns[chat.turns.length - 1];
  if (!last) return { label: "Idle", tone: "off", since: null };
  if (last.status === "failed") return { label: "Failed", tone: "error", since: null };
  if (last.status === "interrupted") return { label: "Interrupted", tone: "warn", since: null };
  if (last.status === "aborted") return { label: "Stopped", tone: "off", since: null };
  return { label: "Done", tone: "ok", since: null };
}

/** A chat seen from the history list (no snapshot loaded). */
function summaryStatus(summary: ChatSummary, since: number | null): HeaderStatus {
  switch (summary.status) {
    case "working":
      return { label: "Working", tone: "running", since };
    case "completed":
      return { label: "Done", tone: "ok", since: null };
    case "failed":
      return { label: "Failed", tone: "error", since: null };
    case "interrupted":
      return { label: "Interrupted", tone: "warn", since: null };
    case "idle":
      return { label: "Idle", tone: "off", since: null };
  }
}

function StatusReadout({ status }: { status: HeaderStatus }) {
  const timing = status.since !== null;
  const now = useNow(timing);
  return (
    <span
      aria-live="polite"
      data-testid="chat-status"
      data-status={status.label.toLowerCase()}
      className={cn(
        "inline-flex shrink-0 items-center gap-1.5 text-xs whitespace-nowrap tabular-nums",
        timing ? "text-fg-2" : "text-fg-3",
      )}
    >
      <StatusDot tone={status.tone} />
      <span className={cn(timing && "@max-[299px]/chat:sr-only")}>{status.label}</span>
      {status.since !== null && (
        <>
          <span aria-hidden className="@max-[299px]/chat:hidden">
            ·
          </span>
          <span className="font-mono text-num">{formatElapsed(now - status.since)}</span>
        </>
      )}
    </span>
  );
}

function RenameInput({ title, onDone }: { title: string; onDone: (value: string | null) => void }) {
  const [draft, setDraft] = useState(title);
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => inputRef.current?.select(), []);
  return (
    <input
      ref={inputRef}
      value={draft}
      aria-label="Chat title"
      maxLength={200}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={() => onDone(draft)}
      onKeyDown={(event) => {
        if (event.key === "Enter") onDone(draft);
        else if (event.key === "Escape") onDone(null);
      }}
      className={cn(
        "h-ctl-sm min-w-0 flex-1 rounded-sm border border-border-strong bg-surface-1 px-1.5 text-sm font-medium text-fg",
        chatFocus,
      )}
    />
  );
}

/**
 * The chat's context row: its title (opens history) with an inline rename pencil — or, in a subagent view, the
 * `Main / Agent` breadcrumbs — the run status with a live timer, and History, New chat and More.
 * `contextChat` is the chat the row is about while no snapshot is loaded (loading, or history open); null is the
 * new-chat draft.
 */
export function ChatHeader({ contextChat }: { contextChat: ChatSummary | null }) {
  const view = useAgentStore((state) => state.view);
  const chat = useAgentStore((state) => state.chat);
  const activeTurn = useAgentStore((state) => state.activeTurn);
  const pending = useAgentStore((state) => state.pending);
  const thread = useAgentStore((state) => activeThread(state.threads, state.chat));
  const closeChat = useAgentStore((state) => state.closeChat);
  const openChat = useAgentStore((state) => state.openChat);
  const startDraft = useAgentStore((state) => state.startDraft);
  const renameChat = useAgentStore((state) => state.renameChat);
  const selectThread = useAgentStore((state) => state.selectThread);
  const [renaming, setRenaming] = useState(false);

  const inChat = view === "chat" && chat !== null;
  const locked = inChat && runningTurn(chat) !== null;
  // While a chat loads (or history is open) the row shows the summary of the chat it is about.
  const shown = inChat ? chat.chat : contextChat;
  let status: HeaderStatus = { label: "Idle", tone: "off", since: null };
  if (inChat) status = liveStatus(chat, thread);
  else if (shown) {
    status = summaryStatus(shown, activeTurn?.chatId === shown.id ? activeTurn.startedAt : null);
  }
  const showHistory = () => {
    if (view !== "history") closeChat();
    else if (shown) void openChat(shown.id);
    else startDraft();
  };
  const startRename = () => {
    if (!locked && inChat) setRenaming(true);
  };

  let lead;
  if (inChat && thread !== "main") {
    lead = <AgentCrumbs runs={chat.runs} active={thread} onSelect={selectThread} />;
  } else if (renaming && inChat) {
    lead = (
      <RenameInput
        key={chat.chat.id}
        title={chat.chat.title}
        onDone={(value) => {
          setRenaming(false);
          if (value !== null) void renameChat(value);
        }}
      />
    );
  } else {
    lead = (
      <>
        <button
          type="button"
          onClick={showHistory}
          title={view === "history" ? "Back to this chat" : "Open chat history"}
          className={cn(
            "inline-flex h-ctl-xs min-w-0 shrink items-center overflow-hidden rounded-sm px-1.5 text-left font-medium text-fg",
            "hover:bg-surface-2",
            chatFocus,
          )}
        >
          <span className="truncate">{shown?.title ?? "New chat"}</span>
        </button>
        {inChat && (
          <IconButton
            size="xs"
            aria-label={`Rename chat: ${chat.chat.title}`}
            aria-disabled={locked}
            title={locked ? "The title can’t change while the agent is working" : "Rename chat"}
            icon={<PencilSimple aria-hidden className="size-icon-sm" />}
            onClick={startRename}
            className={cn(
              "-ml-1 text-fg-3 opacity-0 group-hover/ctx:opacity-100 focus-visible:opacity-100",
              locked && "cursor-default text-fg-disabled hover:bg-transparent",
            )}
          />
        )}
      </>
    );
  }

  return (
    <header
      data-testid="chat-context"
      className="group/ctx flex h-row-sm shrink-0 min-w-0 items-center gap-1.5 border-b border-border-subtle bg-bg-0 pr-1 pl-1.5 text-sm @min-[440px]/chat:pl-2.5"
    >
      {lead}
      <span className="ml-auto" />
      <StatusReadout status={status} />
      <div className="flex shrink-0 items-center">
        <IconButton
          size="sm"
          aria-label="Chat history"
          aria-pressed={view === "history"}
          title="Chat history"
          icon={<ClockCounterClockwise aria-hidden className="size-icon-md" />}
          onClick={showHistory}
        />
        <IconButton
          size="sm"
          aria-label="New chat"
          title="New chat"
          disabled={pending !== null}
          icon={<Plus aria-hidden className="size-icon-md" />}
          onClick={startDraft}
        />
        <Menu
          align="end"
          aria-label="Chat options"
          trigger={
            <IconButton
              size="sm"
              aria-label="Chat options"
              title="Chat options"
              icon={<DotsThree aria-hidden weight="bold" className="size-icon-md" />}
            />
          }
        >
          <MenuItem icon={<ClockCounterClockwise aria-hidden />} onClick={showHistory}>
            {view === "history" ? "Back to chat" : "Chat history"}
          </MenuItem>
          <MenuSeparator />
          <MenuItem onClick={() => openSettings("agents")}>Agent settings…</MenuItem>
          <MenuItem onClick={() => openSettings("execution")}>Execution quality…</MenuItem>
        </Menu>
      </div>
    </header>
  );
}
