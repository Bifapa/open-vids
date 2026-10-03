import { Component, useEffect, useRef, useState, type ErrorInfo, type ReactNode } from "react";
import { ChatCircleDots } from "@phosphor-icons/react";
import { AgentStoreProvider, useAgentStore } from "../../agent/agentContext";
import type { ChatSummary } from "@hyperframes/agent-protocol";
import { NEW_CHAT_DRAFT, type AgentStore } from "../../agent/agentStore";
import { useTranslation } from "../../i18n";
import { Button } from "../ui/Button";
import { ChatDropZone } from "./ChatDropZone";
import { ChatHeader } from "./ChatHeader";
import { ChatView } from "./ChatView";
import { HistoryView } from "./HistoryView";

function Calm({ title, detail, action }: { title: string; detail?: string; action?: ReactNode }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center">
      <ChatCircleDots aria-hidden className="size-icon-xl text-fg-3" />
      <p className="text-sm font-medium text-fg-2">{title}</p>
      {detail && <p className="max-w-[26ch] text-xs text-fg-3">{detail}</p>}
      {action}
    </div>
  );
}

function PanelCrashed({ onReload }: { onReload: () => void }) {
  const { t } = useTranslation();
  return (
    <Calm
      title={t("chat.panel.crashed.title")}
      detail={t("chat.panel.crashed.detail")}
      action={
        <Button size="sm" variant="secondary" onClick={onReload}>
          {t("chat.panel.crashed.reload")}
        </Button>
      }
    />
  );
}

/** The agent is a guest in the editor: whatever goes wrong here stays inside this panel. */
class PanelBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("[Studio] Agent chat panel crashed:", error, info.componentStack);
  }

  render() {
    if (!this.state.failed) return this.props.children;
    return <PanelCrashed onReload={() => this.setState({ failed: false })} />;
  }
}

/** Everything under the store: availability states, then the context row over the history or chat view. */
export function AgentChatBody() {
  const { t } = useTranslation();
  const availability = useAgentStore((state) => state.availability);
  const message = useAgentStore((state) => state.unavailableMessage);
  const view = useAgentStore((state) => state.view);
  const retry = useAgentStore((state) => state.retry);
  const title = useAgentStore((state) => state.chat?.chat.title);
  const chatId = useAgentStore((state) => state.chatId);
  const chats = useAgentStore((state) => state.chats);

  // History returns to where it was opened from: a chat, or the new-chat draft. Opened straight from a fresh
  // panel it is about the most recent chat. The context row shows that chat meanwhile (prototype).
  const [lastVisited, setLastVisited] = useState<string | null>(null);
  useEffect(() => {
    if (view === "chat") setLastVisited(chatId ?? NEW_CHAT_DRAFT);
  }, [view, chatId]);
  const visited = chats.find((chat) => chat.id === lastVisited) ?? null;
  let contextChat: ChatSummary | null = null;
  if (view === "chat") contextChat = chats.find((chat) => chat.id === chatId) ?? null;
  else if (lastVisited !== NEW_CHAT_DRAFT) contextChat = visited ?? chats[0] ?? null;

  // After a view switch, focus lands on the new view instead of on a control that just left.
  const regionRef = useRef<HTMLDivElement>(null);
  const previousView = useRef(view);
  useEffect(() => {
    if (previousView.current === view) return;
    previousView.current = view;
    regionRef.current?.focus();
  }, [view]);

  if (availability === "loading") return <Calm title={t("chat.panel.loading")} />;
  if (availability === "unavailable") {
    return (
      <Calm
        title={t("chat.panel.unavailable.title")}
        detail={message ?? t("chat.panel.unavailable.detail")}
        action={
          <Button size="sm" variant="secondary" onClick={() => void retry()}>
            {t("common.retry")}
          </Button>
        }
      />
    );
  }
  return (
    <div
      ref={regionRef}
      tabIndex={-1}
      role="region"
      aria-label={
        view === "chat"
          ? t("chat.panel.region.chat", { title: title ?? "" })
          : t("chat.panel.region.history")
      }
      data-chat-overlay=""
      className="relative flex h-full min-h-0 flex-col outline-hidden"
    >
      <ChatHeader contextChat={contextChat} />
      {view === "chat" ? <ChatView /> : <HistoryView selectedId={visited?.id ?? null} />}
    </div>
  );
}

/**
 * The Chat dock panel: a project's saved agent chats and the live conversation. The store is the project's
 * (created by the dock, shared with the Story panel); null while it is being created.
 */
export function AgentChatPanel({ store }: { store: AgentStore | null }) {
  const { t } = useTranslation();
  return (
    <div data-chat-panel className="@container/chat flex h-full min-h-0 flex-col bg-bg-0 text-fg">
      <PanelBoundary>
        {store ? (
          <AgentStoreProvider store={store}>
            <ChatDropZone>
              <AgentChatBody />
            </ChatDropZone>
          </AgentStoreProvider>
        ) : (
          // No store yet: a drop here still must not land on the timeline.
          <div
            className="h-full"
            onDragOver={(event) => event.preventDefault()}
            onDrop={(event) => event.preventDefault()}
          >
            <Calm title={t("chat.panel.loading")} />
          </div>
        )}
      </PanelBoundary>
    </div>
  );
}
