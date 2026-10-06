import { useId, useState } from "react";
import {
  CaretRight,
  Check,
  FilmStrip,
  Minus,
  ShieldCheck,
  Stop,
  WarningCircle,
} from "@phosphor-icons/react";
import type {
  QaPassPhase,
  QaPassState,
  QaScopeNote,
  TurnQaStatus,
  TurnSummary,
} from "@hyperframes/agent-protocol";
import { useAgentStore } from "../../agent/agentContext";
import { formatPercent, useTranslation } from "../../i18n";
import { cn } from "../ui/cn";
import { Badge, Meter, Spinner, type StatusTone } from "../ui/Status";
import { chatFocus, chatMeasureWide } from "./chatStyles";
import { QaReportView } from "./QaReportView";
import {
  EXECUTION_PRESET_LABELS,
  QA_PASS_PHASE_LABELS,
  QA_VISION_STATUS_LABELS,
  TURN_QA_STATUS_LABELS,
  describeQaCounts,
  isLivePassPhase,
  qaReasonText,
  isPassRenderLinked,
  qaScopeText,
} from "./qaLabels";
import { formatElapsed } from "./relativeTime";
import { useNow } from "./useNow";

function StatusGlyph({ status }: { status: TurnQaStatus }) {
  switch (status) {
    case "running":
      return <Spinner size="sm" />;
    case "passed":
      return <Check aria-hidden weight="bold" className="size-icon-sm" />;
    case "issues_remain":
      return <WarningCircle aria-hidden weight="fill" className="size-icon-sm" />;
    case "skipped":
      return <Minus aria-hidden className="size-icon-sm" />;
    case "failed":
      return <WarningCircle aria-hidden weight="fill" className="size-icon-sm" />;
    case "aborted":
      return <Stop aria-hidden className="size-icon-sm" />;
  }
}

function PhaseGlyph({ phase }: { phase: QaPassPhase }) {
  if (isLivePassPhase(phase)) return <Spinner size="sm" />;
  if (phase === "failed") {
    return <WarningCircle aria-hidden weight="fill" className="size-icon-sm text-error" />;
  }
  if (phase === "aborted") return <Stop aria-hidden className="size-icon-sm text-fg-3" />;
  return <Check aria-hidden weight="bold" className="size-icon-sm text-fg-3" />;
}

const STATUS_TONES: Record<TurnQaStatus, string> = {
  running: "text-fg-2",
  passed: "text-success",
  issues_remain: "text-warning",
  skipped: "text-fg-3",
  failed: "text-error",
  aborted: "text-fg-3",
};

interface PassRowProps {
  pass: QaPassState;
  /** Every pass of the session: whether a pass's render survived depends on the others. */
  passes: readonly QaPassState[];
  sessionRunning: boolean;
  refreshKey: string;
}

