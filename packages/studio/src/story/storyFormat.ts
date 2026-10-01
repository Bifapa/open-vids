import { formatDate, t } from "../i18n";

/** Story durations as people read them: `m:ss` (minutes may pass 59: `75:03`). */
export function formatDuration(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds)) return "–:––";
  const whole = Math.max(0, Math.round(seconds));
  const minutes = Math.floor(whole / 60);
  return `${minutes}:${String(whole % 60).padStart(2, "0")}`;
}

/** A point in a source file, to a tenth of a second: `1:02.5`. */
export function formatTime(seconds: number): string {
  const tenths = Math.max(0, Math.round(seconds * 10));
  const minutes = Math.floor(tenths / 600);
  const rest = (tenths % 600) / 10;
  const [whole, fraction] = rest.toFixed(1).split(".");
  return `${minutes}:${whole.padStart(2, "0")}.${fraction}`;
}

const CLOCK = /^(?:(\d+):)?(\d+(?:\.\d+)?)$/;

/**
 * Reads `m:ss`, `m:ss.s` or plain seconds (`90`, `12.5`). Seconds after a colon must be below 60.
 * Returns null for anything else, so a field can mark the text invalid instead of guessing.
 */
export function parseDuration(text: string): number | null {
  const match = CLOCK.exec(text.trim());
  if (!match) return null;
  const [, minutesText, secondsText] = match;
  const seconds = Number(secondsText);
  if (minutesText === undefined) return Number.isFinite(seconds) ? seconds : null;
  if (seconds >= 60) return null;
  return Number(minutesText) * 60 + seconds;
}

/** The last path segment: `media/interview-a.mp4` → `interview-a.mp4`. */
export function fileName(path: string): string {
  const slash = path.lastIndexOf("/");
  return slash >= 0 ? path.slice(slash + 1) : path;
}

/** "3 min ago" style age for the last review/build line. */
export function formatAge(at: number, now: number): string {
  const minutes = Math.round((now - at) / 60_000);
  if (minutes < 1) return t("story.age.justNow");
  if (minutes < 60) return t("story.age.minutes", { count: minutes });
  const hours = Math.round(minutes / 60);
  if (hours < 24) return t("story.age.hours", { count: hours });
  return formatDate(at, { year: "numeric", month: "numeric", day: "numeric" });
}
