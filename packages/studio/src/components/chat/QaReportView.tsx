import { useEffect, useMemo, useState } from "react";
import { ClockCounterClockwise } from "@phosphor-icons/react";
import type { QaIssue, QaIssueStatus, QaReport } from "@hyperframes/agent-protocol";
import { useAgentStore } from "../../agent/agentContext";
import type { Loadable } from "../../agent/agentSettingsSlice";
import { useTranslation } from "../../i18n";
import { QaAcceptedList } from "./QaAcceptedList";
import { QaIssueRow } from "./QaIssueRow";
import {
  QA_CHECK_LABELS,
  QA_CHECK_STATUS_LABELS,
  QA_ISSUE_STATUS_LABELS,
  QA_VISION_STATUS_LABELS,
  qaReasonText,
  qaScopeText,
} from "./qaLabels";

/** Open issues in the order they matter to the reader: back again, new, still there. */
const OPEN_STATUS_ORDER: readonly QaIssueStatus[] = ["reappeared", "new", "persisting"];

interface IssueActions {
  /** Ids of the issues the user marked intentional. */
  accepted: ReadonlySet<string>;
  busyId: string | null;
  onAccept: (issue: QaIssue) => void;
  onUnaccept: (issue: QaIssue) => void;
}

function IssueGroup({
  status,
  issues,
  composition,
  actions,
}: {
  status: QaIssueStatus;
  issues: readonly QaIssue[];
  composition: string;
  actions: IssueActions;
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
          <QaIssueRow
            key={issue.id}
            issue={issue}
            composition={composition}
            accepted={actions.accepted.has(issue.id)}
            busy={actions.busyId === issue.id}
            onAccept={() => actions.onAccept(issue)}
            onUnaccept={() => actions.onUnaccept(issue)}
          />
        ))}
      </ul>
    </section>
  );
}

function ReportBody({
  report,
  onReport,
}: {
  report: QaReport;
  onReport: (report: QaReport) => void;
}) {
  const { t } = useTranslation();
  const acceptQaIssue = useAgentStore((state) => state.acceptQaIssue);
  const unacceptQaIssue = useAgentStore((state) => state.unacceptQaIssue);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const accepted = useMemo(() => new Set(report.acceptedIssueIds ?? []), [report.acceptedIssueIds]);

  const change = async (issue: QaIssue, mark: boolean) => {
    if (busyId !== null) return;
    setBusyId(issue.id);
    setFailure(null);
    const result = await (mark
      ? acceptQaIssue(report.id, issue.id)
      : unacceptQaIssue(report, issue));
    setBusyId(null);
    if (result.status === "ready") onReport(result.value);
    else if (result.status === "failed") setFailure(result.message);
  };
  const actions: IssueActions = {
    accepted,
    busyId,
    onAccept: (issue) => void change(issue, true),
    onUnaccept: (issue) => void change(issue, false),
  };

  const notRun = report.checks.filter((check) => check.status !== "ran" && check.id !== "vision");
  const openCount = report.issues.length;
  const scopeText = qaScopeText(report.scope, report.scopeNote);
  // A reduced pass already says why Vision did not look; its own "skipped" line would only repeat it.
  const showVision =
    report.vision.status !== "ran" && !(scopeText && report.vision.status === "skipped");
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
      {scopeText && (
        <p data-testid="qa-report-scope" className="px-1.5 text-xs text-fg-3">
          {scopeText}
        </p>
      )}
      {showVision && (
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
      {report.vision.status === "ran" && report.vision.reviewer === "director" && (
        <p data-testid="qa-report-reviewer" className="px-1.5 text-xs text-fg-3">
          {t("chat.qa.reviewedByDirector")}
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
      {(report.suppressed ?? 0) > 0 && (
        <QaAcceptedList composition={report.composition} suppressed={report.suppressed ?? 0} />
      )}
      {failure && (
        <p role="alert" className="px-1.5 text-xs text-error">
          {failure}
        </p>
      )}
      {openCount === 0 && report.resolved.length === 0 && !report.renderError && (
        <p className="px-1.5 text-xs text-fg-3">{t("chat.qa.noIssues")}</p>
      )}
      {OPEN_STATUS_ORDER.map((status) => (
        <IssueGroup
          key={status}
          status={status}
          issues={report.issues.filter((issue) => issue.status === status)}
          composition={report.composition}
          actions={actions}
        />
      ))}
      <IssueGroup
        status="fixed"
        issues={report.resolved}
        composition={report.composition}
        actions={actions}
      />
    </div>
  );
}

/**
 * One pass's stored report, fetched when opened and again when `refreshKey` changes (a revert makes it
 * outdated). Issues are grouped by how they compare with the previous pass; fixed ones close the list. An open issue
 * can be marked intentional, which stores the choice for the project and re-reads the report.
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
      {report.status === "ready" && (
        <ReportBody
          report={report.value}
          onReport={(next) => setReport({ status: "ready", value: next })}
        />
      )}
    </div>
  );
}
