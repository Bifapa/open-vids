import { useEffect, useState } from "react";
import { ClockCounterClockwise } from "@phosphor-icons/react";
import {
  isDeterministicSource,
  type QaIssue,
  type QaIssueStatus,
  type QaReport,
  type QaSeverity,
} from "@hyperframes/agent-protocol";
import { useAgentStore } from "../../agent/agentContext";
import type { Loadable } from "../../agent/agentSettingsSlice";
import { usePlayerStore } from "../../player/store/playerStore";
import { useTranslation } from "../../i18n";
import { cn } from "../ui/cn";
import {
  QA_CHECK_LABELS,
  QA_CHECK_STATUS_LABELS,
  QA_ISSUE_KIND_LABELS,
  QA_ISSUE_STATUS_LABELS,
  QA_OWNER_LABELS,
  QA_SEVERITY_LABELS,
  QA_SOURCE_LABELS,
  QA_VISION_STATUS_LABELS,
  formatQaRange,
  qaReasonText,
} from "./qaLabels";

/** Open issues in the order they matter to the reader: back again, new, still there. */
const OPEN_STATUS_ORDER: readonly QaIssueStatus[] = ["reappeared", "new", "persisting"];

const SEVERITY_TONES: Record<QaSeverity, string> = {
  error: "bg-error-soft text-error",
  warning: "bg-warning-soft text-warning",
  info: "bg-surface-2 text-fg-3",
};

function IssueRow({ issue, composition }: { issue: QaIssue; composition: string }) {
  const { t } = useTranslation();
  const fixed = issue.status === "fixed";
  const sourceName = t(QA_SOURCE_LABELS[issue.source]);
  const source = isDeterministicSource(issue.source)
    ? t("chat.qa.sourceDeterministic", { source: sourceName })
    : sourceName;
  const range = formatQaRange(issue.start, issue.end);
  return (
    <li
      data-issue-id={issue.id}
      data-issue-status={issue.status}
      className="flex flex-col gap-0.5 rounded-sm px-1.5 py-1 hover:bg-surface-1"
    >
      <span className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-2xs">
        <span className={cn("text-xs font-medium", fixed ? "text-fg-3" : "text-fg")}>
          {t(QA_ISSUE_KIND_LABELS[issue.kind])}
        </span>
        {!fixed && (
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
      </span>
      <span
        className={cn(
          "text-xs leading-[15px]",
          fixed ? "text-fg-3 line-through decoration-fg-3" : "text-fg-2",
        )}
      >
        {issue.message}
      </span>
      {issue.suggestion && !fixed && (
        <span className="text-xs leading-[15px] text-fg-3">
          {t("chat.qa.suggestion", { suggestion: issue.suggestion })}
        </span>
      )}
    </li>
  );
}

function IssueGroup({
  status,
  issues,
  composition,
}: {
  status: QaIssueStatus;
  issues: readonly QaIssue[];
  composition: string;
}) {
  const { t } = useTranslation();
  if (issues.length === 0) return null;
  return (
    <section data-issue-group={status} className="flex flex-col gap-0.5">
      <h4 className="px-1.5 text-xs font-semibold text-fg-2">
        {t("chat.qa.groupTitle", {
          status: t(QA_ISSUE_STATUS_LABELS[status]),
          count: issues.length,
        })}
      </h4>
      <ul className="flex flex-col">
        {issues.map((issue) => (
          <IssueRow key={issue.id} issue={issue} composition={composition} />
        ))}
      </ul>
    </section>
  );
}

function ReportBody({ report }: { report: QaReport }) {
  const { t } = useTranslation();
  const notRun = report.checks.filter((check) => check.status !== "ran" && check.id !== "vision");
  const openCount = report.issues.length;
  return (
    <div className="flex flex-col gap-1.5">
      {!report.current && (
        <p
          data-testid="qa-report-outdated"
          className="flex items-center gap-1 rounded-sm bg-warning-soft px-1.5 py-1 text-xs text-warning"
        >
          <ClockCounterClockwise aria-hidden className="size-icon-sm shrink-0" />
          {t("chat.qa.outdated")}
        </p>
      )}
      {report.renderError && (
        <p className="px-1.5 text-xs text-error">
          {t("chat.qa.renderFailed", { error: report.renderError })}
        </p>
      )}
      {report.vision.status !== "ran" && (
        <p className="px-1.5 text-xs text-fg-3">
          {report.vision.reason
            ? t("chat.qa.lineWithDetail", {
                label: t(QA_VISION_STATUS_LABELS[report.vision.status]),
                detail: qaReasonText(
                  report.vision.reason,
                  report.vision.reasonCode,
                  report.vision.reasonParams,
                ),
              })
            : t("chat.qa.lineNoDetail", {
                label: t(QA_VISION_STATUS_LABELS[report.vision.status]),
              })}
        </p>
      )}
      {notRun.map((check) => (
        <p key={check.id} className="px-1.5 text-xs text-fg-3">
          {check.detail
            ? t("chat.qa.checkLineWithDetail", {
                check: t(QA_CHECK_LABELS[check.id]),
                status: t(QA_CHECK_STATUS_LABELS[check.status]),
                detail: check.detail,
              })
            : t("chat.qa.checkLine", {
                check: t(QA_CHECK_LABELS[check.id]),
                status: t(QA_CHECK_STATUS_LABELS[check.status]),
              })}
        </p>
      ))}
      {openCount === 0 && report.resolved.length === 0 && !report.renderError && (
        <p className="px-1.5 text-xs text-fg-3">{t("chat.qa.noIssues")}</p>
      )}
      {OPEN_STATUS_ORDER.map((status) => (
        <IssueGroup
          key={status}
          status={status}
          issues={report.issues.filter((issue) => issue.status === status)}
          composition={report.composition}
        />
      ))}
      <IssueGroup status="fixed" issues={report.resolved} composition={report.composition} />
    </div>
  );
}

/**
 * One pass's stored report, fetched when opened and again when `refreshKey` changes (a revert makes it
 * outdated). Issues are grouped by how they compare with the previous pass; fixed ones close the list.
 */
export function QaReportView({ reportId, refreshKey }: { reportId: string; refreshKey: string }) {
  const { t } = useTranslation();
  const loadQaReport = useAgentStore((state) => state.loadQaReport);
  const [report, setReport] = useState<Loadable<QaReport>>({ status: "loading" });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let live = true;
    void loadQaReport(reportId).then((result) => {
      if (live) setReport(result);
    });
    return () => {
      live = false;
    };
  }, [loadQaReport, reportId, refreshKey, attempt]);

  return (
    <div data-testid="qa-report" data-report-id={reportId} className="py-1">
      {report.status === "loading" && (
        <p className="px-1.5 text-xs text-fg-3">{t("chat.qa.loadingReport")}</p>
      )}
      {report.status === "failed" && (
        <p role="alert" className="flex items-center gap-2 px-1.5 text-xs text-error">
          {report.message}
          <button
            type="button"
            onClick={() => setAttempt((count) => count + 1)}
            className="rounded-xs font-medium text-fg-2 underline decoration-border-strong underline-offset-2 hover:text-fg outline-hidden focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-accent"
          >
            {t("common.tryAgain")}
          </button>
        </p>
      )}
      {report.status === "ready" && <ReportBody report={report.value} />}
    </div>
  );
}
