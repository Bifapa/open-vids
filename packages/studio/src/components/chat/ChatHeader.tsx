import { useEffect, useRef, useState } from "react";
import {
  ClockCounterClockwise,
  DotsThree,
  Globe,
  PencilSimple,
  Plus,
  Trash,
} from "@phosphor-icons/react";
import type { AgentRunStatus, ChatState, ChatSummary } from "@hyperframes/agent-protocol";
import { useAgentStore } from "../../agent/agentContext";
import { activeThread, runningTurn, type ThreadId } from "../../agent/agentSelectors";
import { openSettings } from "../settings/settingsStore";
import { cn } from "../ui/cn";
import { IconButton } from "../ui/IconButton";
import { Menu, MenuItem, MenuSeparator } from "../ui/Menu";
import { StatusDot, type StatusDotTone } from "../ui/Status";
import { useTranslation, type TranslationKey } from "../../i18n";
import { AgentCrumbs } from "./AgentCrumbs";
import { ChatUsage } from "./ChatUsage";
import { chatFocus } from "./chatStyles";
import { DeleteChatDialog } from "./DeleteChatDialog";
import { LinkedSitesDialog } from "./LinkedSitesDialog";
import { phaseLine } from "./phaseLine";
import { formatElapsed } from "./relativeTime";
import { useNow } from "./useNow";

type StatusKind = "queued" | "working" | "done" | "failed" | "stopped" | "interrupted" | "idle";

const STATUS_LABELS: Record<StatusKind, TranslationKey> = {
  queued: "chat.status.queued",
  working: "chat.status.working",
  done: "chat.status.done",
  failed: "chat.status.failed",
  stopped: "chat.status.stopped",
  interrupted: "chat.status.interrupted",
  idle: "chat.status.idle",
};

interface HeaderStatus {
  kind: StatusKind;
  tone: StatusDotTone;
  /** When the work being timed started; set only while it runs. */
  since: number | null;
}

const RUN_STATUS: Record<AgentRunStatus, Omit<HeaderStatus, "since">> = {
  queued: { kind: "queued", tone: "off" },
  running: { kind: "working", tone: "running" },
  completed: { kind: "done", tone: "ok" },
  failed: { kind: "failed", tone: "error" },
  aborted: { kind: "stopped", tone: "off" },
  cancelled: { kind: "stopped", tone: "off" },
  interrupted: { kind: "interrupted", tone: "warn" },
};

/** The open chat's state (or, in a subagent view, that agent's latest run). */
function liveStatus(chat: ChatState, thread: ThreadId): HeaderStatus {
  if (thread !== "main") {
    const run = chat.runs.filter((item) => item.agent === thread).pop();
    if (run) {
      const status = RUN_STATUS[run.status];
      return {
        kind: status.kind,
        tone: status.tone,
        since: run.status === "running" ? run.startedAt : null,
      };
    }
  }
  const running = runningTurn(chat);
  if (running) return { kind: "working", tone: "running", since: running.startedAt };
  const last = chat.turns[chat.turns.length - 1];
  if (!last) return { kind: "idle", tone: "off", since: null };
  if (last.status === "failed") return { kind: "failed", tone: "error", since: null };
  if (last.status === "interrupted") return { kind: "interrupted", tone: "warn", since: null };
  if (last.status === "aborted") return { kind: "stopped", tone: "off", since: null };
  return { kind: "done", tone: "ok", since: null };
}

/** A chat seen from the history list (no snapshot loaded). */
function summaryStatus(summary: ChatSummary, since: number | null): HeaderStatus {
  switch (summary.status) {
    case "working":
      return { kind: "working", tone: "running", since };
    case "completed":
      return { kind: "done", tone: "ok", since: null };
    case "failed":
      return { kind: "failed", tone: "error", since: null };
    case "interrupted":
      return { kind: "interrupted", tone: "warn", since: null };
    case "idle":
      return { kind: "idle", tone: "off", since: null };
  }
}

