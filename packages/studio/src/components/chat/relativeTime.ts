import { formatDate, t } from "../../i18n";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** "just now", "5m ago", "2h ago", "3d ago"; a plain date once it is over a week old. */
export function relativeTime(timestamp: number, now: number): string {
  const elapsed = Math.max(0, now - timestamp);
  if (elapsed < MINUTE) return t("chat.time.justNow");
  if (elapsed < HOUR) return t("chat.time.minutesAgo", { count: Math.floor(elapsed / MINUTE) });
  if (elapsed < DAY) return t("chat.time.hoursAgo", { count: Math.floor(elapsed / HOUR) });
  if (elapsed < 7 * DAY) return t("chat.time.daysAgo", { count: Math.floor(elapsed / DAY) });
  return formatDate(timestamp, { month: "short", day: "numeric" });
}

/** "12s", "1m 05s": how long a thought or run took. */
export function formatDuration(ms: number): string {
  const seconds = Math.max(1, Math.round(ms / 1000));
  if (seconds < 60) return t("chat.duration.seconds", { seconds });
  const minutes = Math.floor(seconds / 60);
  return t("chat.duration.minutes", {
    minutes,
    seconds: String(seconds % 60).padStart(2, "0"),
  });
}

/** "00:42", "12:05", "1:02:09": a running or finished task's elapsed time, as the Working list shows it. */
export function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = String(Math.floor((total % 3600) / 60)).padStart(2, "0");
  const seconds = String(total % 60).padStart(2, "0");
  return hours > 0 ? `${hours}:${minutes}:${seconds}` : `${minutes}:${seconds}`;
}

/** "14:02": when a message was written, in the user's clock. */
export function formatClockTime(timestamp: number): string {
  return formatDate(timestamp, { hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
}
