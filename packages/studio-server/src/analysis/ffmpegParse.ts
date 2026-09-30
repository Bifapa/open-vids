import type { TimeRange } from "@hyperframes/agent-protocol";

/**
 * Parsers for the text ffmpeg's analysis filters print on stderr. They only read text (no process is spawned here) and
 * match on each filter's own tag, so stderr of several filters may be concatenated.
 */

const NUMBER = String.raw`-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?`;
const round3 = (value: number): number => Math.round(value * 1000) / 1000;

function lines(stderr: string): string[] {
  return stderr.split(/\r?\n|\r/);
}

function number(match: RegExpMatchArray | null, group = 1): number | null {
  const text = match?.[group];
  if (text === undefined) return null;
  const value = Number(text);
  return Number.isFinite(value) ? value : null;
}

/** Clips ranges to `[0, duration]` (unbounded when `duration` is not positive), drops empty ones and sorts them. */
function finish(ranges: TimeRange[], duration: number): TimeRange[] {
  const limit = duration > 0 ? duration : Infinity;
  return ranges
    .map((range) => ({
      start: round3(Math.max(0, range.start)),
      end: round3(Math.min(range.end, limit)),
    }))
    .filter((range) => range.end > range.start)
    .sort((a, b) => a.start - b.start || a.end - b.end);
}

/**
 * Scene-change scores. Understands
 * - `metadata=print` after `select`: a `pts_time:` line followed by `lavfi.scene_score=0.45`,
 * - `select='gt(scene,T)',showinfo`: `pts_time:` lines only (the selection already required a score above T, so the
 *   score is reported as 1 and the caller's threshold decides nothing more),
 * - `scdet`: `lavfi.scd.score: 34.5, lavfi.scd.time: 12.3` (its 0–100 score is scaled to 0–1).
 * The same frame printed by several filters is reported once, with the real score.
 */
export function parseSceneChanges(stderr: string): Array<{ time: number; score: number }> {
  interface Found {
    time: number;
    score: number;
    scored: boolean;
  }
  const found: Found[] = [];
  let pending: { time: number; showinfo: boolean } | null = null;
  const flush = () => {
    if (pending?.showinfo) found.push({ time: pending.time, score: 1, scored: false });
    pending = null;
  };
  for (const line of lines(stderr)) {
    const scd = line.match(
      new RegExp(String.raw`lavfi\.scd\.score:\s*(${NUMBER}).*?lavfi\.scd\.time:\s*(${NUMBER})`),
    );
    if (scd) {
      flush();
      const score = number(scd, 1);
      const time = number(scd, 2);
      if (score !== null && time !== null)
        found.push({ time, score: Math.min(1, Math.max(0, score / 100)), scored: true });
      continue;
    }
    const sceneScore = number(line.match(new RegExp(String.raw`lavfi\.scene_score=(${NUMBER})`)));
    if (sceneScore !== null) {
      if (pending) {
        found.push({ time: pending.time, score: sceneScore, scored: true });
        pending = null;
      }
      continue;
    }
    const time = number(line.match(new RegExp(String.raw`pts_time:\s*(${NUMBER})`)));
    if (time !== null) {
      flush();
      pending = { time, showinfo: line.includes("showinfo") };
    }
  }
  flush();

  found.sort((a, b) => a.time - b.time || Number(b.scored) - Number(a.scored));
  const result: Found[] = [];
  for (const entry of found) {
    const previous = result[result.length - 1];
    if (previous && Math.abs(entry.time - previous.time) < 0.001) {
      if (!previous.scored && entry.scored) result[result.length - 1] = entry;
      continue;
    }
    result.push(entry);
  }
  return result
    .filter((entry) => entry.time >= 0)
    .map((entry) => ({ time: round3(entry.time), score: round3(entry.score) }));
}

/** `blackdetect` lines: `black_start:1.2 black_end:3.4 black_duration:2.2`. */
export function parseBlackdetect(stderr: string): TimeRange[] {
  const found: TimeRange[] = [];
  for (const line of lines(stderr)) {
    if (!line.includes("blackdetect")) continue;
    const start = number(line.match(new RegExp(String.raw`black_start:\s*(${NUMBER})`)));
    const end = number(line.match(new RegExp(String.raw`black_end:\s*(${NUMBER})`)));
    if (start !== null && end !== null) found.push({ start, end });
  }
  return finish(found, 0);
}

/**
 * `freezedetect` lines: `lavfi.freezedetect.freeze_start: 10.5` and `…freeze_end: 13.5`. A start without an end (the
 * picture is frozen until the media ends) ends at `duration`.
 */
export function parseFreezedetect(stderr: string, duration: number): TimeRange[] {
  const found: TimeRange[] = [];
  let open: number | null = null;
  let length: number | null = null;
  for (const line of lines(stderr)) {
    const start = number(
      line.match(new RegExp(String.raw`freezedetect\.freeze_start:\s*(${NUMBER})`)),
    );
    if (start !== null) {
      open = start;
      length = null;
      continue;
    }
    const seen = number(
      line.match(new RegExp(String.raw`freezedetect\.freeze_duration:\s*(${NUMBER})`)),
    );
    if (seen !== null) {
      length = seen;
      continue;
    }
    const end = number(line.match(new RegExp(String.raw`freezedetect\.freeze_end:\s*(${NUMBER})`)));
    if (end === null) continue;
    const from = open ?? (length === null ? null : end - length);
    if (from !== null) found.push({ start: from, end });
    open = null;
    length = null;
  }
  if (open !== null) found.push({ start: open, end: duration });
  return finish(found, duration);
}