function StatusReadout({ status, phase }: { status: HeaderStatus; phase: string | null }) {
  const { t } = useTranslation();
  const timing = status.since !== null;
  const now = useNow(timing);
  const label = phase !== null && status.kind === "working" ? phase : t(STATUS_LABELS[status.kind]);
  return (
    <span
      aria-live="polite"
      data-testid="chat-status"
      data-status={status.kind}
      className={cn(
        "inline-flex min-w-0 shrink items-center gap-1.5 text-xs whitespace-nowrap tabular-nums",
        timing ? "text-fg-2" : "text-fg-3",
      )}
    >
      <StatusDot tone={status.tone} />
      <span
        data-testid="chat-phase"
        className={cn("min-w-0 truncate", timing && "@max-[299px]/chat:sr-only")}
      >
        {label}
      </span>
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
  const { t } = useTranslation();
  const [draft, setDraft] = useState(title);
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => inputRef.current?.select(), []);
  return (
    <input
      ref={inputRef}
      value={draft}
      aria-label={t("chat.header.titleField")}
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
  const { t } = useTranslation();
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
  const [dialog, setDialog] = useState<"sites" | "delete" | null>(null);

  const inChat = view === "chat" && chat !== null;
  const locked = inChat && runningTurn(chat) !== null;
  // While a chat loads (or history is open) the row shows the summary of the chat it is about.
  const shown = inChat ? chat.chat : contextChat;
  let status: HeaderStatus = { kind: "idle", tone: "off", since: null };
  if (inChat) status = liveStatus(chat, thread);
  else if (shown) {
    status = summaryStatus(shown, activeTurn?.chatId === shown.id ? activeTurn.startedAt : null);
  }
  // The phase of a long turn (Render QA pass, a render's progress) replaces the plain "Working"; the plan step is
  // in the pinned plan dock, not here.
  const phase = inChat && thread === "main" ? phaseLine(chat) : null;
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
          title={view === "history" ? t("chat.header.backToChat") : t("chat.header.openHistory")}
          className={cn(
            "inline-flex h-ctl-xs min-w-0 shrink items-center overflow-hidden rounded-sm px-1.5 text-left font-medium text-fg",
            "hover:bg-surface-2",
            chatFocus,
          )}
        >
          <span className="truncate">{shown?.title ?? t("chat.header.newChat")}</span>
        </button>
        {inChat && (
          <IconButton
            size="xs"
            aria-label={t("chat.header.renameLabel", { title: chat.chat.title })}
            aria-disabled={locked}
            title={locked ? t("chat.header.renameLocked") : t("chat.header.rename")}
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
      <StatusReadout status={status} phase={phase} />
      {inChat && <ChatUsage chat={chat} />}
      <div className="flex shrink-0 items-center">
        <IconButton
          size="sm"
          aria-label={t("chat.header.history")}
          aria-pressed={view === "history"}
          title={t("chat.header.history")}
          icon={<ClockCounterClockwise aria-hidden className="size-icon-md" />}
          onClick={showHistory}
        />
        <IconButton
          size="sm"
          aria-label={t("chat.header.newChat")}
          title={t("chat.header.newChat")}
          disabled={pending !== null}
          icon={<Plus aria-hidden className="size-icon-md" />}
          onClick={startDraft}
        />
        <Menu
          align="end"
          aria-label={t("chat.header.options")}
          trigger={
            <IconButton
              size="sm"
              aria-label={t("chat.header.options")}
              title={t("chat.header.options")}
              icon={<DotsThree aria-hidden weight="bold" className="size-icon-md" />}
            />
          }
        >
          <MenuItem icon={<ClockCounterClockwise aria-hidden />} onClick={showHistory}>
            {view === "history" ? t("chat.header.backToChatItem") : t("chat.header.history")}
          </MenuItem>
          <MenuSeparator />
          <MenuItem onClick={() => openSettings("agents")}>
            {t("chat.header.agentSettings")}
          </MenuItem>
          <MenuItem onClick={() => openSettings("execution")}>
            {t("chat.header.executionQuality")}
          </MenuItem>
          {inChat && <MenuSeparator />}
          {inChat && (
            <MenuItem icon={<Globe aria-hidden />} onClick={() => setDialog("sites")}>
              {t("chat.header.linkedSites")}
            </MenuItem>
          )}
          {inChat && (
            <MenuItem
              icon={<Trash aria-hidden />}
              tone="danger"
              disabled={locked}
              title={locked ? t("chat.delete.busyHint") : undefined}
              onClick={() => setDialog("delete")}
            >
              {t("chat.header.deleteChat")}
            </MenuItem>
          )}
        </Menu>
      </div>
      {inChat && dialog === "sites" && (
        <LinkedSitesDialog chat={chat.chat} onClose={() => setDialog(null)} />
      )}
      {inChat && dialog === "delete" && (
        <DeleteChatDialog chat={chat.chat} onClose={() => setDialog(null)} />
      )}
    </header>
  );
}
