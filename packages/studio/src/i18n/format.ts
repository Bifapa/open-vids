import { i18n } from "./instance";

/**
 * Numbers, dates, durations and sizes in the active language, through `Intl`. Each call reads the language at
 * call time, so a value formatted during render follows a language switch like any `t()` does. Timecodes
 * (`00:01:23:12`) are not locale-dependent and stay with the player's own formatter.
 */

function locale(): string {
  return i18n.language || "en";
}

export function formatNumber(value: number, options?: Intl.NumberFormatOptions): string {
  return new Intl.NumberFormat(locale(), options).format(value);
}

/** `0.42` → `42%`. */
export function formatPercent(ratio: number, maximumFractionDigits = 0): string {
  return new Intl.NumberFormat(locale(), { style: "percent", maximumFractionDigits }).format(ratio);
}

const BYTE_UNITS = ["byte", "kilobyte", "megabyte", "gigabyte", "terabyte"] as const;

/** Finder-style sizes (units of 1000): `1.2 MB`, `845 kB`. */
export function formatBytes(bytes: number): string {
  let value = Math.max(0, bytes);
  let unit = 0;
  while (value >= 1000 && unit < BYTE_UNITS.length - 1) {
    value /= 1000;
    unit += 1;
  }
  return new Intl.NumberFormat(locale(), {
    style: "unit",
    unit: BYTE_UNITS[unit],
    unitDisplay: "short",
    maximumFractionDigits: unit === 0 ? 0 : value < 100 ? 1 : 0,
  }).format(value);
}

export function formatDate(value: number | Date, options?: Intl.DateTimeFormatOptions): string {
  return new Intl.DateTimeFormat(locale(), options ?? { dateStyle: "medium" }).format(value);
}

export function formatDateTime(value: number | Date): string {
  return new Intl.DateTimeFormat(locale(), { dateStyle: "medium", timeStyle: "short" }).format(
    value,
  );
}

export function formatTime(value: number | Date): string {
  return new Intl.DateTimeFormat(locale(), { timeStyle: "short" }).format(value);
}

/** `3 min ago`, `yesterday`, `in 2 h`: the nearest sensible unit, with `now` injectable for tests. */
export function formatRelativeTime(value: number | Date, now: number = Date.now()): string {
  const ms = (typeof value === "number" ? value : value.getTime()) - now;
  const seconds = Math.round(ms / 1000);
  const rtf = new Intl.RelativeTimeFormat(locale(), { numeric: "auto" });
  const abs = Math.abs(seconds);
  if (abs < 60) return rtf.format(seconds, "second");
  if (abs < 3600) return rtf.format(Math.round(seconds / 60), "minute");
  if (abs < 86400) return rtf.format(Math.round(seconds / 3600), "hour");
  if (abs < 86400 * 30) return rtf.format(Math.round(seconds / 86400), "day");
  if (abs < 86400 * 365) return rtf.format(Math.round(seconds / (86400 * 30)), "month");
  return rtf.format(Math.round(seconds / (86400 * 365)), "year");
}

/**
 * A duration in words, `1 h 5 min` / `48 s` / `2 min`, through `Intl.NumberFormat` unit styles so the unit
 * abbreviations follow the language. For clip times on the timeline use the timecode formatter instead.
 */
export function formatDuration(seconds: number): string {
  const total = Math.max(0, Math.round(seconds));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const unit = (value: number, name: "hour" | "minute" | "second") =>
    new Intl.NumberFormat(locale(), { style: "unit", unit: name, unitDisplay: "narrow" }).format(
      value,
    );
  if (h > 0) return m > 0 ? `${unit(h, "hour")} ${unit(m, "minute")}` : unit(h, "hour");
  if (m > 0) return s > 0 ? `${unit(m, "minute")} ${unit(s, "second")}` : unit(m, "minute");
  return unit(s, "second");
}

/** `a, b and c` in the language's own list style. */
export function formatList(
  items: readonly string[],
  type: "conjunction" | "disjunction" = "conjunction",
): string {
  return new Intl.ListFormat(locale(), { style: "long", type }).format(items);
}
