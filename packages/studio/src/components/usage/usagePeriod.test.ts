import { describe, expect, it } from "vitest";
import { usagePeriodQuery } from "./usagePeriod";

describe("usagePeriodQuery", () => {
  const now = new Date(2026, 9, 6, 15, 30).getTime();

  it("starts today at local midnight and counts the other spans back from now", () => {
    expect(usagePeriodQuery("today", now)).toEqual({
      since: new Date(2026, 9, 6, 0, 0, 0, 0).getTime(),
      until: null,
    });
    expect(usagePeriodQuery("week", now).since).toBe(now - 7 * 86_400_000);
    expect(usagePeriodQuery("month", now).since).toBe(now - 30 * 86_400_000);
  });

  it("leaves both ends open for all time", () => {
    expect(usagePeriodQuery("all", now)).toEqual({ since: null, until: null });
  });
});
