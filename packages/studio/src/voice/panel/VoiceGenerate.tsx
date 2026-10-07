import { useState, type ReactNode } from "react";
import { WarningCircle } from "@phosphor-icons/react";
import type { VoiceCheckResult, VoiceScriptIssue } from "@hyperframes/agent-protocol";
import { Button, Meter, type ButtonVariant } from "../../components/ui";
import { formatDuration, useTranslation } from "../../i18n";
import { useVoiceEditLock } from "../script/useVoiceScript";
import type { VoiceGeneration } from "../script/voiceScriptStore";
import { useVoiceScriptStore, useVoiceScriptStoreApi } from "../voiceContext";
import { usdOrUnknown } from "../voiceLabels";
import { VoiceIssueList } from "./VoiceIssueList";

type Phase =
  | { kind: "idle" }
  | { kind: "checking" }
  | { kind: "confirm"; check: VoiceCheckResult }
  | { kind: "running" }
  | { kind: "failed"; message: string; issues: VoiceScriptIssue[] }
  | { kind: "settled"; message: string };

interface VoiceGenerateProps {
  /** The lines to generate; absent is every line without a current take. */
  lineIds?: readonly string[];
  /** Makes a new take of lines that already have a current one (Regenerate). */
  force: boolean;
  /** The button's text ("Regenerate", "Generate missing"). */
  label: string;
  icon?: ReactNode;
  variant?: ButtonVariant;
  /** Nothing to generate right now, and why: the button is disabled and says so. */
  disabledReason?: string | null;
  /** Called with what the service made, once it is saved: the clips follow the new takes here. */
  onGenerated?: (generation: VoiceGeneration) => void | Promise<void>;
  testId: string;
}

/**
 * A paid generation, step by step and never silent: the button asks the service what it would cost (a dialect check
 * and an estimate, nothing paid), shows that with the findings and waits for a confirmation, then generates with a
 * progress bar and a Cancel. A finding that is an error keeps the confirmation from going on.
 */
export function VoiceGenerate({
  lineIds,
  force,
  label,
  icon,
  variant = "secondary",
  disabledReason = null,
  onGenerated,
  testId,
}: VoiceGenerateProps) {
  const { t } = useTranslation();
  const store = useVoiceScriptStoreApi();
  const job = useVoiceScriptStore((state) => state.job);
  const { locked, reason } = useVoiceEditLock();
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });

  const otherJob = job !== null && phase.kind !== "running";
  const blocked = locked || disabledReason !== null || otherJob;
  const title = reason ?? disabledReason ?? (otherJob ? t("voice.generate.busy") : undefined);

  const ask = async () => {
    setPhase({ kind: "checking" });
    const answer = await store.getState().estimate(lineIds, { force });
    setPhase(
      answer.ok
        ? { kind: "confirm", check: answer.value }
        : { kind: "failed", message: answer.message, issues: answer.issues },
    );
  };

  const run = async () => {
    setPhase({ kind: "running" });
    const answer = await store.getState().generate({ ...(lineIds && { lineIds }), force });
    if (!answer.ok) {
      setPhase(
        answer.code === "cancelled"
          ? { kind: "settled", message: t("voice.generate.cancelled") }
          : { kind: "failed", message: answer.message, issues: answer.issues },
      );
      return;
    }
    const { lines } = answer.value.result;
    setPhase({
      kind: "settled",
      message:
        lines.length > 0 && lines.every((line) => line.cached)
          ? t("voice.generate.same")
          : lines.length > 0 && lines.every((line) => line.duplicate)
            ? t("voice.generate.sameReading")
            : t("voice.generate.done", { count: lines.length }),
    });
    await onGenerated?.(answer.value);
  };

  if (phase.kind === "running") {
    const cancelling = job?.cancelling === true;
    return (
      <div data-testid={testId} data-phase="running" className="grid gap-1.5">
        <Meter
          value={job !== null && job.total > 0 ? job.done / job.total : 0}
          label={t("voice.generate.progressLabel")}
        />
        <div className="flex flex-wrap items-center gap-1.5">
          <span role="status" className="min-w-0 flex-1 text-xs text-fg-2">
            {cancelling
              ? t("voice.generate.cancelling")
              : t("voice.generate.progress", { done: job?.done ?? 0, total: job?.total ?? 0 })}
          </span>
          <Button
            size="xs"
            variant="ghost"
            data-testid={`${testId}-cancel`}
            disabled={cancelling}
            onClick={() => void store.getState().cancel()}
          >
            {t("common.cancel")}
          </Button>
        </div>
      </div>
    );
  }

  if (phase.kind === "confirm") {
    const { estimate, issues } = phase.check;
    const blockedByIssues = !phase.check.ok;
    const paid = Math.max(0, estimate.lines - estimate.cachedLines);
    return (
      <div
        data-testid={testId}
        data-phase="confirm"
        className="grid gap-1.5 rounded-sm border border-border bg-surface-1 p-2"
      >
        <p data-testid={`${testId}-estimate`} className="m-0 text-xs leading-[15px] text-fg-2">
          {estimate.requests === 0 && !force
            ? t("voice.generate.free", { count: estimate.lines })
            : t("voice.generate.summary", {
                count: paid,
                duration: formatDuration(estimate.seconds),
                cost: usdOrUnknown(estimate.usdCost),
              })}
        </p>
        <VoiceIssueList issues={issues} testId={`${testId}-issues`} />
        <div className="flex flex-wrap items-center gap-1.5">
          <Button
            size="sm"
            variant="primary"
            data-testid={`${testId}-confirm`}
            disabled={blocked || blockedByIssues}
            title={title}
            onClick={() => void run()}
          >
            {t("voice.generate.confirm")}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            data-testid={`${testId}-dismiss`}
            onClick={() => setPhase({ kind: "idle" })}
          >
            {t("common.cancel")}
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div data-testid={testId} data-phase={phase.kind} className="grid gap-1">
      <Button
        size="sm"
        variant={variant}
        icon={icon}
        data-testid={`${testId}-ask`}
        loading={phase.kind === "checking"}
        disabled={blocked || phase.kind === "checking"}
        title={title}
        onClick={() => void ask()}
      >
        {label}
      </Button>
      {phase.kind === "failed" && (
        <div role="alert" className="grid gap-0.5">
          <p className="m-0 flex items-start gap-1 text-xs leading-[15px] text-error">
            <WarningCircle aria-hidden className="mt-px size-icon-sm shrink-0" />
            <span className="min-w-0 [overflow-wrap:anywhere] [text-wrap:pretty]">
              {phase.message}
            </span>
          </p>
          <VoiceIssueList issues={phase.issues} testId={`${testId}-issues`} />
        </div>
      )}
      {phase.kind === "settled" && (
        <p role="status" className="m-0 text-xs leading-[15px] text-fg-3">
          {phase.message}
        </p>
      )}
    </div>
  );
}
