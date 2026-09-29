import { ArrowCounterClockwise, Check, WarningCircle } from "@phosphor-icons/react";
import type { RevertMode, TurnSummary } from "@hyperframes/agent-protocol";
import type { RevertUi } from "../../agent/agentStore";
import { describeTurnError } from "../../agent/agentErrors";
import { Button } from "../ui/Button";

const MAX_FILES_SHOWN = 6;

function TurnStatusNote({ turn }: { turn: TurnSummary }) {
  if (turn.status === "failed") {
    const message = turn.error
      ? describeTurnError(turn.error.code, turn.error.message)
      : "The agent ran into a problem and stopped.";
    return (
      <p role="alert" className="flex items-start gap-1.5 text-step-11 text-danger">
        <WarningCircle size={13} weight="fill" aria-hidden className="mt-px shrink-0" />
        <span>{message}</span>
      </p>
    );
  }
  if (turn.status === "aborted") return <p className="text-step-11 text-text-3">Stopped.</p>;
  if (turn.status === "interrupted") {
    return (
      <p className="text-step-11 text-container">
        Interrupted. The agent stopped before it finished; anything it already changed is kept.
      </p>
    );
  }
  return null;
}

function ConflictChoices({
  files,
  onRevert,
  onCancel,
}: {
  files: string[];
  onRevert: (mode: RevertMode) => void;
  onCancel: () => void;
}) {
  const shown = files.slice(0, MAX_FILES_SHOWN);
  return (
    <div
      role="group"
      aria-label="Revert conflict"
      className="flex flex-col gap-2 rounded-md border border-container/40 bg-container/5 p-2"
    >
      <p className="text-step-11 text-text-1">
        These files changed after this run, so reverting them would also undo your later edits:
      </p>
      <ul className="flex flex-col gap-0.5 font-mono text-step-10 text-text-2">
        {shown.map((file) => (
          <li key={file} className="truncate" title={file}>
            {file}
          </li>
        ))}
        {files.length > shown.length && <li>and {files.length - shown.length} more</li>}
      </ul>
      <div className="flex flex-wrap gap-1.5">
        <Button size="sm" variant="secondary" onClick={() => onRevert("keep-later-edits")}>
          Revert untouched files
        </Button>
        <Button size="sm" variant="secondary" onClick={() => onRevert("just-this")}>
          Revert anyway
        </Button>
        <Button size="sm" variant="ghost" onClick={onCancel}>
          Cancel
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
  onDismissRevert: () => void;
}

/** Below a finished turn: how it ended, and the one reversible checkpoint it owns. */
export function TurnFooter({
  turn,
  revert,
  blockedReason,
  onRevert,
  onDismissRevert,
}: TurnFooterProps) {
  const checkpoint = turn.checkpoint;
  const revertible = checkpoint?.status === "ready" && checkpoint.entryIds.length > 0;

  let checkpointRow = null;
  if (revert?.status === "conflict") {
    checkpointRow = (
      <ConflictChoices files={revert.files} onRevert={onRevert} onCancel={onDismissRevert} />
    );
  } else if (checkpoint?.status === "reverted") {
    checkpointRow = (
      <p className="flex items-center gap-1 text-step-11 text-text-3">
        <Check size={12} weight="bold" aria-hidden className="text-accent" />
        Reverted
      </p>
    );
  } else if (revertible) {
    checkpointRow = (
      <div className="flex flex-wrap items-center gap-2">
        <Button
          size="sm"
          variant="ghost"
          icon={<ArrowCounterClockwise size={12} aria-hidden />}
          loading={revert?.status === "pending"}
          disabled={blockedReason !== null}
          title={blockedReason ?? undefined}
          onClick={() => onRevert()}
        >
          Revert this turn
        </Button>
        {revert?.status === "error" && (
          <span role="alert" className="text-step-11 text-danger">
            {revert.message}
          </span>
        )}
      </div>
    );
  } else if (checkpoint?.status === "ready") {
    checkpointRow = <p className="text-step-11 text-text-4">No project changes</p>;
  } else if (checkpoint?.status === "unavailable") {
    checkpointRow = <p className="text-step-11 text-text-4">This run can’t be reverted.</p>;
  }

  return (
    <div className="flex flex-col gap-1.5" data-testid="turn-footer">
      <TurnStatusNote turn={turn} />
      {checkpointRow}
    </div>
  );
}
