import type { UsageQuery } from "@hyperframes/agent-protocol";

export const USAGE_PERIODS = ["today", "week", "month", "all"] as const;
export type UsagePeriod = (typeof USAGE_PERIODS)[number];

const DAY_MS = 24 * 60 * 60 * 1000;

/** The span of a period as the usage route takes it: "today" starts at local midnight, the others count back from now. */
export function usagePeriodQuery(period: UsagePeriod, now: number): UsageQuery {
  switch (period) {
    case "today": {
      const midnight = new Date(now);
      midnight.setHours(0, 0, 0, 0);
      return { since: midnight.getTime(), until: null };
    }
    case "week":
      return { since: now - 7 * DAY_MS, until: null };
    case "month":
      return { since: now - 30 * DAY_MS, until: null };
    case "all":
      return { since: null, until: null };
  }
}