function PassRow({ pass, passes, sessionRunning, refreshKey }: PassRowProps) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const qaRenderUrl = useAgentStore((state) => state.qaRenderUrl);
  const reportDomId = useId();
  const expandable = pass.reportId !== null;
  const counts = pass.counts ? describeQaCounts(pass.counts) : [];
  const live = isLivePassPhase(pass.phase);
  // A live pass counts up; a finished one shows how long it took.
  const now = useNow(live && pass.endedAt === undefined);
  const percent =
    pass.phase === "rendering" && pass.progress
      ? Math.round(Math.min(100, Math.max(0, pass.progress.percent)))
      : null;
  // The render waits for the machine's render slot (another render runs): not rendering, and no percent to show.
  const queue = pass.phase === "rendering" ? pass.progress?.queue : undefined;
  const scopeText = qaScopeText(pass.scope, pass.scopeNote);
  const renderLinked = isPassRenderLinked(pass, passes, sessionRunning);
  return (
    <li
      data-qa-pass={pass.pass}
      data-qa-phase={pass.phase}
      className="grid gap-0.5 border-t border-border-subtle px-1 py-1 first:border-t-0"
    >
      <button
        type="button"
        aria-expanded={expandable ? open : undefined}
        aria-controls={expandable && open ? reportDomId : undefined}
        disabled={!expandable}
        onClick={() => setOpen((value) => !value)}
        className={cn(
          "flex min-h-ctl-sm w-full flex-wrap items-center gap-x-1.5 gap-y-0.5 rounded-sm px-1 text-left text-xs",
          expandable && "hover:bg-surface-1",
          chatFocus,
        )}
      >
        <CaretRight
          aria-hidden
          className={cn(
            "size-icon-sm shrink-0 text-fg-3 transition-transform duration-expand",
            open && "rotate-90",
            !expandable && "invisible",
          )}
        />
        <span className="font-medium text-fg">{t("chat.qa.pass", { pass: pass.pass })}</span>
        <span
          data-testid="qa-pass-phase"
          className={cn("inline-flex items-center gap-1", live ? "text-fg-2" : "text-fg-3")}
        >
          <PhaseGlyph phase={pass.phase} />
          {queue && pass.phase === "rendering"
            ? t("chat.qa.phase.queued")
            : t(QA_PASS_PHASE_LABELS[pass.phase])}
          {live ? "…" : ""}
        </span>
        {counts.map(({ key, text }) => {
          let tone: StatusTone = "neutral";
          if (key === "issues" && pass.counts && pass.counts.issues > 0) tone = "warning";
          else if (key === "fixed") tone = "success";
          return (
            <Badge key={key} size="sm" tone={tone} data-qa-count={key} className="tabular-nums">
              {text}
            </Badge>
          );
        })}
        {pass.vision && pass.vision !== "ran" && !scopeText && (
          <span data-testid="qa-pass-vision" className="text-2xs text-fg-3">
            {t(QA_VISION_STATUS_LABELS[pass.vision])}
          </span>
        )}
        {pass.suppressed !== undefined && pass.suppressed > 0 && (
          <Badge size="sm" tone="neutral" data-qa-suppressed className="tabular-nums">
            {t("chat.qa.count.suppressed", { count: pass.suppressed })}
          </Badge>
        )}
        <span
          data-testid="qa-pass-elapsed"
          className="ml-auto font-mono text-num leading-[14px] text-fg-3 tabular-nums"
        >
          {formatElapsed((pass.endedAt ?? now) - pass.startedAt)}
        </span>
      </button>
      {queue && (
        <p
          data-testid="qa-pass-queue"
          role="status"
          className="m-0 flex flex-wrap gap-x-1.5 pl-[22px] text-xs leading-[15px] text-fg-3"
        >
          <span>{t("renders.job.queued", { position: queue.position ?? 1 })}</span>
          {queue.holder !== null && (
            <span>{t("renders.job.queueHolder", { project: queue.holder })}</span>
          )}
        </p>
      )}
      {percent !== null && !queue && (
        <Meter
          value={percent / 100}
          label={t("chat.qa.renderProgress", { percent: formatPercent(percent / 100) })}
          title={pass.progress?.stage ?? undefined}
          data-testid="qa-pass-progress"
          className="mr-1 ml-[22px]"
        />
      )}
      {scopeText && (
        <p data-testid="qa-pass-scope" className="pl-[22px] text-xs leading-[15px] text-fg-3">
          {scopeText}
        </p>
      )}
      {pass.error && <p className="pl-[22px] text-xs leading-[15px] text-error">{pass.error}</p>}
      {renderLinked && pass.renderPath && (
        <a
          href={qaRenderUrl(pass.renderPath)}
          target="_blank"
          rel="noreferrer"
          data-testid="qa-pass-render"
          className={cn(
            "ml-[22px] inline-flex min-w-0 items-center gap-1 self-start rounded-xs text-xs text-fg-3",
            "underline decoration-border-strong underline-offset-2 hover:text-fg hover:decoration-fg-2",
            chatFocus,
          )}
        >
          <FilmStrip aria-hidden className="size-icon-sm shrink-0" />
          <span className="truncate font-mono text-num">{pass.renderPath}</span>
        </a>
      )}
      {pass.renderPath && pass.renderKept === false && (
        <p data-testid="qa-pass-render-removed" className="pl-[22px] text-xs text-fg-3">
          {t("chat.qa.renderRemoved")}
        </p>
      )}
      {expandable && open && pass.reportId && (
        <div id={reportDomId} className="pl-4">
          <QaReportView reportId={pass.reportId} refreshKey={refreshKey} />
        </div>
      )}
    </li>
  );
}

/**
 * The turn's autonomous render QA: how it ended (or where it is), the budget it ran with, and one row per pass
 * with its counts. A pass opens its stored report.
 */
export function RenderQaCard({ turn }: { turn: TurnSummary }) {
  const { t } = useTranslation();
  const qa = turn.qa;
  if (!qa) return null;
  const limit =
    qa.passLimit === 0 ? t("chat.qa.limitOff") : t("chat.qa.limit", { count: qa.passLimit });
  // A revert changes the project; open reports read again and say they are outdated.
  const refreshKey = turn.checkpoint?.status ?? "none";
  // What the last pass checked when that was less than everything ("Timeline checks only"), with why.
  let scopeNote: QaScopeNote | undefined;
  for (const pass of qa.passes) if (pass.scopeNote) scopeNote = pass.scopeNote;
  const scopeText = qaScopeText(qa.scope, scopeNote);

  return (
    <section
      aria-label={t("chat.qa.title")}
      data-testid="render-qa"
      data-qa-status={qa.status}
      className={cn(
        "overflow-hidden rounded-md border border-border-subtle bg-bg-1",
        chatMeasureWide,
      )}
    >
      <div className="flex h-ctl items-center gap-[5px] pr-2 pl-2 text-sm">
        <ShieldCheck aria-hidden className="size-icon-sm shrink-0 text-fg-3" />
        <span className="font-semibold text-fg">{t("chat.qa.title")}</span>
        <span className="min-w-0 flex-1 truncate text-xs text-fg-3">
          {t("chat.qa.summaryLine", { preset: t(EXECUTION_PRESET_LABELS[qa.preset]), limit })}
        </span>
        <span
          data-testid="render-qa-status"
          className={cn("inline-flex shrink-0 items-center gap-1 text-xs", STATUS_TONES[qa.status])}
        >
          <StatusGlyph status={qa.status} />
          {t(TURN_QA_STATUS_LABELS[qa.status])}
        </span>
      </div>
      {qa.reason && (
        <p data-testid="render-qa-reason" className="px-2 pb-1.5 text-xs leading-[15px] text-fg-3">
          {qaReasonText(qa.reason, qa.reasonCode, qa.reasonParams)}
        </p>
      )}
      {scopeText && (
        <p data-testid="render-qa-scope" className="px-2 pb-1.5 text-xs leading-[15px] text-fg-3">
          {scopeText}
        </p>
      )}
      {qa.passes.length > 0 && (
        <ol className="grid border-t border-border-subtle">
          {qa.passes.map((pass) => (
            <PassRow
              key={pass.pass}
              pass={pass}
              passes={qa.passes}
              sessionRunning={qa.status === "running"}
              refreshKey={refreshKey}
            />
          ))}
        </ol>
      )}
    </section>
  );
}
