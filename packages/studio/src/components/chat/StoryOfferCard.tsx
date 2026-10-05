import { useId, useState } from "react";
import { CheckCircle, Clock, TreeStructure, WarningCircle, XCircle } from "@phosphor-icons/react";
import type { StoryOffer, StoryOfferDecision, StoryOfferState } from "@hyperframes/agent-protocol";
import { useAgentStore } from "../../agent/agentContext";
import { agentTurnRunning } from "../../agent/agentSelectors";
import { useFileManagerContextOptional } from "../../contexts/FileManagerContext";
import { useTranslation, type TranslationKey } from "../../i18n";
import { hasProjectMedia } from "../../media/mediaLibrary";
import { Button, cn } from "../ui";
import { BuildStoryButton } from "./BuildStoryButton";
import { chatLink, chatMeasureWide, noteBox } from "./chatStyles";
import { formatDuration } from "./relativeTime";

interface FailedAnswer {
  decision: StoryOfferDecision;
  message: string;
  /** The graph already has chapters: Story can be opened instead. */
  conflict: boolean;
}

const QUIET_KEYS = {
  declined: "chat.storyOffer.state.declined",
  expired: "chat.storyOffer.state.expired",
} as const satisfies Partial<Record<StoryOfferState, TranslationKey>>;

/**
 * The Director's offer to build the video as a Story: the chapters the user described, in their order, with
 * «Open in Story» and «No, edit right away» while it waits. Once answered it is a short record; an accepted offer
 * carries «Build the video». The chat stream delivers the new state; the answer only keeps the card busy.
 */
