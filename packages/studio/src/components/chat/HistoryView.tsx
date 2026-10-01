import { Plus } from "@phosphor-icons/react";
import type { ChatStatus, ChatSummary } from "@hyperframes/agent-protocol";
import { useAgentStore } from "../../agent/agentContext";
import { useTranslation, type TranslationKey } from "../../i18n";
import { Button } from "../ui/Button";
import { cn } from "../ui/cn";
import { Badge, StatusDot, type StatusTone } from "../ui/Status";
import { chatLink, chatPadX, noteBox, sectLabel, selItem } from "./chatStyles";
import { relativeTime } from "./relativeTime";
import { useNow } from "./useNow";

const STATUS: Record<ChatStatus, { label: TranslationKey; tone: StatusTone } | null> = {
  idle: null,
  working: { label: "chat.status.working", tone: "neutral" },
  interrupted: { label: "chat.status.interrupted", tone: "warning" },
  completed: { label: "chat.status.done", tone: "success" },
  failed: { label: "chat.status.failed", tone: "error" },
};

function ChatStatusBadge({ status }: { status: ChatStatus }) {
  const { t } = useTranslation();
  const shown = STATUS[status];
  if (!shown) return null;
  return (
    <Badge size="sm" tone={shown.tone}>
      {status === "working" && <StatusDot tone="running" />}
      {t(shown.label)}
    </Badge>
  );
}

function ChatRow({
  chat,
  now,
  selected,
  onOpen,
}: {
  chat: ChatSummary;
  now: number;
  selected: boolean;
  onOpen: () => void;
}) {
  return (
    <li className="relative before:absolute before:inset-x-2 before:-top-px before:h-px before:bg-border-subtle first:before:hidden">
      <button
        type="button"
        onClick={onOpen}
        aria-current={selected ? "true" : undefined}
        className={cn(
          selItem,
          "relative grid w-full content-center gap-[3px] p-2 text-left @max-[299px]/chat:px-1.5 @max-[299px]/chat:py-[7px] @min-[440px]/chat:px-2.5 @min-[440px]/chat:py-[9px]",
          selected &&
            "border-accent-line bg-accent-soft hover:border-accent-line hover:bg-accent-soft",
        )}
      >
        <span className="flex min-w-0 items-center gap-1.5">
          <span className="min-w-0 flex-1 truncate text-base leading-4 font-medium text-fg">
            {chat.title}
          </span>
          <ChatStatusBadge status={chat.status} />
          <time
            dateTime={new Date(chat.updatedAt).toISOString()}
            className="min-w-11 shrink-0 text-right font-mono text-num leading-[14px] whitespace-nowrap text-fg-3 tabular-nums @max-[299px]/chat:min-w-0"
          >
            {relativeTime(chat.updatedAt, now)}
          </time>
        </span>
        {chat.lastTaskSummary && (
          <span className="min-w-0 truncate text-xs leading-[14px] text-fg-3 tabular-nums">
            {chat.lastTaskSummary}
          </span>
        )}
      </button>
    </li>
  );
}

/** The project's saved chats, newest first; the chat the title row shows is selected. */
export function HistoryView({ selectedId }: { selectedId: string | null }) {
  const { t } = useTranslation();
  const chats = useAgentStore((state) => state.chats);
  const activeTurn = useAgentStore((state) => state.activeTurn);
  const pending = useAgentStore((state) => state.pending);
  const notice = useAgentStore((state) => state.notice);
  const startDraft = useAgentStore((state) => state.startDraft);
  const openChat = useAgentStore((state) => state.openChat);
  const dismissNotice = useAgentStore((state) => state.dismissNotice);
  // Relative times move on; a minute is the finest step they show.
  const now = useNow(true, 30_000);

  const working = activeTurn ? chats.find((chat) => chat.id === activeTurn.chatId) : undefined;

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto overscroll-contain">
      <div
        className={cn(
          "sticky top-0 z-[2] flex shrink-0 items-center gap-2 bg-bg-0 pt-2.5 pb-2",
          chatPadX,
        )}
      >
        <h2 className={cn(sectLabel, "items-center truncate")}>
          {t("chat.history.title")}
          <span className="font-normal text-fg-3 tabular-nums">{chats.length}</span>
        </h2>
        <Button
          size="sm"
          variant="primary"
          className="ml-auto shrink-0"
          icon={<Plus aria-hidden weight="bold" className="size-icon-sm" />}
          disabled={pending !== null}
          onClick={startDraft}
        >
          {t("chat.header.newChat")}
        </Button>
      </div>
      {(activeTurn || notice) && (
        <div className={cn("grid gap-2 pb-2", chatPadX)}>
          {activeTurn && (
            <div role="status" className={cn(noteBox, "text-xs leading-[15px]")}>
              <p>
                {working
                  ? t("chat.history.busyNamed", { title: working.title })
                  : t("chat.history.busyOther")}
              </p>
              <div className="flex">
                <Button size="sm" onClick={() => void openChat(activeTurn.chatId)}>
                  {t("common.open")}
                </Button>
              </div>
            </div>
          )}
          {notice && (
            <div
              role="alert"
              className={cn(
                noteBox,
                "border-error/35 bg-error-soft text-xs leading-[15px] text-fg",
              )}
            >
              <p>{notice.message}</p>
              <button
                type="button"
                onClick={dismissNotice}
                className={cn(chatLink, "justify-self-start text-xs")}
              >
                {t("common.dismiss")}
              </button>
            </div>
          )}
        </div>
      )}
      {chats.length === 0 ? (
        <div className={cn("flex flex-1 flex-col justify-end gap-1 pt-4 pb-2.5", chatPadX)}>
          <p className="text-sm font-medium text-fg-2">{t("chat.history.empty.title")}</p>
          <p className="max-w-[36ch] text-sm leading-[17px] text-pretty text-fg-3">
            {t("chat.history.empty.description")}
          </p>
        </div>
      ) : (
        <ul
          aria-label={t("chat.history.list")}
          className="grid gap-px px-1.5 pb-2.5 @min-[440px]/chat:px-2.5 @min-[440px]/chat:pb-3"
        >
          {chats.map((chat) => (
            <ChatRow
              key={chat.id}
              chat={chat}
              now={now}
              selected={chat.id === selectedId}
              onOpen={() => void openChat(chat.id)}
            />
          ))}
        </ul>
      )}
    </div>
  );
}
