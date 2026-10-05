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

/** The cleaned A-roll may run this far over a length the user set before the build trims it (the same margin Story review uses). */
const FIT_TOLERANCE = { ratio: 0.15, seconds: 10 };
/** A tail shorter than this is not worth a clip of its own: the fit stops before it. */
const MIN_FITTED_PIECE = 0.3;

const round3 = (value: number) => Number(value.toFixed(3));

/**
 * Fits a chapter to the length the USER gave it: when its cleaned A-roll runs clearly longer (beyond
 * {@link FIT_TOLERANCE}), whole pieces are kept in order until the length is reached and only the last one is cut
 * short (it keeps its start), so every piece that stays is as cleaned and the chapter plays the intended length. The
 * first piece always stays, so a chapter never ends up without its A-roll. A warning states what was kept and the
 * real resulting length. A length the AI estimated (not user-set) never trims anything, and neither does material
 * that is shorter than asked.
 */
export function fitToEstimate(
  chapter: Pick<ChapterNode, "title" | "estimatedDuration" | "userEdited">,
  cleaned: CleanedAroll,
): CleanedAroll {
  const target = chapter.estimatedDuration;
  if (!chapter.userEdited.includes("estimatedDuration") || !(target > 0)) return cleaned;
  if (cleaned.total <= target + Math.max(FIT_TOLERANCE.seconds, target * FIT_TOLERANCE.ratio))
    return cleaned;
  const pieces: CleanedPiece[] = [];
  let kept = 0;
  for (const piece of cleaned.pieces) {
    const remaining = target - kept;
    if (pieces.length > 0 && remaining < MIN_FITTED_PIECE) break;
    const length = piece.to - piece.from;
    if (length <= remaining) {
      pieces.push(piece);
      kept += length;
    } else {
      pieces.push({ ...piece, to: round3(piece.from + remaining) });
      kept += remaining;
      break;
    }
  }
  const total = round3(pieces.reduce((sum, piece) => sum + (piece.to - piece.from), 0));
  return {
    pieces,
    total,
    length: cleaned.length === null ? null : total,
    warnings: [
      ...cleaned.warnings,
      `${chapter.title}: its cleaned A-roll is ${round3(cleaned.total)} s but the user set ${round3(target)} s for this chapter, so the build kept the first ${pieces.length} of ${cleaned.pieces.length} pieces in order (the last one is cut where the length ends and keeps its start): the A-roll is now ${total} s. Choose which segments to keep (edit_story) for a cleaner cut.`,
    ],
  };
}
