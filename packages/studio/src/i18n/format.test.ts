import { describe, expect, it } from "vitest";
import { i18n } from "./instance";
import { formatBytes, formatDuration, formatNumber, formatRelativeTime } from "./format";

describe("locale formatting", () => {
  it("follows the active language", async () => {
    await i18n.changeLanguage("en");
    expect(formatNumber(1234.5)).toBe("1,234.5");
    expect(formatBytes(1_250_000)).toBe("1.3 MB");
    expect(formatRelativeTime(0, 3 * 60_000)).toBe("3 minutes ago");
    expect(formatDuration(3905)).toBe("1h 5m");
    await i18n.changeLanguage("ru");
    expect(formatNumber(1234.5)).toBe("1\u00a0234,5");
    expect(formatRelativeTime(0, 3 * 60_000)).toBe("3 минуты назад");
    await i18n.changeLanguage("en");
  });
});
