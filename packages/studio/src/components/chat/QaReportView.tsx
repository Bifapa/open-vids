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
} from "./qaLabels";

/** Open issues in the order they matter to the reader: back again, new, still there. */
const OPEN_STATUS_ORDER: readonly QaIssueStatus[] = ["reappeared", "new", "persisting"];

const SEVERITY_TONES: Record<QaSeverity, string> = {
  error: "bg-danger/10 text-danger",
  warning: "bg-container/10 text-container",
  info: "bg-surface text-text-3",
};

function IssueRow({ issue, composition }: { issue: QaIssue; composition: string }) {
  const fixed = issue.status === "fixed";
  const source = isDeterministicSource(issue.source)
    ? `${QA_SOURCE_LABELS[issue.source]} (deterministic)`
    : QA_SOURCE_LABELS[issue.source];
  const range = formatQaRange(issue.start, issue.end);
  return (
    <li
      data-issue-id={issue.id}
      data-issue-status={issue.status}
      className="flex flex-col gap-0.5 rounded-sm px-1.5 py-1 hover:bg-hover/30"
    >
      <span className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-step-10">
        <span className={cn("font-medium", fixed ? "text-text-3" : "text-text-1")}>
          {QA_ISSUE_KIND_LABELS[issue.kind]}
        </span>
        {!fixed && (
          <span className={cn("rounded-sm px-1", SEVERITY_TONES[issue.severity])}>
            {QA_SEVERITY_LABELS[issue.severity]}
          </span>
        )}
        <button
          type="button"
          data-testid="qa-issue-time"
          title={`Show ${range} of ${composition} in the preview`}
          onClick={() => usePlayerStore.getState().requestSeek(issue.start)}
          className="rounded-sm font-mono tabular-nums text-accent outline-hidden hover:underline focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-accent"
        >
          {range}
        </button>
        <span className="text-text-4">{source}</span>
        {issue.owner && <span className="text-text-4">→ {QA_OWNER_LABELS[issue.owner]}</span>}
      </span>
      <span
        className={cn(
          "text-step-11 leading-snug",
          fixed ? "text-text-3 line-through decoration-text-4" : "text-text-2",
        )}
      >
        {issue.message}
      </span>
      {issue.suggestion && !fixed && (
        <span className="text-step-10 leading-snug text-text-3">
          Suggestion: {issue.suggestion}
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
  if (issues.length === 0) return null;
  return (
    <section data-issue-group={status} className="flex flex-col gap-0.5">
      <h4 className="px-1.5 text-step-10 font-medium uppercase tracking-wide text-text-4">
        {QA_ISSUE_STATUS_LABELS[status]} ({issues.length})
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
  const notRun = report.checks.filter((check) => check.status !== "ran" && check.id !== "vision");
  const openCount = report.issues.length;
  return (
    <div className="flex flex-col gap-1.5">
      {!report.current && (
        <p
          data-testid="qa-report-outdated"
          className="flex items-center gap-1 rounded-sm bg-container/10 px-1.5 py-1 text-step-10 text-container"
        >
          <ClockCounterClockwise size={11} aria-hidden className="shrink-0" />
          Outdated: the project changed since this render (for example after a revert).
        </p>
      )}
      {report.renderError && (
        <p className="px-1.5 text-step-11 text-danger">Render failed: {report.renderError}</p>
      )}
      {report.vision.status !== "ran" && (
        <p className="px-1.5 text-step-10 text-text-3">
          {QA_VISION_STATUS_LABELS[report.vision.status]}
          {report.vision.reason ? `: ${report.vision.reason}` : "."}
        </p>
      )}
      {notRun.map((check) => (
        <p key={check.id} className="px-1.5 text-step-10 text-text-3">
          {QA_CHECK_LABELS[check.id]} {QA_CHECK_STATUS_LABELS[check.status]}
          {check.detail ? `: ${check.detail}` : "."}
        </p>
      ))}
      {openCount === 0 && report.resolved.length === 0 && !report.renderError && (
        <p className="px-1.5 text-step-11 text-text-3">No issues found.</p>
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
        <p className="px-1.5 text-step-10 text-text-3">Loading the report…</p>
      )}
      {report.status === "failed" && (
        <p role="alert" className="flex items-center gap-2 px-1.5 text-step-10 text-danger">
          {report.message}
          <button
            type="button"
            onClick={() => setAttempt((count) => count + 1)}
            className="rounded-sm font-medium text-accent outline-hidden hover:underline focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-accent"
          >
            Try again
          </button>
        </p>
      )}
      {report.status === "ready" && <ReportBody report={report.value} />}
    </div>
  );
}
