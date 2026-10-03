import type { AssetRange, ChapterNode, StorySourceRange } from "@hyperframes/agent-protocol";
import type { SourceAnalysisData } from "../analysis/service.js";
import { cleanRanges } from "../analysis/cutPlan.js";
import { effectiveRange } from "../editing/assetRanges.js";
import { pickedForUse } from "../helpers/pickedRange.js";

/** Analysis of a source, or null when the source is not a project media file (missing). */
export type AnalysisLookup = (source: string) => Promise<SourceAnalysisData | null>;

export interface CleanedPiece {
  source: string;
  from: number;
  to: number;
  segment: string | null;
}

export interface CleanedAroll {
  pieces: CleanedPiece[];
  /** Sum of the pieces; null when a source is not analysed (its ranges are as the chapter states them). */
  length: number | null;
  /** Sum of the pieces whether or not every source was analysed (what the timeline will hold). */
  total: number;
  warnings: string[];
}

/**
 * The A-roll of a chapter as Build Story lays it down: its ranges cleaned exactly like the rough-cut planner cleans
 * segments (bad takes, fillers, long pauses). Every range is first intersected with the fragment the user picked of
 * its source (`ranges`): nothing outside a pick is laid down, and a pick that cuts material away is said in a
 * warning. A source that is not analysed keeps its ranges as they are, with a warning; a source that is gone is
 * skipped with one.
 */
export async function cleanChapterAroll(
  chapter: Pick<ChapterNode, "title" | "sourceRanges">,
  lookup: AnalysisLookup,
  ranges: ReadonlyMap<string, AssetRange>,
): Promise<CleanedAroll> {
  const groups: Array<{ source: string; ranges: StorySourceRange[] }> = [];
  for (const range of chapter.sourceRanges) {
    const last = groups.at(-1);
    if (last && last.source === range.source) last.ranges.push(range);
    else groups.push({ source: range.source, ranges: [range] });
  }
  const pieces: CleanedPiece[] = [];
  const warnings: string[] = [];
  let analysed = true;
  for (const group of groups) {
    const data = await lookup(group.source);
    if (!data) {
      warnings.push(
        `${chapter.title}: ${group.source} is not in the project; its ranges were left out.`,
      );
      analysed = false;
      continue;
    }
    const duration = data.duration ?? Math.max(...group.ranges.map((range) => range.to));
    const clamped = group.ranges
      .filter((range) => range.from < duration)
      .map((range) => ({
        from: range.from,
        to: Math.min(range.to, duration),
        segment: range.segment,
      }));
    const pick = effectiveRange(ranges.get(group.source), duration);
    let trimmed = false;
    const usable = clamped.flatMap((range) => {
      if (pick === null) return [range];
      const from = Math.max(range.from, pick.start);
      const to = Math.min(range.to, pick.end);
      if (to - from <= 0) {
        trimmed = true;
        return [];
      }
      if (from !== range.from || to !== range.to) trimmed = true;
      return [{ ...range, from, to }];
    });
    if (trimmed && pick !== null) {
      warnings.push(
        `${chapter.title}: ${pickedForUse(group.source, pick)}; only that part of its ranges is used.`,
      );
    }
    if (data.transcript) {
      for (const piece of cleanRanges({
        ranges: usable,
        transcript: data.transcript,
        takes: data.takes,
        silence: data.silence,
        sourceDuration: duration,
      })) {
        // Cleaning pads pieces to word boundaries: trim them back into the pick.
        const from = pick === null ? piece.from : Math.max(piece.from, pick.start);
        const to = pick === null ? piece.to : Math.min(piece.to, pick.end);
        if (to - from > 0) pieces.push({ source: group.source, ...piece, from, to });
      }
    } else {
      analysed = false;
      warnings.push(
        `${chapter.title}: ${group.source} is not analysed; its ranges are used as they are (analyze_media cleans pauses, fillers and bad takes).`,
      );
      for (const range of usable) pieces.push({ source: group.source, ...range });
    }
  }
  const length = pieces.reduce((sum, piece) => sum + (piece.to - piece.from), 0);
  const total = Number(length.toFixed(3));
  return { pieces, length: analysed ? total : null, total, warnings };
}
