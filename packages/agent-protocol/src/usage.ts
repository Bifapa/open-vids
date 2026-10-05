import type { UsageTotals } from "./types.js";

/** Usage of nothing: the identity of {@link addUsage}. */
export function emptyUsage(): UsageTotals {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: null };
}

/**
 * Sum of two usages. `cost` stays null only while neither side has a cost; a known cost on one side is not lost
 * because the other side's provider reported none.
 */
export function addUsage(a: UsageTotals, b: UsageTotals): UsageTotals {
  return {
    input: a.input + b.input,
    output: a.output + b.output,
    cacheRead: a.cacheRead + b.cacheRead,
    cacheWrite: a.cacheWrite + b.cacheWrite,
    totalTokens: a.totalTokens + b.totalTokens,
    cost: a.cost === null && b.cost === null ? null : (a.cost ?? 0) + (b.cost ?? 0),
  };
}

/** Sum of any number of usages; undefined when there is none (nothing was reported). */
export function sumUsage(usages: Iterable<UsageTotals | undefined>): UsageTotals | undefined {
  let total: UsageTotals | undefined;
  for (const usage of usages) {
    if (usage) total = total ? addUsage(total, usage) : usage;
  }
  return total;
}
