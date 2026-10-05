import type { ChatState, ContextFill, UsageTotals } from "@hyperframes/agent-protocol";
import { formatNumber, formatPercent, t } from "../i18n";

/** `12 400` → `12.4K` (`12,4 тыс.`): what a token count reads like in a footer. */
export function formatTokens(count: number): string {
  return formatNumber(count, { notation: "compact", maximumFractionDigits: 1 });
}

/** The provider's cost in dollars; a sub-cent total reads "<$0.01" instead of a misleading zero. */
export function formatCost(cost: number): string {
  const money = (value: number) =>
    formatNumber(value, { style: "currency", currency: "USD", minimumFractionDigits: 2 });
  return cost > 0 && cost < 0.01 ? t("chat.usage.costTiny", { amount: money(0.01) }) : money(cost);
}

/** True once the model has reported anything worth showing. */
export function hasUsage(usage: UsageTotals | undefined): usage is UsageTotals {
  return usage !== undefined && usage.totalTokens > 0;
}

/** "Tokens: 12.4K · Cost: $0.08": the short line under a turn and in the chat header; the cost only when known. */
export function usageLine(usage: UsageTotals): string {
  const tokens = formatTokens(usage.totalTokens);
  return usage.cost === null
    ? t("chat.usage.summary", { tokens })
    : t("chat.usage.summaryCost", { tokens, cost: formatCost(usage.cost) });
}

/** The split behind the total, for a tooltip: input, output and cached tokens. */
export function usageBreakdown(usage: UsageTotals): string {
  return t("chat.usage.breakdown", {
    input: formatTokens(usage.input),
    output: formatTokens(usage.output),
    cache: formatTokens(usage.cacheRead + usage.cacheWrite),
  });
}

/** The context share at which the UI starts warning that the window is nearly used up. */
export const CONTEXT_WARN_RATIO = 0.8;

/** How full the window is, 0–1+; null when the model's window is not known. */
export function contextRatio(context: ContextFill): number | null {
  return context.window !== null && context.window > 0 ? context.tokens / context.window : null;
}

/** "Context 38% (76K of 200K)"; with no known window just the tokens in use. */
export function contextLine(context: ContextFill): string {
  const ratio = contextRatio(context);
  if (ratio === null || context.window === null) {
    return t("chat.usage.contextTokens", { tokens: formatTokens(context.tokens) });
  }
  return t("chat.usage.context", {
    percent: formatPercent(Math.min(1, ratio)),
    tokens: formatTokens(context.tokens),
    window: formatTokens(context.window),
  });
}

/** The Director's context fill as of the newest turn that reported one. */
export function latestDirectorContext(chat: Pick<ChatState, "turns">): ContextFill | null {
  for (let index = chat.turns.length - 1; index >= 0; index -= 1) {
    const context = chat.turns[index]?.directorContext;
    if (context) return context;
  }
  return null;
}
