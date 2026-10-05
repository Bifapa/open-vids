import type { ChatState } from "@hyperframes/agent-protocol";
import {
  CONTEXT_WARN_RATIO,
  contextLine,
  contextRatio,
  formatCost,
  formatTokens,
  hasUsage,
  latestDirectorContext,
  usageBreakdown,
  usageLine,
} from "../../agent/usageFormat";
import { formatPercent, useTranslation } from "../../i18n";
import { cn } from "../ui/cn";

/**
 * What this chat has used so far, small, in the context row: total tokens and cost (the split and the wording in
 * the tooltip), and — once the Director's context window is known to be filling up — its share, amber near the limit.
 * Hidden on a narrow panel (the turn footers still carry the same numbers); screen readers always get the full line.
 */
export function ChatUsage({ chat }: { chat: ChatState }) {
  const { t } = useTranslation();
  const usage = chat.chat.usage;
  const context = latestDirectorContext(chat);
  const showUsage = hasUsage(usage);
  if (!showUsage && !context) return null;
  const ratio = context ? contextRatio(context) : null;
  const high = ratio !== null && ratio >= CONTEXT_WARN_RATIO;

  const lines = [
    showUsage ? usageLine(usage) : null,
    showUsage ? usageBreakdown(usage) : null,
    context ? contextLine(context) : null,
    high ? t("chat.usage.contextHigh") : null,
  ].filter((line): line is string => line !== null);

  return (
    <span
      data-testid="chat-usage"
      data-context-high={high || undefined}
      title={lines.join("\n")}
      className="inline-flex shrink-0 items-center gap-1 font-mono text-num whitespace-nowrap text-fg-3 tabular-nums @max-[439px]/chat:sr-only"
    >
      <span className="sr-only">{lines.join(". ")}</span>
      <span aria-hidden className="inline-flex items-center gap-1">
        {showUsage && (
          <span>
            {formatTokens(usage.totalTokens)}
            {usage.cost !== null && ` · ${formatCost(usage.cost)}`}
          </span>
        )}
        {ratio !== null && (
          <span className={cn(high && "text-warning")}>
            {showUsage && "· "}
            {t("chat.usage.contextShort", { percent: formatPercent(Math.min(1, ratio)) })}
          </span>
        )}
      </span>
    </span>
  );
}