export function StoryOfferCard({ turnId, offer }: { turnId: string; offer: StoryOffer }) {
  const { t } = useTranslation();
  const answerStoryOffer = useAgentStore((state) => state.answerStoryOffer);
  const openStoryWorkspace = useAgentStore((state) => state.openStoryWorkspace);
  const turnRunning = useAgentStore(agentTurnRunning);
  const pending = useAgentStore((state) => state.pending);
  const chatId = useAgentStore((state) => state.chatId);
  const activeTurn = useAgentStore((state) => state.activeTurn);
  const chats = useAgentStore((state) => state.chats);
  const openChat = useAgentStore((state) => state.openChat);
  // Without the project's file tree (no editor around the chat) nothing says the footage is missing.
  const files = useFileManagerContextOptional();
  const titleId = useId();
  const [busy, setBusy] = useState<StoryOfferDecision | null>(null);
  const [failed, setFailed] = useState<FailedAnswer | null>(null);
  // The runtime's answer stands in until the stream delivers the same state (it is not replayed after a drop).
  const [answered, setAnswered] = useState<StoryOffer | null>(null);

  const current = offer.state === "pending" && answered?.id === offer.id ? answered : offer;
  const open = current.state === "pending";
  const canAnswer = open && !turnRunning;
  // Why the buttons are not there: a turn holds the project. Another chat's turn is named (and opened with a link),
  // like the composer does; the offer's own turn simply has not finished yet.
  const blockedBy = activeTurn && activeTurn.chatId !== chatId ? activeTurn : null;
  const blockedTitle = blockedBy ? chats.find((chat) => chat.id === blockedBy.chatId)?.title : null;
  let waitingKey: TranslationKey | null = null;
  if (open && turnRunning) {
    if (!blockedBy) waitingKey = "chat.storyOffer.waitingThisChat";
    else
      waitingKey = blockedTitle ? "chat.storyOffer.waitingNamed" : "chat.storyOffer.waitingOther";
  }

  const answer = async (decision: StoryOfferDecision) => {
    if (busy) return;
    setBusy(decision);
    setFailed(null);
    const result = await answerStoryOffer(turnId, offer.id, decision);
    setBusy(null);
    if (result.ok) setAnswered(result.offer);
    else setFailed({ decision, message: result.message, conflict: result.conflict });
  };

  const quiet = current.state === "declined" || current.state === "expired" ? current.state : null;
  const noFootage = files !== null && !hasProjectMedia(files.fileTree);

  return (
    <section
      aria-labelledby={titleId}
      data-testid="story-offer-card"
      data-story-offer-state={current.state}
      className={cn("mt-1.5", noteBox, chatMeasureWide)}
    >
      <div className="flex min-w-0 items-center gap-1.5 text-sm">
        <TreeStructure
          aria-hidden
          weight={open ? "fill" : "regular"}
          className={cn("size-icon-sm shrink-0", open ? "text-accent" : "text-fg-3")}
        />
        <span id={titleId} className="min-w-0 font-semibold text-fg">
          {t("chat.storyOffer.title")}
        </span>
      </div>
      {quiet === null && (
        <>
          <ol data-testid="story-offer-chapters" className="grid gap-1 rounded-sm bg-surface-1 p-2">
            {current.chapters.map((chapter, index) => (
              <li
                key={index}
                className="flex min-w-0 items-baseline gap-1.5 text-xs leading-[15px]"
              >
                <span aria-hidden className="w-4 shrink-0 text-fg-3 tabular-nums">
                  {index + 1}.
                </span>
                <span className="min-w-0 flex-1 [text-wrap:pretty]">
                  <span className="font-medium text-fg">{chapter.title}</span>
                  {chapter.summary && <span className="text-fg-3"> — {chapter.summary}</span>}
                </span>
                {chapter.durationSeconds !== undefined && (
                  <span className="shrink-0 text-fg-3 tabular-nums">
                    {formatDuration(chapter.durationSeconds * 1000)}
                  </span>
                )}
              </li>
            ))}
          </ol>
          {open && <p className="text-xs leading-[15px] text-fg-3">{t("chat.storyOffer.note")}</p>}
        </>
      )}
      {waitingKey && (
        <p
          data-testid="story-offer-waiting"
          role="status"
          className="text-xs leading-[15px] text-fg-3"
        >
          {t(waitingKey, { title: blockedTitle ?? "" })}
          {blockedBy && (
            <>
              {" "}
              <button
                type="button"
                onClick={() => void openChat(blockedBy.chatId)}
                className={cn(chatLink, "text-xs")}
              >
                {t("chat.composer.openBlocking")}
              </button>
            </>
          )}
        </p>
      )}
      {open && canAnswer && (
        <div className="grid gap-1.5">
          <div className="flex flex-wrap items-center gap-1.5">
            <Button
              size="sm"
              variant="primary"
              loading={busy === "accept"}
              disabled={busy !== null || pending !== null}
              onClick={() => void answer("accept")}
            >
              {t("chat.storyOffer.accept")}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              loading={busy === "decline"}
              disabled={busy !== null || pending !== null}
              onClick={() => void answer("decline")}
            >
              {t("chat.storyOffer.decline")}
            </Button>
          </div>
        </div>
      )}
      {failed && open && (
        <div
          role="alert"
          data-testid="story-offer-error"
          className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-xs leading-[15px] text-error"
        >
          <WarningCircle aria-hidden className="size-icon-sm shrink-0" />
          <span className="min-w-0 flex-1 [text-wrap:pretty]">
            {failed.conflict
              ? failed.message
              : t("chat.storyOffer.error", { message: failed.message })}
          </span>
          {failed.conflict ? (
            <Button size="xs" variant="ghost" onClick={() => void openStoryWorkspace()}>
              {t("chat.storyOffer.openStory")}
            </Button>
          ) : (
            <Button
              size="xs"
              variant="ghost"
              disabled={busy !== null}
              onClick={() => void answer(failed.decision)}
            >
              {t("common.tryAgain")}
            </Button>
          )}
        </div>
      )}
      {current.state === "accepted" && (
        <div className="grid gap-1.5">
          <p
            role="status"
            data-testid="story-offer-status"
            className="flex items-center gap-1 text-xs text-success"
          >
            <CheckCircle aria-hidden weight="fill" className="size-icon-sm shrink-0" />
            {t("chat.storyOffer.state.accepted")}
          </p>
          {noFootage && (
            <p data-testid="story-offer-hint" className="text-xs leading-[15px] text-fg-3">
              {t("chat.storyOffer.noFootage")}
            </p>
          )}
          <div className="flex flex-wrap items-center gap-1.5">
            <BuildStoryButton />
            <Button size="sm" variant="ghost" onClick={() => void openStoryWorkspace()}>
              {t("chat.storyOffer.openStory")}
            </Button>
          </div>
        </div>
      )}
      {quiet && (
        <p
          role="status"
          data-testid="story-offer-status"
          className="flex items-center gap-1 text-xs text-fg-3"
        >
          {quiet === "declined" ? (
            <XCircle aria-hidden weight="fill" className="size-icon-sm shrink-0" />
          ) : (
            <Clock aria-hidden weight="fill" className="size-icon-sm shrink-0" />
          )}
          {t(QUIET_KEYS[quiet])}
        </p>
      )}
    </section>
  );
}
