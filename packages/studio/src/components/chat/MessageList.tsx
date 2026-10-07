import { useMemo, useRef } from "react";
import { ArrowDown, ClosedCaptioning, FilmStrip, Scissors, type Icon } from "@phosphor-icons/react";
import type { ChatState, TurnSummary } from "@hyperframes/agent-protocol";
import { useAgentStore } from "../../agent/agentContext";
import { hasNoUsableModel, mainThreadMessages, type ThreadId } from "../../agent/agentSelectors";
import { useChapterCount } from "../../story/useStoryActions";
import { useTranslation, type TranslationKey } from "../../i18n";
import { cn } from "../ui/cn";
import { AgentThread } from "./AgentThread";
import { BuildStoryButton } from "./BuildStoryButton";
import { DesignSavedCards } from "./DesignTurnParts";
import { NoModelState } from "./ConnectModel";
import { chatAgentName } from "./AgentMonogram";
import { chatMeasureWide, chatPadX, selItem } from "./chatStyles";
import { AssistantBlock, UserMessageView } from "./Messages";
import { PlanView } from "./PlanView";
import { RenderQaCard } from "./RenderQaCard";
import { TurnFooter, type RetryTurn } from "./TurnFooter";
import { useAutoScroll } from "./useAutoScroll";
import { usePlanApproval } from "./usePlanApproval";

const SUGGESTIONS: { text: TranslationKey; icon: Icon }[] = [
  { text: "chat.empty.suggestion.pacing", icon: Scissors },
  { text: "chat.empty.suggestion.captions", icon: ClosedCaptioning },
  { text: "chat.empty.suggestion.broll", icon: FilmStrip },
];

/**
 * A new chat: a hint and a few starting prompts, just above the composer. Picking one fills the composer. With no
 * usable model it is the "Connect a model" state instead.
 */
export function EmptyChat() {
  const { t } = useTranslation();
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
        {t("chat.empty.hint")}
      </p>
      <div className="-mx-1.5 grid gap-px">
        {SUGGESTIONS.map(({ text: key, icon: SuggestionIcon }) => (
          <button
            key={key}
            type="button"
            onClick={() => {
              setDraft(t(key));
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
            <span>{t(key)}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

/**
 * The clean conversation: prompts, Main's replies (with their plan and Working lists), QA, turn footers. The plan of
 * `dockedTurnId` is pinned above the conversation (`PlanDock`) and is not drawn here a second time.
 */
function MainThread({ chat, dockedTurnId }: { chat: ChatState; dockedTurnId: string | null }) {
  const { t } = useTranslation();
  const reverts = useAgentStore((state) => state.reverts);
  const activeTurn = useAgentStore((state) => state.activeTurn);
  const pending = useAgentStore((state) => state.pending);
  const revert = useAgentStore((state) => state.revert);
  const unrevert = useAgentStore((state) => state.unrevert);
  const dismissRevert = useAgentStore((state) => state.dismissRevert);
  const retryTurn = useAgentStore((state) => state.retryTurn);
  const approvalFor = usePlanApproval(chat);
  const blockedReason = activeTurn ? t("chat.revert.waitForAgent") : null;

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

  const lastTurn = chat.turns.at(-1);
  const chapterCount = useChapterCount();
  // Only the newest turn can be retried: older failures were moved on from.
  const retryFor = (turn: TurnSummary): RetryTurn | undefined =>
    turn.status === "failed" && turn.id === lastTurn?.id
      ? {
          busy: pending !== null,
          blockedReason: activeTurn ? t("chat.turn.retryBlocked") : null,
          onRetry: () => void retryTurn(turn.id),
        }
      : undefined;

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
              plan={
                turn?.plan &&
                turn.id !== dockedTurnId && (
                  <PlanView plan={turn.plan} turnId={turn.id} approval={approvalFor(turn)} />
                )
              }
            />
            {turn?.qa && <RenderQaCard turn={turn} />}
            {turn?.storyAction === "review" &&
              turn.status === "completed" &&
              turn.id === lastTurn?.id &&
              chapterCount > 0 && (
                <div className={cn("mt-1", chatMeasureWide)}>
                  <BuildStoryButton />
                </div>
              )}
            {turn && <DesignSavedCards chat={chat} turn={turn} />}
            {turn && turn.status !== "running" && (
              <TurnFooter
                turn={turn}
                revert={reverts[turn.id]}
                blockedReason={blockedReason}
                onRevert={(mode) => void revert(turn.id, mode)}
                onUnrevert={(mode) => void unrevert(turn.id, mode)}
                onDismissRevert={() => dismissRevert(turn.id)}
                retry={retryFor(turn)}
              />
            )}
          </div>
        ),
      )}
    </>
  );
}

export function MessageList({
  chat,
  thread,
  dockedTurnId,
}: {
  chat: ChatState;
  thread: ThreadId;
  /** The turn whose plan the pinned dock shows (main thread only). */
  dockedTurnId: string | null;
}) {
  const { t } = useTranslation();
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
          thread === "main"
            ? t("chat.list.conversation")
            : t("chat.list.agentWork", { name: chatAgentName(thread) })
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
          <MainThread chat={chat} dockedTurnId={dockedTurnId} />
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
          {t("chat.list.jumpToLatest")}
        </button>
      )}
    </div>
  );
}
