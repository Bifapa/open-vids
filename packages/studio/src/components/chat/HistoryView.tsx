import { useEffect, useState } from "react";
import { Plus } from "@phosphor-icons/react";
import type { ChatStatus, ChatSummary } from "@hyperframes/agent-protocol";
import { useAgentStore } from "../../agent/agentContext";
import { Button } from "../ui/Button";
import { cn } from "../ui/cn";
import { relativeTime } from "./relativeTime";

const STATUS: Record<ChatStatus, { label: string; tone: string }> = {
  idle: { label: "Idle", tone: "bg-surface text-text-3" },
  working: { label: "Working", tone: "bg-accent/15 text-accent" },
  interrupted: { label: "Interrupted", tone: "bg-container/15 text-container" },
  completed: { label: "Completed", tone: "bg-surface text-text-2" },
  failed: { label: "Failed", tone: "bg-danger/15 text-danger" },
};

export function StatusBadge({ status }: { status: ChatStatus }) {
  const { label, tone } = STATUS[status];
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center gap-1 rounded-sm px-1.5 py-px text-step-10 font-medium",
        tone,
      )}
    >
      {status === "working" && (
        <span
          aria-hidden
          className="size-1.5 animate-pulse rounded-full bg-accent motion-reduce:animate-none"
        />
      )}
      {label}
    </span>
  );
}

function ChatRow({ chat, now, onOpen }: { chat: ChatSummary; now: number; onOpen: () => void }) {
  return (
    <li>
      <button
        type="button"
        onClick={onOpen}
        className={cn(
          "flex w-full flex-col gap-1 border-b border-hairline px-3 py-2.5 text-left outline-hidden",
          "transition-colors duration-hover hover:bg-hover/40",
          "focus-visible:outline-solid focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent",
        )}
      >
        <span className="flex items-center gap-2">
          <span className="min-w-0 flex-1 truncate text-step-12 font-medium text-text-0">
            {chat.title}
          </span>
          <StatusBadge status={chat.status} />
        </span>
        <span className="flex items-center gap-2 text-step-10 text-text-4">
          <time dateTime={new Date(chat.updatedAt).toISOString()}>
            {relativeTime(chat.updatedAt, now)}
          </time>
        </span>
        {chat.lastTaskSummary && (
          <span className="line-clamp-2 text-step-11 text-text-3">{chat.lastTaskSummary}</span>
        )}
      </button>
    </li>
  );
}

/** The project's saved chats, newest first; the first screen of the panel. */
export function HistoryView() {
  const chats = useAgentStore((state) => state.chats);
  const activeTurn = useAgentStore((state) => state.activeTurn);
  const pending = useAgentStore((state) => state.pending);
  const notice = useAgentStore((state) => state.notice);
  const newChat = useAgentStore((state) => state.newChat);
  const openChat = useAgentStore((state) => state.openChat);
  const dismissNotice = useAgentStore((state) => state.dismissNotice);

  // Relative times move on; a minute is the finest step they show.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, []);

  const working = activeTurn ? chats.find((chat) => chat.id === activeTurn.chatId) : undefined;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center justify-between gap-2 border-b border-border px-3 py-2">
        <h2 className="text-step-12 font-semibold text-text-0">Chats</h2>
        <Button
          size="sm"
          variant="primary"
          icon={<Plus size={12} weight="bold" aria-hidden />}
          loading={pending === "create"}
          onClick={() => void newChat()}
        >
          New chat
        </Button>
      </div>
      {activeTurn && (
        <div
          role="status"
          className="flex shrink-0 items-center justify-between gap-2 border-b border-border bg-accent/5 px-3 py-2 text-step-11 text-text-2"
        >
          <span>
            {working ? `“${working.title}”` : "A chat"} is working on this project. Other chats can
            wait for it to finish.
          </span>
          <Button size="sm" variant="secondary" onClick={() => void openChat(activeTurn.chatId)}>
            Open
          </Button>
        </div>
      )}
      {notice && (
        <div
          role="alert"
          className="flex shrink-0 items-start justify-between gap-2 border-b border-border bg-danger/10 px-3 py-2 text-step-11 text-text-1"
        >
          <span>{notice.message}</span>
          <button
            type="button"
            onClick={dismissNotice}
            className="shrink-0 text-text-3 underline underline-offset-2 hover:text-text-0"
          >
            Dismiss
          </button>
        </div>
      )}
      {chats.length === 0 ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-1 px-6 text-center">
          <p className="text-step-12 font-medium text-text-1">No chats yet</p>
          <p className="text-step-11 text-text-3">
            Start a chat to ask the agent about this project. Chats are saved with it.
          </p>
        </div>
      ) : (
        <ul aria-label="Chats" className="min-h-0 flex-1 overflow-y-auto">
          {chats.map((chat) => (
            <ChatRow key={chat.id} chat={chat} now={now} onOpen={() => void openChat(chat.id)} />
          ))}
        </ul>
      )}
    </div>
  );
}
