import type { TurnSummary } from "@hyperframes/agent-protocol";
import {
  CONTEXT_WARN_RATIO,
  contextLine,
  contextRatio,
  hasUsage,
  usageBreakdown,
  usageLine,
} from "../../agent/usageFormat";
import { useTranslation } from "../../i18n";
import { cn } from "../ui/cn";

/**
 * What a finished turn cost: its tokens and cost (the split in the tooltip) and how full the Director's context
 * window is, which turns amber near the limit. Nothing until the model has reported usage.
 */
export function TurnUsage({ turn }: { turn: TurnSummary }) {
  const { t } = useTranslation();
  if (!hasUsage(turn.usage)) return null;
  const context = turn.directorContext;
  const ratio = context ? contextRatio(context) : null;
  const high = ratio !== null && ratio >= CONTEXT_WARN_RATIO;
  return (
    <p
      data-testid="turn-usage"
      className="flex min-w-0 flex-wrap gap-x-1.5 text-xs leading-4 text-fg-3 tabular-nums"
    >
      <span title={usageBreakdown(turn.usage)}>{usageLine(turn.usage)}</span>
      {context && (
        <>
          <span aria-hidden>·</span>
          <span
            data-testid="turn-context"
            data-context-high={high || undefined}
            title={high ? t("chat.usage.contextHigh") : undefined}
            className={cn(high && "text-warning")}
          >
            {contextLine(context)}
          </span>
        </>
      )}
    </p>
  );
}
