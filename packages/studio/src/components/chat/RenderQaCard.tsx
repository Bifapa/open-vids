import { useId, useState } from "react";
import {
  CaretRight,
  Check,
  CircleNotch,
  FilmStrip,
  MinusCircle,
  ShieldCheck,
  StopCircle,
  WarningCircle,
} from "@phosphor-icons/react";
import type {
  QaPassPhase,
  QaPassState,
  TurnQaStatus,
  TurnSummary,
} from "@hyperframes/agent-protocol";
import { useAgentStore } from "../../agent/agentContext";
import { cn } from "../ui/cn";
import { QaReportView } from "./QaReportView";
import {
  EXECUTION_PRESET_LABELS,
  QA_PASS_PHASE_LABELS,
  QA_VISION_STATUS_LABELS,
  TURN_QA_STATUS_LABELS,
  describeQaCounts,
  isLivePassPhase,
} from "./qaLabels";

function Spinner() {
  return (
    <CircleNotch
      size={11}
      weight="bold"
      aria-hidden
      className="shrink-0 animate-spin text-accent motion-reduce:animate-none"
    />
  );
}

function StatusGlyph({ status }: { status: TurnQaStatus }) {
  switch (status) {
    case "running":
      return <Spinner />;
    case "passed":
      return <Check size={11} weight="bold" aria-hidden className="shrink-0 text-accent" />;
    case "issues_remain":
      return (
        <WarningCircle size={11} weight="fill" aria-hidden className="shrink-0 text-container" />
      );
    case "skipped":
      return <MinusCircle size={11} aria-hidden className="shrink-0 text-text-4" />;
    case "failed":
      return <WarningCircle size={11} weight="fill" aria-hidden className="shrink-0 text-danger" />;
    case "aborted":
      return <StopCircle size={11} aria-hidden className="shrink-0 text-text-3" />;
  }
}

function PhaseGlyph({ phase }: { phase: QaPassPhase }) {
  if (isLivePassPhase(phase)) return <Spinner />;
  if (phase === "failed") {
    return <WarningCircle size={11} weight="fill" aria-hidden className="shrink-0 text-danger" />;
  }
  if (phase === "aborted")
    return <StopCircle size={11} aria-hidden className="shrink-0 text-text-3" />;
  return <Check size={11} weight="bold" aria-hidden className="shrink-0 text-text-3" />;
}

const STATUS_TONES: Record<TurnQaStatus, string> = {
  running: "text-text-1",
  passed: "text-accent",
  issues_remain: "text-container",
  skipped: "text-text-3",
  failed: "text-danger",
  aborted: "text-text-3",
};

function PassRow({ pass, refreshKey }: { pass: QaPassState; refreshKey: string }) {
  const [open, setOpen] = useState(false);
  const qaRenderUrl = useAgentStore((state) => state.qaRenderUrl);
  const reportDomId = useId();
  const expandable = pass.reportId !== null;
  const counts = pass.counts ? describeQaCounts(pass.counts) : [];
  const live = isLivePassPhase(pass.phase);

  return (
    <li
      data-qa-pass={pass.pass}
      data-qa-phase={pass.phase}
      className="flex flex-col gap-0.5 border-t border-hairline px-2 py-1 first:border-t-0"
    >
      <button
        type="button"
        aria-expanded={expandable ? open : undefined}
        aria-controls={expandable && open ? reportDomId : undefined}
        disabled={!expandable}
        onClick={() => setOpen((value) => !value)}
        className={cn(
          "flex w-full flex-wrap items-center gap-x-1.5 gap-y-0.5 rounded-sm text-left text-step-11 outline-hidden",
          "focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-accent",
          expandable && "hover:bg-hover/40",
        )}
      >
        <CaretRight
          size={10}
          weight="bold"
          aria-hidden
          className={cn(
            "shrink-0 text-text-4 transition-transform duration-expand",
            open && "rotate-90",
            !expandable && "invisible",
          )}
        />
        <span className="font-medium text-text-1">Pass {pass.pass}</span>
        <span
          data-testid="qa-pass-phase"
          className={cn("flex items-center gap-1", live ? "text-text-1" : "text-text-3")}
        >
          <PhaseGlyph phase={pass.phase} />
          {QA_PASS_PHASE_LABELS[pass.phase]}
          {live ? "…" : ""}
        </span>
        {counts.map(({ key, text }) => (
          <span
            key={key}
            data-qa-count={key}
            className={cn(
              "rounded-sm px-1 text-step-10 tabular-nums",
              key === "issues" && pass.counts && pass.counts.issues > 0
                ? "bg-container/10 text-container"
                : key === "fixed"
                  ? "bg-accent/10 text-accent"
                  : "bg-surface text-text-2",
            )}
          >
            {text}
          </span>
        ))}
        {pass.vision && pass.vision !== "ran" && (
          <span data-testid="qa-pass-vision" className="text-step-10 text-text-4">
            {QA_VISION_STATUS_LABELS[pass.vision]}
          </span>
        )}
      </button>
      {pass.error && <p className="pl-4 text-step-10 text-danger">{pass.error}</p>}
      {pass.renderPath && (
        <a
          href={qaRenderUrl(pass.renderPath)}
          target="_blank"
          rel="noreferrer"
          data-testid="qa-pass-render"
          className="flex min-w-0 items-center gap-1 self-start pl-4 text-step-10 text-text-3 outline-hidden hover:text-text-1 hover:underline focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-accent"
        >
          <FilmStrip size={11} aria-hidden className="shrink-0" />
          <span className="truncate">{pass.renderPath}</span>
        </a>
      )}
      {expandable && open && pass.reportId && (
        <div id={reportDomId} className="pl-3">
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
  const qa = turn.qa;
  if (!qa) return null;
  const limit =
    qa.passLimit === 0
      ? "QA off"
      : `up to ${qa.passLimit} ${qa.passLimit === 1 ? "pass" : "passes"}`;
  // A revert changes the project; open reports read again and say they are outdated.
  const refreshKey = turn.checkpoint?.status ?? "none";

  return (
    <section
      aria-label="Render QA"
      data-testid="render-qa"
      data-qa-status={qa.status}
      className="rounded-md border border-hairline bg-bg-2"
    >
      <div className="flex items-center gap-1.5 px-2 py-1 text-step-11">
        <ShieldCheck size={13} aria-hidden className="shrink-0 text-text-3" />
        <span className="font-medium text-text-1">Render QA</span>
        <span className="min-w-0 flex-1 truncate text-text-3">
          {EXECUTION_PRESET_LABELS[qa.preset]} · {limit}
        </span>
        <span
          data-testid="render-qa-status"
          className={cn("flex shrink-0 items-center gap-1 text-step-10", STATUS_TONES[qa.status])}
        >
          <StatusGlyph status={qa.status} />
          {TURN_QA_STATUS_LABELS[qa.status]}
        </span>
      </div>
      {qa.reason && (
        <p
          data-testid="render-qa-reason"
          className="px-2 pb-1 text-step-10 leading-snug text-text-3"
        >
          {qa.reason}
        </p>
      )}
      {qa.passes.length > 0 && (
        <ol className="flex flex-col border-t border-hairline">
          {qa.passes.map((pass) => (
            <PassRow key={pass.pass} pass={pass} refreshKey={refreshKey} />
          ))}
        </ol>
      )}
    </section>
  );
}
