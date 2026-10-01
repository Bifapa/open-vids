import { useMemo, useRef } from "react";
import { ArrowDown, ClosedCaptioning, FilmStrip, Scissors, type Icon } from "@phosphor-icons/react";
import type { ChatState, TurnSummary } from "@hyperframes/agent-protocol";
import { useAgentStore } from "../../agent/agentContext";
import { hasNoUsableModel, mainThreadMessages, type ThreadId } from "../../agent/agentSelectors";
import { cn } from "../ui/cn";
import { AgentThread } from "./AgentThread";
import { NoModelState } from "./ConnectModel";
import { chatAgentName } from "./AgentMonogram";
import { chatPadX, selItem } from "./chatStyles";
import { AssistantBlock, UserMessageView } from "./Messages";
import { PlanView } from "./PlanView";
import { RenderQaCard } from "./RenderQaCard";
import { TurnFooter } from "./TurnFooter";
import { useAutoScroll } from "./useAutoScroll";

const SUGGESTIONS: { text: string; icon: Icon }[] = [
  { text: "Tighten the pacing and cut the long pauses", icon: Scissors },
  { text: "Add captions for the dialogue", icon: ClosedCaptioning },
  { text: "Find B-roll for the opening", icon: FilmStrip },
];

/**
 * A new chat: a hint and a few starting prompts, just above the composer. Picking one fills the composer. With no
 * usable model it is the "Connect a model" state instead.
 */
export function EmptyChat() {
  const setDraft = useAgentStore((state) => state.setDraft);
  const noModel = useAgentStore((state) => hasNoUsableModel(state.models));
  const ref = useRef<HTMLDivElement>(null);
  // Starting prompts are no use without a model: say what is missing and how to fix it instead.
  if (noModel) return <NoModelState />;
  return (
    <div
      ref={ref}
      className="flex min-h-full flex-1 flex-col justify-end gap-2.5 pt-4 pb-2.5 @min-[440px]/chat:px-1"
    >
      <p className="max-w-[36ch] text-sm leading-[17px] text-pretty text-fg-3">
        Describe an edit. Agents work on this project’s timeline, and every prompt is one step you
        can revert.
      </p>
      <div className="-mx-1.5 grid gap-px">
        {SUGGESTIONS.map(({ text, icon: SuggestionIcon }) => (
          <button
            key={text}
            type="button"
            onClick={() => {
              setDraft(text);
              ref.current?.closest("[data-chat-panel]")?.querySelector("textarea")?.focus();
            }}
            className={cn(
              selItem,
              "group flex min-h-row-sm w-full items-start gap-2 p-1.5 text-left text-sm leading-4 text-fg-2 hover:text-fg",
            )}
          >
            <SuggestionIcon
              aria-hidden
              className="mt-0.5 size-icon-sm shrink-0 text-fg-3 group-hover:text-fg-2"
            />
            <span>{text}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

/** The clean conversation: prompts, Main's replies (with their plan and Working lists), QA, turn footers. */
function MainThread({ chat }: { chat: ChatState }) {
  const reverts = useAgentStore((state) => state.reverts);
  const activeTurn = useAgentStore((state) => state.activeTurn);
  const revert = useAgentStore((state) => state.revert);
  const unrevert = useAgentStore((state) => state.unrevert);
  const dismissRevert = useAgentStore((state) => state.dismissRevert);
  const blockedReason = activeTurn ? "Wait for the agent to finish before reverting." : null;

  const rows = useMemo(() => {
    const byPrompt = new Map<string, TurnSummary>();
    const byReply = new Map<string, TurnSummary>();
    for (const turn of chat.turns) {
      byPrompt.set(turn.promptMessageId, turn);
      byReply.set(turn.assistantMessageId, turn);
    }
    return mainThreadMessages(chat).map((message) => ({
      message,
      turn: message.role === "user" ? byPrompt.get(message.id) : byReply.get(message.id),
    }));
  }, [chat]);

  if (rows.length === 0) return <EmptyChat />;
  return (
    <>
      {rows.map(({ message, turn }) =>
        message.role === "user" ? (
          <UserMessageView key={message.id} message={message} turn={turn} />
        ) : (
          <div key={message.id} className="grid min-w-0 gap-1.5">
            <AssistantBlock
              message={message}
              plan={turn?.plan && <PlanView plan={turn.plan} live={turn.status === "running"} />}
            />
            {turn?.qa && <RenderQaCard turn={turn} />}
            {turn && turn.status !== "running" && (
              <TurnFooter
                turn={turn}
                revert={reverts[turn.id]}
                blockedReason={blockedReason}
                onRevert={(mode) => void revert(turn.id, mode)}
                onUnrevert={(mode) => void unrevert(turn.id, mode)}
                onDismissRevert={() => dismissRevert(turn.id)}
              />
            )}
          </div>
        ),
      )}
    </>
  );
}

export function MessageList({ chat, thread }: { chat: ChatState; thread: ThreadId }) {
  // Every folded event bumps `lastSeq`, so it is the one signal for "the content grew".
  const { ref, onScroll, detached, jumpToLatest } = useAutoScroll(chat.lastSeq);

  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      <div
        ref={ref}
        onScroll={onScroll}
        role="log"
        aria-live="off"
        aria-label={
          thread === "main" ? "Conversation" : `${chatAgentName(thread)}'s work in this chat`
        }
        data-thread={thread}
        className={cn(
          "flex min-h-0 flex-1 flex-col gap-3.5 overflow-x-hidden overflow-y-auto overscroll-contain pt-3 pb-4",
          "@max-[299px]/chat:gap-3 @max-[299px]/chat:pt-2.5 @min-[440px]/chat:gap-4 @min-[440px]/chat:pt-3.5",
          "[&>*]:min-w-0",
          chatPadX,
        )}
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
          className={cn(
            "absolute bottom-2 left-1/2 inline-flex h-ctl-sm -translate-x-1/2 items-center gap-1 rounded-pill border border-border bg-bg-1 px-2.5",
            "text-xs font-medium text-fg-2 shadow-raise transition-colors duration-hover hover:bg-surface-2 hover:text-fg",
            "outline-hidden focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent",
          )}
        >
          <ArrowDown aria-hidden weight="bold" className="size-icon-sm" />
          Jump to latest
        </button>
      )}
    </div>
  );
}
