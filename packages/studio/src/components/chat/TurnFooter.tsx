import { ArrowClockwise, ArrowCounterClockwise, Check, WarningCircle } from "@phosphor-icons/react";
import type { RevertMode, TurnSummary } from "@hyperframes/agent-protocol";
import type { RevertUi } from "../../agent/agentRevertSlice";
import { describeTurnError, isNoModelMessage } from "../../agent/agentErrors";
import { ConnectModelButton, NO_MODEL_SENTENCE } from "./ConnectModel";
import { useTranslation } from "../../i18n";
import { Button } from "../ui/Button";
import { cn } from "../ui/cn";
import { Spinner } from "../ui/Status";
import { chatLink, noteBoxWarn } from "./chatStyles";
import { TurnChanges } from "./TurnChanges";
import { TurnUsage } from "./TurnUsage";

/** "Retry this turn" on a failed turn: runs it again; `busy` while the new turn is being started. */
export interface RetryTurn {
  busy: boolean;
  /** Why it cannot run right now (another run is active), or null. */
  blockedReason: string | null;
  onRetry: () => void;
}

/** Why a control beside it is disabled, in words — a tooltip alone leaves "nothing happens". */
function BlockedReason({ children }: { children: string }) {
  return (
    <span data-testid="blocked-reason" className="text-xs leading-4 text-fg-3">
      {children}
    </span>
  );
}

const MAX_FILES_SHOWN = 6;

function TurnStatusNote({ turn, retry }: { turn: TurnSummary; retry: RetryTurn | undefined }) {
  const { t } = useTranslation();
  if (turn.status === "failed") {
    const message = turn.error
      ? describeTurnError(turn.error.code, turn.error.message)
      : t("chat.turn.problem");
    // "No model" is not a breakage: say so calmly and put the way to fix it right here.
    if (isNoModelMessage(message)) {
      return (
        <div role="alert" className="grid justify-items-start gap-1.5 text-xs leading-4 text-fg-2">
          <span>{t(NO_MODEL_SENTENCE)}</span>
          <ConnectModelButton />
        </div>
      );
    }
    // The provider's own words (English, with its retry count) stay one hover away for anyone reporting the problem.
    const detail = turn.error && turn.error.message !== message ? turn.error.message : undefined;
    return (
      <div className="grid justify-items-start gap-1.5">
        <p role="alert" className="flex items-start gap-1.5 text-xs leading-4 text-error">
          <WarningCircle aria-hidden weight="fill" className="mt-px size-icon-sm shrink-0" />
          <span title={detail}>{message}</span>
        </p>
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          {turn.error?.code === "provider_auth" && <ConnectModelButton />}
          {retry && (
            <Button
              size="sm"
              variant="secondary"
              icon={<ArrowClockwise aria-hidden className="size-icon-sm" />}
              loading={retry.busy}
              disabled={retry.blockedReason !== null}
              title={retry.blockedReason ?? t("chat.turn.retryHint")}
              onClick={retry.onRetry}
            >
              {t("chat.turn.retry")}
            </Button>
          )}
          {retry?.blockedReason != null && <BlockedReason>{retry.blockedReason}</BlockedReason>}
        </div>
      </div>
    );
  }
  if (turn.status === "aborted") {
    return <p className="text-xs leading-4 text-fg-3">{t("chat.turn.stopped")}</p>;
  }
  if (turn.status === "interrupted") {
    return <p className="text-xs leading-4 text-warning">{t("chat.turn.interrupted")}</p>;
  }
  return null;
}

function ConflictChoices({
  files,
  undo,
  onChoose,
  onCancel,
}: {
  files: string[];
  /** The conflict came from Undo revert, not from the revert. */
  undo: boolean;
  onChoose: (mode: RevertMode) => void;
  onCancel: () => void;
}) {
  const { t } = useTranslation();
  const shown = files.slice(0, MAX_FILES_SHOWN);
  return (
    <div
      role="group"
      aria-label={undo ? t("chat.conflict.undoLabel") : t("chat.conflict.revertLabel")}
      className={cn(noteBoxWarn, "basis-full gap-1.5 px-[9px] py-2 text-xs leading-[15px]")}
    >
      <p>{undo ? t("chat.conflict.undoIntro") : t("chat.conflict.revertIntro")}</p>
      <ul className="grid gap-px text-fg-2">
        {shown.map((file) => (
          <li key={file} title={file} className="truncate font-mono text-num leading-[14px]">
            {file}
          </li>
        ))}
        {files.length > shown.length && (
          <li>{t("chat.conflict.more", { count: files.length - shown.length })}</li>
        )}
      </ul>
      <div className="flex flex-wrap gap-1.5">
        <Button
          size="sm"
          title={t("chat.conflict.keepHint")}
          onClick={() => onChoose("keep-later-edits")}
        >
          {undo ? t("chat.conflict.undoKeep") : t("chat.conflict.revertKeep")}
        </Button>
        <Button
          size="sm"
          title={t("chat.conflict.anywayHint")}
          onClick={() => onChoose("just-this")}
        >
          {undo ? t("chat.conflict.undoAnyway") : t("chat.conflict.revertAnyway")}
        </Button>
        <Button size="sm" variant="ghost" onClick={onCancel}>
          {t("common.cancel")}
        </Button>
      </div>
    </div>
  );
}

