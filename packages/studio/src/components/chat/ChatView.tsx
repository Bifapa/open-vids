import { useEffect, useState } from "react";
import type { ChatState } from "@hyperframes/agent-protocol";
import { useAgentStore } from "../../agent/agentContext";
import { describeTurnError } from "../../agent/agentErrors";
import { runningTurn } from "../../agent/agentSelectors";
import { Button } from "../ui/Button";
import { ChatHeader } from "./ChatHeader";
import { Composer } from "./Composer";
import { MessageList } from "./MessageList";

const ANNOUNCE_EVERY_MS = 2000;

/** One sentence for assistive tech about where the run is; changes only on real progress. */
function statusSentence(chat: ChatState | null): string {
  if (!chat) return "";
  const running = runningTurn(chat);
  if (running) {
    const message = chat.messages.find((item) => item.id === running.assistantMessageId);
    if (message?.role === "assistant") {
      for (let index = message.parts.length - 1; index >= 0; index -= 1) {
        const part = message.parts[index];
        if (part?.type === "activity" && part.activity.status === "running") {
          return part.activity.label;
        }
      }
    }
    return "The agent is working";
  }
  const last = chat.turns[chat.turns.length - 1];
  if (!last) return "";
  if (last.status === "completed") return "The agent finished";
  if (last.status === "aborted") return "The agent stopped";
  if (last.status === "failed") {
    return last.error ? describeTurnError(last.error.code, last.error.message) : "The agent failed";
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
      <p className="text-step-12 text-text-1">{message}</p>
      <div className="flex gap-2">
        <Button size="sm" variant="secondary" onClick={onRetry}>
          Try again
        </Button>
        <Button size="sm" variant="ghost" onClick={onBack}>
          Back to chats
        </Button>
      </div>
    </div>
  );
}

export function ChatView() {
  const chat = useAgentStore((state) => state.chat);
  const chatId = useAgentStore((state) => state.chatId);
  const loading = useAgentStore((state) => state.chatLoading);
  const error = useAgentStore((state) => state.chatError);
  const streamStatus = useAgentStore((state) => state.streamStatus);
  const openChat = useAgentStore((state) => state.openChat);
  const closeChat = useAgentStore((state) => state.closeChat);

  const announcement = useThrottledText(statusSentence(chat), ANNOUNCE_EVERY_MS);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <ChatHeader />
      {error && chatId ? (
        <LoadFailure message={error} onRetry={() => void openChat(chatId)} onBack={closeChat} />
      ) : loading || !chat ? (
        <div
          className="flex flex-1 items-center justify-center text-step-11 text-text-3"
          role="status"
        >
          Loading chat…
        </div>
      ) : (
        <>
          {streamStatus === "reconnecting" && (
            <p
              role="status"
              className="shrink-0 bg-container/10 px-3 py-1 text-step-11 text-container"
            >
              Reconnecting to the agent…
            </p>
          )}
          <MessageList chat={chat} />
          <Composer />
        </>
      )}
      <div role="status" aria-live="polite" aria-atomic className="sr-only">
        {announcement}
      </div>
    </div>
  );
}
