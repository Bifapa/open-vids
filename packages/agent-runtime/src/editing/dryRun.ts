import type {
  ApplyEditsResponse,
  TimelineClip,
  TimelineSnapshot,
} from "@hyperframes/agent-protocol";
import { formatWarnings } from "./format.js";

const MAX_LINES = 40;

const seconds = (value: number) => `${Number(value.toFixed(2))}`;

const DIFFS: Array<[string, (clip: TimelineClip) => string]> = [
  ["start", (clip) => seconds(clip.start)],
  ["end", (clip) => seconds(clip.end)],
  ["track", (clip) => String(clip.track)],
  ["in-point", (clip) => seconds(clip.mediaStart ?? 0)],
  ["volume", (clip) => String(clip.volume === null ? "-" : seconds(clip.volume))],
  ["muted", (clip) => String(clip.muted)],
  ["locked", (clip) => String(clip.locked)],
  ["speed", (clip) => seconds(clip.playbackRate ?? 1)],
  ["opacity", (clip) => seconds(clip.opacity ?? 1)],
  ["grade", (clip) => clip.colorGrade ?? "none"],
  ["fx", (clip) => String(clip.audioFx ?? 0)],
  ["automation", (clip) => clip.automation?.join("+") ?? "none"],
  ["z-index", (clip) => String(clip.zIndex ?? "-")],
];

function describeClip(clip: TimelineClip): string {
  return `${clip.id} (${clip.kind} "${clip.label.slice(0, 30)}", ${seconds(clip.start)}–${seconds(clip.end)} s, track ${clip.track})`;
}

/** What a batch would change: clips it adds, removes and alters, the composition's length and size. */
export function describeChanges(before: TimelineSnapshot, after: TimelineSnapshot): string[] {
  const lines: string[] = [];
  const old = new Map(before.clips.map((clip) => [clip.id, clip]));
  const kept = new Set<string>();
  for (const clip of after.clips) {
    const previous = old.get(clip.id);
    if (!previous) {
      lines.push(`+ ${describeClip(clip)}`);
      continue;
    }
    kept.add(clip.id);
    const changes = DIFFS.flatMap(([name, read]) => {
      const from = read(previous);
      const to = read(clip);
      return from === to ? [] : [`${name} ${from}→${to}`];
    });
    if (changes.length > 0) lines.push(`~ ${clip.id}: ${changes.join(", ")}`);
  }
  for (const clip of before.clips) {
    if (!kept.has(clip.id)) lines.push(`- ${describeClip(clip)}`);
  }
  const was = before.composition;
  const now = after.composition;
  if (was.duration !== now.duration) {
    lines.push(`composition length ${seconds(was.duration)}→${seconds(now.duration)} s`);
  }
  if (was.width !== now.width || was.height !== now.height) {
    lines.push(`canvas ${was.width}×${was.height}→${now.width}×${now.height}`);
  }
  return lines;
}

/** The answer of a dry run: the per-operation results and the difference to the timeline as it is now. */
export function formatDryRun(before: TimelineSnapshot, response: ApplyEditsResponse): string {
  const changes = describeChanges(before, response.timeline);
  const shown = changes.slice(0, MAX_LINES);
  if (changes.length > shown.length) shown.push(`… ${changes.length - shown.length} more changes`);
  const files = response.changedFiles.length > 0 ? response.changedFiles.join(", ") : "no files";
  const notes = response.results.flatMap((result, index) =>
    result.note ? [`${index + 1}. ${result.op} — ${result.note}`] : [],
  );
  return [
    `Dry run: all ${response.results.length} operations are valid and NOTHING was written. Applying would write ${files}.`,
    shown.length > 0 ? `It would change:\n${shown.join("\n")}` : "It would change no clips.",
    ...notes,
    ...formatWarnings(response.warnings),
    "To apply it, call edit_timeline again with the same operations and without dryRun.",
  ].join("\n");
}