interface TurnFooterProps {
  turn: TurnSummary;
  revert: RevertUi | undefined;
  /** Why reverting is not possible right now (another run is active), or null. */
  blockedReason: string | null;
  onRevert: (mode?: RevertMode) => void;
  onUnrevert: (mode?: RevertMode) => void;
  onDismissRevert: () => void;
  /** "Retry this turn" for a failed last turn; absent when there is nothing to retry. */
  retry?: RetryTurn;
}

/**
 * Below a finished turn: how it ended, and the one reversible checkpoint it owns — "Revert this turn · N files
 * changed", the conflict choices, then "Reverted · Undo".
 */
export function TurnFooter({
  turn,
  revert,
  blockedReason,
  onRevert,
  onUnrevert,
  onDismissRevert,
  retry,
}: TurnFooterProps) {
  const { t } = useTranslation();
  const checkpoint = turn.checkpoint;
  const revertible = checkpoint?.status === "ready" && checkpoint.entryIds.length > 0;
  const files = checkpoint?.files ?? [];
  const pending = revert?.status === "pending";

  let row = null;
  if (revert?.status === "conflict") {
    const undo = revert.action === "unrevert";
    row = (
      <ConflictChoices
        files={revert.files}
        undo={undo}
        onChoose={undo ? onUnrevert : onRevert}
        onCancel={onDismissRevert}
      />
    );
  } else if (checkpoint?.status === "reverted") {
    const kept = checkpoint.keptFiles ?? [];
    const undoable = (checkpoint.revertEntryIds?.length ?? 0) > 0;
    row = (
      <>
        <span className="inline-flex items-center gap-1 text-xs font-medium text-fg-2">
          <Check aria-hidden weight="bold" className="size-icon-sm text-fg-3" />
          {t("chat.turn.reverted")}
        </span>
        {kept.length > 0 && (
          <span title={kept.join("\n")} className="text-xs leading-4 text-fg-3 tabular-nums">
            {t("chat.turn.keptEdits", { count: kept.length })}
          </span>
        )}
        {undoable &&
          (pending ? (
            <span className="inline-flex items-center gap-1 text-xs text-fg-3" role="status">
              <Spinner size="sm" />
              {t("chat.turn.undoing")}
            </span>
          ) : (
            <button
              type="button"
              aria-label={t("chat.turn.undoRevert")}
              disabled={blockedReason !== null}
              title={blockedReason ?? t("chat.turn.undoHint")}
              onClick={() => onUnrevert()}
              className={cn(
                chatLink,
                "text-xs disabled:cursor-default disabled:text-fg-disabled disabled:no-underline",
              )}
            >
              {t("chat.turn.undo")}
            </button>
          ))}
        {undoable && !pending && blockedReason !== null && (
          <BlockedReason>{blockedReason}</BlockedReason>
        )}
      </>
    );
  } else if (revertible) {
    row = (
      <>
        <Button
          size="sm"
          variant="ghost"
          icon={<ArrowCounterClockwise aria-hidden className="size-icon-sm" />}
          loading={pending}
          disabled={blockedReason !== null}
          title={blockedReason ?? t("chat.turn.revertHint")}
          onClick={() => onRevert()}
          className="-ml-2 text-fg-2"
        >
          {t("chat.turn.revert")}
        </Button>
        {blockedReason !== null && <BlockedReason>{blockedReason}</BlockedReason>}
        {files.length > 0 && (
          <span
            title={files.join("\n")}
            data-testid="turn-files"
            className="min-w-0 truncate text-xs leading-4 text-fg-3 tabular-nums"
          >
            {t("chat.turn.filesChanged", { count: files.length })}
            <span className="@max-[299px]/chat:hidden">
              {" · "}
              {files.map((file) => file.split("/").pop() ?? file).join(", ")}
            </span>
          </span>
        )}
        <TurnChanges turn={turn} />
      </>
    );
  } else if (checkpoint?.status === "ready") {
    row = <span className="text-xs leading-4 text-fg-3">{t("chat.turn.noChanges")}</span>;
  } else if (checkpoint?.status === "unavailable") {
    row = <span className="text-xs leading-4 text-fg-3">{t("chat.turn.cannotRevert")}</span>;
  } else if (checkpoint?.status === "active") {
    // The turn is over but its history window has not closed yet (the runtime closes it before the next turn or on
    // the next project load): Revert exists, it just is not ready, and the row says so instead of vanishing.
    row = (
      <>
        <Button
          size="sm"
          variant="ghost"
          icon={<ArrowCounterClockwise aria-hidden className="size-icon-sm" />}
          disabled
          title={t("chat.turn.finalizing")}
          className="-ml-2 text-fg-2"
        >
          {t("chat.turn.revert")}
        </Button>
        <BlockedReason>{t("chat.turn.finalizing")}</BlockedReason>
      </>
    );
  }

  return (
    <div className="grid gap-1" data-testid="turn-footer">
      <TurnStatusNote turn={turn} retry={retry} />
      {row && (
        <div className="flex min-h-ctl-sm min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5">
          {row}
        </div>
      )}
      <TurnUsage turn={turn} />
      {revert?.status === "error" && (
        <p role="alert" className="text-xs leading-4 text-error">
          {revert.message}
        </p>
      )}
    </div>
  );
}
