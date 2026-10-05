import { useEffect, useState } from "react";
import type { ChatState } from "@hyperframes/agent-protocol";
import { useAgentStore } from "../../agent/agentContext";
import { describeTurnError, isNoModelMessage } from "../../agent/agentErrors";
import { NO_MODEL_TITLE } from "./ConnectModel";
import { t, useTranslation } from "../../i18n";
import { activeThread, runningTurn } from "../../agent/agentSelectors";
import { Button } from "../ui/Button";
import { cn } from "../ui/cn";
import { activityText } from "./ActivityRow";
import { chatPadX } from "./chatStyles";
import { Composer } from "./Composer";
import { EmptyChat, MessageList } from "./MessageList";

const ANNOUNCE_EVERY_MS = 2000;

/** One sentence for assistive tech about where the run is; changes only on real progress. */
export function statusSentence(chat: ChatState | null): string {
  if (!chat) return "";
  const running = runningTurn(chat);
  if (running) {
    const message = chat.messages.find((item) => item.id === running.assistantMessageId);
    if (message?.role === "assistant") {
      for (let index = message.parts.length - 1; index >= 0; index -= 1) {
        const part = message.parts[index];
        if (part?.type === "activity" && part.activity.status === "running") {
          const { label, labelCode, labelParams } = part.activity;
          return activityText(label, labelCode, labelParams);
        }
      }
    }
    return t("chat.view.working");
  }
  const last = chat.turns[chat.turns.length - 1];
  if (!last) return "";
  if (last.status === "completed") return t("chat.view.finished");
  if (last.status === "aborted") return t("chat.view.stopped");
  if (last.status === "failed") {
    const message = last.error && describeTurnError(last.error.code, last.error.message);
    if (message && isNoModelMessage(message)) return t(NO_MODEL_TITLE);
    return message ?? t("chat.view.failed");
  }
  return "";
}

/** Holds each announcement for at least `ms`, so a fast stream cannot flood a screen reader. */
function useThrottledText(text: string, ms: number): string {
  const [shown, setShown] = useState(text);
  useEffect(() => {
    if (text === shown) return;
    const timer = setTimeout(() => setShown(text), ms);
    return () => clearTimeout(timer);
  }, [text, shown, ms]);
  return shown;
}

function LoadFailure({
  message,
  onRetry,
  onBack,
}: {
  message: string;
  onRetry: () => void;
  onBack: () => void;
}) {
  return (
    <div
      role="alert"
      className="flex flex-1 flex-col items-center justify-center gap-3 px-6 text-center"
    >
      <p className="text-sm text-fg-2">{message}</p>
      <div className="flex gap-2">
        <Button size="sm" variant="secondary" onClick={onRetry}>
          {t("common.tryAgain")}
        </Button>
        <Button size="sm" variant="ghost" onClick={onBack}>
          {t("chat.view.backToChats")}
        </Button>
      </div>
    </div>
  );
}

export function ChatView() {
  useTranslation();
  const chat = useAgentStore((state) => state.chat);
  const chatId = useAgentStore((state) => state.chatId);
  const loading = useAgentStore((state) => state.chatLoading);
  const error = useAgentStore((state) => state.chatError);
  const streamStatus = useAgentStore((state) => state.streamStatus);
  const thread = useAgentStore((state) => activeThread(state.threads, state.chat));
  const openChat = useAgentStore((state) => state.openChat);
  const closeChat = useAgentStore((state) => state.closeChat);

  const announcement = useThrottledText(statusSentence(chat), ANNOUNCE_EVERY_MS);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {error && chatId ? (
        <LoadFailure message={error} onRetry={() => void openChat(chatId)} onBack={closeChat} />
      ) : chatId === null && !loading ? (
        // The new-chat draft: hint and suggestions over the composer; the first send creates the chat.
        <>
          <div className={cn("flex min-h-0 flex-1 flex-col overflow-y-auto", chatPadX)}>
            <EmptyChat />
          </div>
          <Composer />
        </>
      ) : loading || !chat ? (
        <div className="flex flex-1 items-center justify-center text-xs text-fg-3" role="status">
          {t("chat.view.loading")}
        </div>
      ) : (
        <>
          {streamStatus === "reconnecting" && (
            <p
              role="status"
              className="shrink-0 border-b border-border-subtle bg-warning-soft px-3 py-1 text-xs text-warning"
            >
              {t("chat.view.reconnecting")}
            </p>
          )}
          {/* A new thread is a new page: it starts at its newest content. */}
          <MessageList key={thread} chat={chat} thread={thread} />
          <Composer />
        </>
      )}
      <div role="status" aria-live="polite" aria-atomic className="sr-only">
        {announcement}
      </div>
    </div>
  );
}
