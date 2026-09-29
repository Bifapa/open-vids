import { useMemo } from "react";
import { ArrowDown } from "@phosphor-icons/react";
import type { ChatMessage, ChatState, TurnSummary } from "@hyperframes/agent-protocol";
import { useAgentStore } from "../../agent/agentContext";
import { AssistantBlock, UserBubble } from "./Messages";
import { TurnFooter } from "./TurnFooter";
import { useAutoScroll } from "./useAutoScroll";

function EmptyChat() {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-1 px-6 text-center">
      <p className="text-step-12 font-medium text-text-1">What should the agent do?</p>
      <p className="text-step-11 text-text-3">
        Ask it to inspect, explain or edit this project. Every prompt is one step you can revert.
      </p>
    </div>
  );
}

function turnFor(turns: TurnSummary[], message: ChatMessage): TurnSummary | undefined {
  return turns.find((turn) => turn.id === message.turnId);
}

export function MessageList({ chat }: { chat: ChatState }) {
  // Every folded event bumps `lastSeq`, so it is the one signal for "the content grew".
  const { ref, onScroll, detached, jumpToLatest } = useAutoScroll(chat.lastSeq);
  const reverts = useAgentStore((state) => state.reverts);
  const activeTurn = useAgentStore((state) => state.activeTurn);
  const revert = useAgentStore((state) => state.revert);
  const dismissRevert = useAgentStore((state) => state.dismissRevert);
  const blockedReason = activeTurn ? "Wait for the agent to finish before reverting." : null;

  const rows = useMemo(
    () =>
      chat.messages.map((message) => {
        const turn = turnFor(chat.turns, message);
        return { message, turn };
      }),
    [chat.messages, chat.turns],
  );

  return (
    <div className="relative min-h-0 flex-1">
      <div
        ref={ref}
        onScroll={onScroll}
        role="log"
        aria-live="off"
        aria-label="Conversation"
        className="flex h-full flex-col gap-3 overflow-y-auto px-3 py-3"
      >
        {rows.length === 0 ? (
          <EmptyChat />
        ) : (
          rows.map(({ message, turn }) => (
            <div key={message.id} className="flex flex-col gap-2">
              {message.role === "user" ? (
                <UserBubble message={message} />
              ) : (
                <>
                  <AssistantBlock message={message} />
                  {turn && turn.status !== "running" && turn.assistantMessageId === message.id && (
                    <TurnFooter
                      turn={turn}
                      revert={reverts[turn.id]}
                      blockedReason={blockedReason}
                      onRevert={(mode) => void revert(turn.id, mode)}
                      onDismissRevert={() => dismissRevert(turn.id)}
                    />
                  )}
                </>
              )}
            </div>
          ))
        )}
      </div>
      {detached && (
        <button
          type="button"
          onClick={jumpToLatest}
          className="absolute bottom-2 left-1/2 flex -translate-x-1/2 items-center gap-1 rounded-full border border-border-strong bg-surface px-2.5 py-1 text-step-11 text-text-1 shadow-menu outline-hidden transition-colors duration-hover hover:bg-hover focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-accent"
        >
          <ArrowDown size={12} weight="bold" aria-hidden />
          Jump to latest
        </button>
      )}
    </div>
  );
}
