import { useMemo } from "react";
import { ArrowDown } from "@phosphor-icons/react";
import { AGENT_DISPLAY_NAMES, type ChatState } from "@hyperframes/agent-protocol";
import { useAgentStore } from "../../agent/agentContext";
import { mainThreadMessages, type ThreadId } from "../../agent/agentSelectors";
import { AgentThread } from "./AgentThread";
import { AssistantBlock, UserBubble } from "./Messages";
import { PlanView } from "./PlanView";
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

/** The clean conversation: prompts, the Director's replies (with their plan and delegations), turn footers. */
function MainThread({ chat }: { chat: ChatState }) {
  const reverts = useAgentStore((state) => state.reverts);
  const activeTurn = useAgentStore((state) => state.activeTurn);
  const revert = useAgentStore((state) => state.revert);
  const dismissRevert = useAgentStore((state) => state.dismissRevert);
  const blockedReason = activeTurn ? "Wait for the agent to finish before reverting." : null;

  const rows = useMemo(
    () =>
      mainThreadMessages(chat).map((message) => ({
        message,
        turn: chat.turns.find((turn) => turn.id === message.turnId),
      })),
    [chat],
  );

  if (rows.length === 0) return <EmptyChat />;
  return (
    <>
      {rows.map(({ message, turn }) => (
        <div key={message.id} className="flex flex-col gap-2">
          {message.role === "user" ? (
            <UserBubble message={message} />
          ) : (
            <>
              {turn?.plan && turn.assistantMessageId === message.id && (
                <PlanView plan={turn.plan} live={turn.status === "running"} />
              )}
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
      ))}
    </>
  );
}

export function MessageList({ chat, thread }: { chat: ChatState; thread: ThreadId }) {
  // Every folded event bumps `lastSeq`, so it is the one signal for "the content grew".
  const { ref, onScroll, detached, jumpToLatest } = useAutoScroll(chat.lastSeq);

  return (
    <div className="relative min-h-0 flex-1">
      <div
        ref={ref}
        onScroll={onScroll}
        role="log"
        aria-live="off"
        aria-label={
          thread === "main" ? "Conversation" : `${AGENT_DISPLAY_NAMES[thread]}'s work in this chat`
        }
        data-thread={thread}
        className="flex h-full flex-col gap-3 overflow-y-auto px-3 py-3"
      >
        {thread === "main" ? (
          <MainThread chat={chat} />
        ) : (
          <AgentThread chat={chat} agent={thread} />
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
