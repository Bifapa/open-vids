import { isDeterministicSource, type QaIssue } from "@hyperframes/agent-protocol";
import { usePlayerStore } from "../../player/store/playerStore";
import { useTranslation } from "../../i18n";
import { cn } from "../ui/cn";
import { chatLink } from "./chatStyles";
import {
  QA_ISSUE_KIND_LABELS,
  QA_OWNER_LABELS,
  QA_SEVERITY_LABELS,
  QA_SOURCE_LABELS,
  formatQaRange,
} from "./qaLabels";

const SEVERITY_TONES = {
  error: "bg-error-soft text-error",
  warning: "bg-warning-soft text-warning",
  info: "bg-surface-2 text-fg-3",
} as const;

interface QaIssueRowProps {
  issue: QaIssue;
  composition: string;
  /** The user marked this issue intentional (the report's `acceptedIssueIds`). */
  accepted: boolean;
  /** A mark or an undo for this issue is on its way. */
  busy: boolean;
  onAccept: () => void;
  onUnaccept: () => void;
}

/**
 * One issue of a stored pass: what, where (a time that seeks the preview), who found it and who owns the fix. An open
 * issue can be marked intentional (an on-purpose fade, a dramatic pause): QA then stops asking for it. An issue
 * carried over from an earlier pass that this one could not re-check says so.
 */
export function QaIssueRow({
  issue,
  composition,
  accepted,
  busy,
  onAccept,
  onUnaccept,
}: QaIssueRowProps) {
  const { t } = useTranslation();
  const fixed = issue.status === "fixed";
  const quiet = fixed || accepted;
  const sourceName = t(QA_SOURCE_LABELS[issue.source]);
  const source = isDeterministicSource(issue.source)
    ? t("chat.qa.sourceDeterministic", { source: sourceName })
    : sourceName;
  const range = formatQaRange(issue.start, issue.end);
  return (
    <li
      data-issue-id={issue.id}
      data-issue-status={issue.status}
      data-issue-accepted={accepted || undefined}
      className="flex flex-col gap-0.5 rounded-sm px-1.5 py-1 hover:bg-surface-1"
    >
      <span className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-2xs">
        <span className={cn("text-xs font-medium", quiet ? "text-fg-3" : "text-fg")}>
          {t(QA_ISSUE_KIND_LABELS[issue.kind])}
        </span>
        {!quiet && (
          <span className={cn("rounded-xs px-1", SEVERITY_TONES[issue.severity])}>
            {t(QA_SEVERITY_LABELS[issue.severity])}
          </span>
        )}
        <button
          type="button"
          data-testid="qa-issue-time"
          title={t("chat.qa.showRange", { range, composition })}
          onClick={() => usePlayerStore.getState().requestSeek(issue.start)}
          className="rounded-xs px-0.5 font-mono text-num text-fg tabular-nums underline decoration-border-strong underline-offset-2 hover:bg-surface-2 hover:decoration-fg-2 outline-hidden focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-accent"
        >
          {range}
        </button>
        <span className="text-fg-3">{source}</span>
        {issue.owner && (
          <span className="text-fg-3">
            {t("chat.qa.owner", { owner: t(QA_OWNER_LABELS[issue.owner]) })}
          </span>
        )}
        {issue.notRechecked && !fixed && (
          <span
            data-testid="qa-issue-not-rechecked"
            title={t("chat.qa.notRecheckedHint")}
            className="rounded-xs bg-surface-2 px-1 text-fg-3"
          >
            {t("chat.qa.notRechecked")}
          </span>
        )}
        {accepted && (
          <span data-testid="qa-issue-accepted" className="rounded-xs bg-surface-2 px-1 text-fg-2">
            {t("chat.qa.accepted")}
          </span>
        )}
        {!fixed && (
          <button
            type="button"
            data-testid={accepted ? "qa-issue-unaccept" : "qa-issue-accept"}
            disabled={busy}
            title={accepted ? t("chat.qa.unacceptHint") : t("chat.qa.acceptHint")}
            onClick={accepted ? onUnaccept : onAccept}
            className={cn(
              chatLink,
              "ml-auto text-2xs disabled:cursor-default disabled:text-fg-disabled disabled:no-underline",
            )}
          >
            {accepted ? t("chat.qa.unaccept") : t("chat.qa.accept")}
          </button>
        )}
      </span>
      <span
        className={cn(
          "text-xs leading-[15px]",
          quiet ? "text-fg-3" : "text-fg-2",
          fixed && "line-through decoration-fg-3",
        )}
      >
        {issue.message}
      </span>
      {issue.suggestion && !quiet && (
        <span className="text-xs leading-[15px] text-fg-3">
          {t("chat.qa.suggestion", { suggestion: issue.suggestion })}
        </span>
      )}
    </li>
  );
}
