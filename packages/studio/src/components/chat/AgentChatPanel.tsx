import { Component, useEffect, useRef, type ErrorInfo, type ReactNode } from "react";
import { ChatCircleDots } from "@phosphor-icons/react";
import { AgentStoreProvider, useAgentStore, useProjectAgentStore } from "../../agent/agentContext";
import { useEditorContextSource } from "../../agent/editorContext";
import { Button } from "../ui/Button";
import { ChatView } from "./ChatView";
import { HistoryView } from "./HistoryView";

function Calm({ title, detail, action }: { title: string; detail?: string; action?: ReactNode }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center">
      <ChatCircleDots size={22} aria-hidden className="text-text-4" />
      <p className="text-step-12 font-medium text-text-1">{title}</p>
      {detail && <p className="max-w-[26ch] text-step-11 text-text-3">{detail}</p>}
      {action}
    </div>
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
    return (
      <Calm
        title="Chat hit a problem"
        detail="The editor is unaffected."
        action={
          <Button size="sm" variant="secondary" onClick={() => this.setState({ failed: false })}>
            Reload chat
          </Button>
        }
      />
    );
  }
}

/** Everything under the store: availability states, then the history or chat view. */
export function AgentChatBody() {
  const availability = useAgentStore((state) => state.availability);
  const message = useAgentStore((state) => state.unavailableMessage);
  const view = useAgentStore((state) => state.view);
  const retry = useAgentStore((state) => state.retry);
  const title = useAgentStore((state) => state.chat?.chat.title);

  // After a view switch, focus lands on the new view instead of on a control that just left.
  const regionRef = useRef<HTMLDivElement>(null);
  const previousView = useRef(view);
  useEffect(() => {
    if (previousView.current === view) return;
    previousView.current = view;
    regionRef.current?.focus();
  }, [view]);

  if (availability === "loading") return <Calm title="Loading chats…" />;
  if (availability === "unavailable") {
    return (
      <Calm
        title="Agent unavailable"
        detail={message ?? "The agent isn't running right now. Your project is unaffected."}
        action={
          <Button size="sm" variant="secondary" onClick={() => void retry()}>
            Retry
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
      aria-label={view === "chat" ? `Chat: ${title ?? ""}` : "Chat history"}
      className="h-full min-h-0 outline-hidden"
    >
      {view === "chat" ? <ChatView /> : <HistoryView />}
    </div>
  );
}

/** The Chat dock panel: a project's saved agent chats and the live conversation. */
export function AgentChatPanel({
  projectId,
  onReverted,
}: {
  projectId: string;
  /** Refreshes the editor once a revert has rewritten project files. */
  onReverted: () => void | Promise<void>;
}) {
  const editorContext = useEditorContextSource(projectId);
  const store = useProjectAgentStore(projectId, editorContext, onReverted);
  return (
    <div className="flex h-full min-h-0 flex-col bg-bg-1 text-text-1">
      <PanelBoundary>
        {store ? (
          <AgentStoreProvider store={store}>
            <AgentChatBody />
          </AgentStoreProvider>
        ) : (
          <Calm title="Loading chats…" />
        )}
      </PanelBoundary>
    </div>
  );
}
