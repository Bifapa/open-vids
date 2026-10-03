import type {
  AssetRange,
  CutPlan,
  CutPlanRequest,
  CutRange,
  CutRemoval,
  CutRemovalReason,
  Segment,
  SegmentMap,
  ShotMap,
  SilenceMap,
  TakeAnalysis,
  TakeIssue,
  TranscriptArtifact,
} from "@hyperframes/agent-protocol";
import { pickedForUse } from "../helpers/pickedRange.js";
import { AnalysisFailure } from "./errors.js";

const DEFAULT_LABEL = "rough cut";
const DEFAULT_MAX_PAUSE = 0.7;
const DEFAULT_PAUSE_KEEP = 0.3;
/** Audio kept before the first and after the last word of a range, so cuts do not clip consonants. */
const PAD_BEFORE = 0.08;
const PAD_AFTER = 0.12;
/** Ranges separated by less than this (with no word between them) are one range. */
const JOIN_GAP = 0.05;
/** Ranges shorter than this are joined to a neighbour when only silence lies between them. */
const MIN_FRAGMENT = 0.25;
/** …but never across a gap longer than this. */
const MAX_FRAGMENT_BRIDGE = 1;
const TARGET_TOLERANCE = 0.1;
const SHOULD_DROP_WARNING = 0.3;
const MAX_LISTED_WARNINGS = 10;
/** Word times are rounded to milliseconds, so a pause of exactly maxPause can measure a hair longer. */
const PAUSE_TOLERANCE = 0.0005;

const round3 = (value: number): number => Math.round(value * 1000) / 1000;
const seconds = (value: number): string => `${value.toFixed(1)} s`;

/**
 * The effective options of a plan: `base` (the plan being refined) overridden by whatever `request` gives, with the
 * defaults filled in (`removeIssues: "auto"`, `removeFillers: true`, `maxPause: 0.7`, `pauseKeep: 0.3`, label "rough
 * cut"). The label is never inherited. An inherited `pauseKeep` that no longer fits a smaller `maxPause` is lowered to
 * it; a `pauseKeep` given together with a smaller `maxPause` is refused.
 */
export function mergeCutRequest(
  base: CutPlanRequest | null,
  request: CutPlanRequest,
): CutPlanRequest {
  if (base && base.source !== request.source)
    throw new AnalysisFailure(
      "invalid_request",
      `The plan being refined is for ${base.source}, not ${request.source}.`,
    );
  const merged: CutPlanRequest = { ...base, source: request.source };
  for (const [key, value] of Object.entries(request))
    if (value !== undefined) Reflect.set(merged, key, value);
  merged.label = request.label ?? DEFAULT_LABEL;
  const basedOn = request.basedOn ?? base?.basedOn;
  if (basedOn === undefined) delete merged.basedOn;
  else merged.basedOn = basedOn;
  merged.removeIssues ??= "auto";
  merged.removeFillers ??= true;
  merged.maxPause ??= DEFAULT_MAX_PAUSE;
  merged.pauseKeep ??= DEFAULT_PAUSE_KEEP;
  if (merged.pauseKeep > merged.maxPause) {
    if (request.pauseKeep !== undefined)
      throw new AnalysisFailure(
        "invalid_request",
        `pauseKeep (${merged.pauseKeep}) must not exceed maxPause (${merged.maxPause}).`,
      );
    merged.pauseKeep = merged.maxPause;
  }
  return merged;
}

interface Piece {
  from: number;
  to: number;
  /** Word index range played, inclusive. */
  first: number;
  last: number;
  segment: string | null;
  hook: boolean;
  /** A pause was cut out just before this piece (it must not be bridged back together). */
  pauseBefore: boolean;
}

/** Indices of a longest increasing subsequence (earliest one on ties): the segments that stay in source order. */
function stayingInOrder(values: readonly number[]): Set<number> {
  const length: number[] = [];
  const previous: number[] = [];
  let bestEnd = -1;
  for (let i = 0; i < values.length; i++) {
    length[i] = 1;
    previous[i] = -1;
    for (let j = 0; j < i; j++) {
      if ((values[j] ?? 0) < (values[i] ?? 0) && (length[j] ?? 0) + 1 > (length[i] ?? 0)) {
        length[i] = (length[j] ?? 0) + 1;
        previous[i] = j;
      }
    }
    if (bestEnd < 0 || (length[i] ?? 0) > (length[bestEnd] ?? 0)) bestEnd = i;
  }
  const staying = new Set<number>();
  for (let i = bestEnd; i >= 0; i = previous[i] ?? -1) staying.add(i);
  return staying;
}

interface CleanerInput {
  words: TranscriptArtifact["words"];
  silence: SilenceMap | null;
  maxPause: number;
  pauseKeep: number;
  sourceDuration: number;
  /** Segment each word belongs to (null: none), carried onto the pieces. */
  wordSegment: ReadonlyArray<string | null>;
}

/**
 * The range cleaner shared by the rough-cut planner and Build Story: lays words down in the given order and cuts
 * long silences (silence map when there is one, word gaps otherwise), pads to word boundaries and joins fragments.
 */
function createCleaner({
  words,
  silence,
  maxPause,
  pauseKeep,
  sourceDuration,
  wordSegment,
}: CleanerInput) {
  // ── Ranges ─────────────────────────────────────────────────────────────────
  // With a silence map, every silence longer than maxPause is shortened to pauseKeep whatever the word timestamps say
  // (recognizers stretch words over pauses). Word gaps are the fallback when there is no silence map.
  const silences = silence
    ? silence.silences
        .filter((range) => range.end - range.start - maxPause > PAUSE_TOLERANCE)
        .sort((a, b) => a.start - b.start)
    : null;
  const silenceCuts = (silences ?? []).map((range) => ({
    from: range.start + pauseKeep / 2,
    to: range.end - pauseKeep / 2,
  }));
  // A word whose timing runs into such a silence is audible only up to (or from) the silence edge.
  const audibleStart: number[] = words.map((word) => word.start);
  const audibleEnd: number[] = words.map((word) => word.end);
  if (silences) {
    let from = 0;
    for (const [i, word] of words.entries()) {
      while (from < silences.length && (silences[from]?.end ?? Infinity) <= word.start) from++;
      for (let s = from; s < silences.length; s++) {
        const range = silences[s];
        if (!range || range.start >= word.end) break;
        const startsInside = word.start >= range.start;
        const endsInside = word.end <= range.end;
        if (startsInside && !endsInside)
          audibleStart[i] = Math.max(audibleStart[i] ?? 0, range.end);
        else if (endsInside && !startsInside)
          audibleEnd[i] = Math.min(audibleEnd[i] ?? 0, range.start);
      }
    }
  }
  const startOf = (i: number): number => audibleStart[i] ?? words[i]?.start ?? 0;
  const endOf = (i: number): number => audibleEnd[i] ?? words[i]?.end ?? 0;
  const clipStart = (i: number): number =>
    Math.max(0, startOf(i) - PAD_BEFORE, i > 0 ? endOf(i - 1) : 0);
  const clipEnd = (i: number): number =>
    Math.min(
      sourceDuration,
      endOf(i) + PAD_AFTER,
      i + 1 < words.length ? startOf(i + 1) : sourceDuration,
    );
  const open = (i: number, hook: boolean, from = clipStart(i)): Piece => ({
    from,
    to: from,
    first: i,
    last: i,
    segment: wordSegment[i] ?? null,
    hook,
    pauseBefore: false,
  });

  /** Lays the words down in the given order; a jump in the transcript (or, without a silence map, a long pause) starts a new piece. */
  const lay = (indices: readonly number[], hook: boolean) => {
    const pieces: Piece[] = [];
    const pauses: CutRemoval[] = [];
    let current: Piece | null = null;
    for (const i of indices) {
      const word = words[i];
      if (!word) continue;
      if (!current) {
        current = open(i, hook);
        continue;
      }
      const before = words[current.last];
      if (i === current.last + 1 && before) {
        if (!silences && word.start - before.end - maxPause > PAUSE_TOLERANCE) {
          current.to = before.end + pauseKeep / 2;
          pauses.push({
            from: current.to,
            to: word.start - pauseKeep / 2,
            reason: "pause",
            ref: null,
          });
          pieces.push(current);
          current = open(i, hook, word.start - pauseKeep / 2);
          current.pauseBefore = true;
        } else current.last = i;
      } else {
        current.to = clipEnd(current.last);
        pieces.push(current);
        current = open(i, hook);
      }
    }
    if (current) {
      current.to = clipEnd(current.last);
      pieces.push(current);
    }
    return { pieces, pauses };
  };

  /** Cuts the middle out of every long silence a piece spans, leaving pauseKeep of it around the cut. */
  const cutSilences = (pieces: Piece[]) => {
    const result: Piece[] = [];
    const pauses: CutRemoval[] = [];
    for (const piece of pieces) {
      const parts: Array<{ from: number; to: number; pauseBefore: boolean }> = [];
      let cursor = piece.from;
      let cutSoFar = piece.pauseBefore;
      for (const cut of silenceCuts) {
        if (cut.to <= cursor) continue;
        if (cut.from >= piece.to) break;
        if (cut.from > cursor) parts.push({ from: cursor, to: cut.from, pauseBefore: cutSoFar });
        pauses.push({
          from: Math.max(cut.from, cursor),
          to: Math.min(cut.to, piece.to),
          reason: "pause",
          ref: null,
        });
        cursor = cut.to;
        cutSoFar = true;
        if (cursor >= piece.to) break;
      }
      if (cursor < piece.to) parts.push({ from: cursor, to: piece.to, pauseBefore: cutSoFar });
      if (parts.length === 1 && parts[0]?.from === piece.from && parts[0].to === piece.to) {
        result.push(piece);
        continue;
      }
      for (const part of parts) {
        let first = -1;
        let last = -1;
        for (let i = piece.first; i <= piece.last; i++) {
          const middle = (startOf(i) + endOf(i)) / 2;
          if (middle < part.from || middle > part.to) continue;
          if (first < 0) first = i;
          last = i;
        }
        // A part that holds no word is only silence.
        if (first >= 0) result.push({ ...piece, ...part, first, last });
      }
    }
    return { pieces: result, pauses };
  };

  /** Joins ranges that only silence separates when they are tiny apart, or when one is a fragment. */
  const tidy = (pieces: Piece[]): Piece[] => {
    const list = pieces.map((piece) => ({ ...piece }));
    const joinable = (a: Piece, b: Piece) => b.first === a.last + 1 && !b.pauseBefore;
    for (let k = 0; k + 1 < list.length; ) {
      const a = list[k];
      const b = list[k + 1];
      if (a && b && joinable(a, b) && b.from - a.to < JOIN_GAP) {
        a.to = Math.max(a.to, b.to);
        a.last = b.last;
        list.splice(k + 1, 1);
      } else k++;
    }
    for (let changed = true; changed; ) {
      changed = false;
      for (let k = 0; k < list.length; k++) {
        const piece = list[k];
        if (!piece || piece.to - piece.from >= MIN_FRAGMENT) continue;
        const before = list[k - 1];
        const after = list[k + 1];
        const gapBefore = before && joinable(before, piece) ? piece.from - before.to : Infinity;
        const gapAfter = after && joinable(piece, after) ? after.from - piece.to : Infinity;
        if (Math.min(gapBefore, gapAfter) > MAX_FRAGMENT_BRIDGE) continue;
        if (before && gapBefore <= gapAfter) {
          before.to = piece.to;
          before.last = piece.last;
          list.splice(k, 1);
        } else if (after) {
          after.from = piece.from;
          after.first = piece.first;
          after.pauseBefore = piece.pauseBefore;
          list.splice(k, 1);
        }
        changed = true;
        break;
      }
    }
    return list;
  };

  /** Word indices (played in this order) → cleaned pieces plus the pauses cut out of them. */
  const clean = (indices: readonly number[], hook: boolean) => {
    const laid = lay(indices, hook);
    const cut = silences ? cutSilences(laid.pieces) : laid;
    return { pieces: tidy(cut.pieces), pauses: cut.pauses };
  };
  return { clean };
}

/** Reordered material can leave the padding of two pieces overlapping in the source: split the overlap between them. */
function separateOverlaps(pieces: Piece[]): void {
  const bySource = [...pieces].sort((a, b) => a.from - b.from || a.to - b.to);
  for (let k = 0; k + 1 < bySource.length; k++) {
    const a = bySource[k];
    const b = bySource[k + 1];
    if (a && b && b.from < a.to) {
      const middle = (b.from + a.to) / 2;
      a.to = middle;
      b.from = middle;
    }
  }
}

/** Words whose issues a cut removes by default (bad takes, fillers), as a mask over the transcript words. */
function defaultRemovedWords(
  words: TranscriptArtifact["words"],
  takes: TakeAnalysis | null,
  removeFillers: boolean,
): boolean[] {
  const removed: boolean[] = new Array<boolean>(words.length).fill(false);
  for (const issue of takes?.issues ?? []) {
    const removable =
      issue.action === "cut" &&
      issue.kind !== "black" &&
      issue.kind !== "frozen" &&
      (issue.kind === "filler" ? removeFillers : true);
    if (!removable) continue;
    for (const [i, word] of words.entries()) {
      const middle = (word.start + word.end) / 2;
      if (middle >= issue.start && middle <= issue.end) removed[i] = true;
    }
  }
  return removed;
}

export interface CleanRangesInput {
  /** Source ranges in the order they play. */
  ranges: ReadonlyArray<{ from: number; to: number; segment: string | null }>;
  transcript: TranscriptArtifact;
  takes: TakeAnalysis | null;
  silence: SilenceMap | null;
  sourceDuration: number;
  maxPause?: number;
  pauseKeep?: number;
  removeFillers?: boolean;
}

export interface CleanedRange {
  from: number;
  to: number;
  segment: string | null;
}

/**
 * Cleans source ranges exactly the way the rough-cut planner cleans segments: take issues with action `cut` and
 * fillers are removed, pauses longer than `maxPause` (0.7 s) shrink to `pauseKeep` (0.3 s) using the silence map,
 * pieces are padded to word boundaries and tidied. A range without any speech is kept as it is. Output is in play
 * order; `at` positions are the caller's business (lay them back to back).
 */
export function cleanRanges(input: CleanRangesInput): CleanedRange[] {
  const { words } = input.transcript;
  const maxPause = input.maxPause ?? DEFAULT_MAX_PAUSE;
  const pauseKeep = input.pauseKeep ?? DEFAULT_PAUSE_KEEP;
  const removed = defaultRemovedWords(words, input.takes, input.removeFillers ?? true);
  const wordSegment: Array<string | null> = new Array<string | null>(words.length).fill(null);
  const perRange: number[][] = input.ranges.map((range) => {
    const indices: number[] = [];
    for (const [i, word] of words.entries()) {
      const middle = (word.start + word.end) / 2;
      if (middle < range.from || middle >= range.to) continue;
      wordSegment[i] = range.segment;
      if (!removed[i]) indices.push(i);
    }
    return indices;
  });
  const cleaner = createCleaner({
    words,
    silence: input.silence,
    maxPause,
    pauseKeep,
    sourceDuration: input.sourceDuration,
    wordSegment,
  });
  const toRanges = (pieces: Piece[]): CleanedRange[] =>
    pieces
      .filter((piece) => piece.to > piece.from)
      .map((piece) => {
        const from = Math.round(piece.from * 1000);
        const to = Math.max(from + 1, Math.round(piece.to * 1000));
        return { from: from / 1000, to: to / 1000, segment: piece.segment };
      });

  const result: CleanedRange[] = [];
  let pending: number[] = [];
  const flush = () => {
    if (pending.length === 0) return;
    const { pieces } = cleaner.clean(pending, false);
    separateOverlaps(pieces);
    result.push(...toRanges(pieces));
    pending = [];
  };
  for (const [index, range] of input.ranges.entries()) {
    const indices = perRange[index] ?? [];
    const speechless = !words.some((word) => {
      const middle = (word.start + word.end) / 2;
      return middle >= range.from && middle < range.to;
    });
    if (speechless) {
      flush();
      const to = Math.min(range.to, input.sourceDuration);
      if (to > range.from) result.push({ from: range.from, to, segment: range.segment });
    } else pending.push(...indices);
  }
  flush();
  return result;
}

/**
 * The deterministic editor: turns a request (segment order, drops, hook, which issues and pauses to remove) plus the
 * analysis into source ranges laid back to back on the cut's timeline. When the user picked a fragment of the source
 * (`mediaRange`), every kept range stays inside it: segments outside it are dropped with a warning, words and pieces
 * are clipped to it, and the pick is recorded on the plan. Throws `AnalysisFailure` (`invalid_request`) for unknown
 * ids, for dropping a `must` segment without `allowDropMust`, and for a plan that keeps nothing. Pauses come from the
 * silence map when there is one (every silence longer than maxPause is cut down to pauseKeep, whatever the word
 * timestamps claim), else from word gaps.
 */
export function planCut(input: {
  id: string;
  createdAt: number;
  request: CutPlanRequest;
  basedOn: string | null;
  transcript: TranscriptArtifact;
  transcriptVersion: string;
  silence?: SilenceMap | null;
  takes: TakeAnalysis | null;
  segments: SegmentMap;
  segmentsVersion: string;
  shots: ShotMap | null;
  sourceDuration: number;
  /** The fragment the user picked of the source (null/absent: the whole file). Nothing outside it is kept. */
  mediaRange?: AssetRange | null;
}): CutPlan {
  const { transcript, takes, segments, shots, sourceDuration } = input;
  const request = mergeCutRequest(null, input.request);
  const maxPause = request.maxPause ?? DEFAULT_MAX_PAUSE;
  const pauseKeep = request.pauseKeep ?? DEFAULT_PAUSE_KEEP;
  const { words, sentences } = transcript;
  const pick = input.mediaRange ?? null;
  const inPick = (time: number): boolean =>
    pick === null || (time >= pick.start && time <= pick.end);
  const wordMiddle = (index: number): number => {
    const word = words[index];
    return word ? (word.start + word.end) / 2 : Number.NEGATIVE_INFINITY;
  };
  /** Only the part of a piece the pick allows; null when nothing of it is left. */
  const clampPiece = (piece: Piece): Piece | null => {
    if (pick === null) return piece;
    const from = Math.max(piece.from, pick.start);
    const to = Math.min(piece.to, pick.end);
    return to - from > 0 ? { ...piece, from, to } : null;
  };
  const clampPieces = (list: Piece[]): Piece[] => list.flatMap((piece) => clampPiece(piece) ?? []);
  function invalid(message: string): never {
    throw new AnalysisFailure("invalid_request", message);
  }
  const warnings: string[] = [];

  // ── Validate ids ───────────────────────────────────────────────────────────
  if (segments.segments.length === 0) invalid("There are no segments to plan a cut from.");
  const segmentIndex = new Map(segments.segments.map((segment, index) => [segment.id, index]));
  const sentenceIndex = new Map(sentences.map((sentence, index) => [sentence.id, index]));
  const issueById = new Map((takes?.issues ?? []).map((issue) => [issue.id, issue]));
  const knownSegment = (field: string, id: string): Segment => {
    const segment = segments.segments[segmentIndex.get(id) ?? -1];
    return segment ?? invalid(`${field} lists unknown segment "${id}".`);
  };
  for (const [field, list] of [
    ["order", request.order],
    ["drop", request.drop],
    ["allowDropMust", request.allowDropMust],
  ] as const) {
    const seen = new Set<string>();
    for (const id of list ?? []) {
      knownSegment(field, id);
      if (seen.has(id)) invalid(`${field} lists segment "${id}" twice.`);
      seen.add(id);
    }
  }
  const knownIssues = (field: string, ids: readonly string[]): TakeIssue[] =>
    ids.map((id) => issueById.get(id) ?? invalid(`${field} lists unknown take issue "${id}".`));
  const listedIssues = Array.isArray(request.removeIssues)
    ? knownIssues("removeIssues", request.removeIssues)
    : null;
  const keptAnyway = new Set(knownIssues("keepIssues", request.keepIssues ?? []).map((i) => i.id));
  let hookWords: [number, number] | null = null;
  if (request.hook) {
    const first = sentenceIndex.get(request.hook.firstSentence);
    const last = sentenceIndex.get(request.hook.lastSentence);
    if (first === undefined) invalid(`hook: unknown sentence "${request.hook.firstSentence}".`);
    if (last === undefined) invalid(`hook: unknown sentence "${request.hook.lastSentence}".`);
    if (first > last)
      invalid(
        `hook: ${request.hook.firstSentence} comes after ${request.hook.lastSentence}; firstSentence must not be later.`,
      );
    const head = sentences[first];
    const tail = sentences[last];
    if (head && tail) hookWords = [head.firstWord, tail.lastWord];
  }

  // ── Which segments play, in which order ────────────────────────────────────
  const explicitDrop = new Set(request.drop ?? []);
  const sequence: Segment[] = [];
  if (request.order) {
    for (const id of request.order)
      if (!explicitDrop.has(id)) sequence.push(knownSegment("order", id));
  } else {
    for (const segment of segments.segments)
      if (!explicitDrop.has(segment.id) && segment.priority !== "drop") sequence.push(segment);
  }
  // A segment the picked fragment does not reach cannot play: the pick drops it with a warning, not a refusal.
  const pickedSequence =
    pick === null
      ? sequence
      : sequence.filter((segment) => segment.end > pick.start && segment.start < pick.end);
  const droppedByPick = sequence.filter((segment) => !pickedSequence.includes(segment));
  const playing = new Set(pickedSequence.map((segment) => segment.id));
  const dropped = segments.segments.filter((segment) => !playing.has(segment.id));
  const allowed = new Set(request.allowDropMust ?? []);
  const droppedByPickIds = new Set(droppedByPick.map((segment) => segment.id));
  for (const segment of dropped) {
    if (
      segment.priority === "must" &&
      !allowed.has(segment.id) &&
      !droppedByPickIds.has(segment.id)
    )
      invalid(
        `Segment ${segment.id} "${segment.title}" is marked must; it can only be left out when its id is also in allowDropMust.`,
      );
  }
  if (pick !== null && droppedByPick.length > 0)
    warnings.push(
      `${pickedForUse(request.source, pick)}; ${droppedByPick.map((segment) => `${segment.id} "${segment.title}"`).join(", ")} ${droppedByPick.length === 1 ? "lies" : "lie"} outside it and ${droppedByPick.length === 1 ? "was" : "were"} left out.`,
    );
  const sourceRank = pickedSequence.map((segment) => segmentIndex.get(segment.id) ?? 0);
  const staying = stayingInOrder(sourceRank);
  const moved = pickedSequence
    .filter((_, index) => !staying.has(index))
    .map((segment) => segment.id);

  // ── Which words are removed ────────────────────────────────────────────────
  const allIssues = takes?.issues ?? [];
  const toRemove = new Map<string, TakeIssue>();
  for (const issue of listedIssues ?? allIssues) {
    if (listedIssues === null && (issue.action !== "cut" || issue.kind === "filler")) continue;
    if (listedIssues === null && (issue.kind === "black" || issue.kind === "frozen")) continue;
    toRemove.set(issue.id, issue);
  }
  if (request.removeFillers ?? true)
    for (const issue of allIssues)
      if (issue.kind === "filler" && issue.action === "cut") toRemove.set(issue.id, issue);
  for (const id of keptAnyway) toRemove.delete(id);

  const wordSegment: Array<string | null> = new Array<string | null>(words.length).fill(null);
  const segmentWords = (segment: Segment): [number, number] => {
    const head = sentences[sentenceIndex.get(segment.firstSentence) ?? -1];
    const tail = sentences[sentenceIndex.get(segment.lastSentence) ?? -1];
    if (!head || !tail)
      throw new AnalysisFailure(
        "stale",
        `Segment ${segment.id} refers to sentences that are not in the transcript any more.`,
      );
    return [head.firstWord, tail.lastWord];
  };
  for (const segment of segments.segments) {
    const [from, to] = segmentWords(segment);
    for (let i = from; i <= to; i++) wordSegment[i] = segment.id;
  }
  const removedWord: boolean[] = new Array<boolean>(words.length).fill(false);
  const effective: TakeIssue[] = [];
  for (const issue of toRemove.values()) {
    let touchesPlaying = false;
    for (const [i, word] of words.entries()) {
      const middle = (word.start + word.end) / 2;
      if (middle < issue.start || middle > issue.end) continue;
      if (!inPick(middle)) continue;
      removedWord[i] = true;
      const owner = wordSegment[i];
      if (owner !== null && owner !== undefined && playing.has(owner)) touchesPlaying = true;
    }
    if (touchesPlaying) effective.push(issue);
  }

  const cleaner = createCleaner({
    words,
    silence: input.silence ?? null,
    maxPause,
    pauseKeep,
    sourceDuration,
    wordSegment,
  });
  const keptInOrder: number[] = [];
  for (const segment of pickedSequence) {
    const [from, to] = segmentWords(segment);
    for (let i = from; i <= to; i++)
      if (!removedWord[i] && inPick(wordMiddle(i))) keptInOrder.push(i);
  }
  const main = cleaner.clean(keptInOrder, false);
  const mainPieces = clampPieces(main.pieces);
  separateOverlaps(mainPieces);

  let hookPieces: Piece[] = [];
  if (hookWords) {
    const indices: number[] = [];
    let clipped = false;
    for (let i = hookWords[0]; i <= hookWords[1]; i++) {
      if (removedWord[i]) continue;
      if (!inPick(wordMiddle(i))) {
        clipped = true;
        continue;
      }
      indices.push(i);
    }
    if (clipped && pick !== null)
      warnings.push(
        `${pickedForUse(request.source, pick)}; the hook plays only what is inside it.`,
      );
    hookPieces = clampPieces(cleaner.clean(indices, true).pieces);
  }

  const all = [...hookPieces, ...mainPieces].filter((piece) => piece.to > piece.from);
  if (mainPieces.length === 0)
    invalid(
      pick === null
        ? "The plan keeps no speech: every segment is dropped or removed."
        : `${pickedForUse(request.source, pick)}; no speech inside it is kept: every segment lies outside it, is dropped or is removed.`,
    );

  const ranges: CutRange[] = [];
  let atMs = 0;
  for (const piece of all) {
    const fromMs = Math.round(piece.from * 1000);
    const toMs = Math.max(fromMs + 1, Math.round(piece.to * 1000));
    ranges.push({
      from: fromMs / 1000,
      to: toMs / 1000,
      at: atMs / 1000,
      segment: piece.segment,
      hook: piece.hook,
    });
    atMs += toMs - fromMs;
  }
  const cutDuration = atMs / 1000;

  // ── What was removed ───────────────────────────────────────────────────────
  const removed: CutRemoval[] = [];
  for (const pause of main.pauses) {
    const from = pick === null ? pause.from : Math.max(pause.from, pick.start);
    const to = pick === null ? pause.to : Math.min(pause.to, pick.end);
    if (to <= from) continue;
    const swallowed = ranges.some((range) => !range.hook && range.from <= from && to <= range.to);
    if (!swallowed) removed.push({ ...pause, from: round3(from), to: round3(to) });
  }
  const reasonOf = (issue: TakeIssue): CutRemovalReason =>
    issue.kind === "filler"
      ? "filler"
      : issue.kind === "black" || issue.kind === "frozen"
        ? "visual"
        : "take";
  for (const issue of effective) {
    const from = pick === null ? issue.start : Math.max(issue.start, pick.start);
    const to = pick === null ? issue.end : Math.min(issue.end, pick.end);
    if (to <= from) continue;
    removed.push({ from, to, reason: reasonOf(issue), ref: issue.id });
  }
  for (const segment of dropped)
    removed.push({ from: segment.start, to: segment.end, reason: "segment", ref: segment.id });
  removed.sort((a, b) => a.from - b.from || a.to - b.to);

  let pauseSeconds = 0;
  for (const entry of removed) if (entry.reason === "pause") pauseSeconds += entry.to - entry.from;
  let hookSeconds = 0;
  for (const range of ranges) if (range.hook) hookSeconds += range.to - range.from;

  // ── Warnings ───────────────────────────────────────────────────────────────
  const target = request.targetDuration;
  if (target !== undefined && Math.abs(cutDuration - target) / target > TARGET_TOLERANCE) {
    const percent = Math.round((Math.abs(cutDuration - target) / target) * 100);
    warnings.push(
      `The cut is ${seconds(cutDuration)}, ${percent}% ${cutDuration > target ? "over" : "under"} the ${seconds(target)} target.`,
    );
  }
  const removedIds = new Set(effective.map((issue) => issue.id));
  const leftIn: string[] = [];
  for (const issue of allIssues) {
    if (issue.action !== "review" || removedIds.has(issue.id) || toRemove.has(issue.id)) continue;
    if (issue.kind === "filler" || issue.kind === "black" || issue.kind === "frozen") continue;
    const inCut = ranges.some(
      (range) => !range.hook && range.from < issue.end && range.to > issue.start,
    );
    if (inCut)
      leftIn.push(
        `${issue.id} (${issue.kind}) is still in the cut and needs a decision: ${issue.note}`,
      );
  }
  warnings.push(...leftIn.slice(0, MAX_LISTED_WARNINGS));
  if (leftIn.length > MAX_LISTED_WARNINGS)
    warnings.push(`…and ${leftIn.length - MAX_LISTED_WARNINGS} more take issues left in the cut.`);
  for (const problem of shots?.problems ?? []) {
    const spans: Array<{ at: number; end: number; from: number; to: number }> = [];
    for (const range of ranges) {
      const from = Math.max(range.from, problem.start);
      const to = Math.min(range.to, problem.end);
      if (to <= from) continue;
      const at = range.at + (from - range.from);
      const previous = spans[spans.length - 1];
      if (previous && Math.abs(previous.end - at) < 0.001) {
        previous.end = at + (to - from);
        previous.to = to;
      } else spans.push({ at, end: at + (to - from), from, to });
    }
    for (const span of spans)
      warnings.push(
        `${problem.kind === "black" ? "Black" : "Frozen"} picture stays in the cut at ${seconds(span.at)}–${seconds(span.end)} on the timeline (source ${seconds(span.from)}–${seconds(span.to)}).`,
      );
  }
  const shouldSegments = segments.segments.filter((segment) => segment.priority === "should");
  const shouldDropped = shouldSegments.filter((segment) => !playing.has(segment.id));
  if (
    shouldSegments.length > 0 &&
    shouldDropped.length / shouldSegments.length > SHOULD_DROP_WARNING
  )
    warnings.push(
      `${shouldDropped.length} of ${shouldSegments.length} "should" segments are left out (${shouldDropped.map((segment) => segment.id).join(", ")}).`,
    );

  return {
    id: input.id,
    source: request.source,
    label: request.label ?? DEFAULT_LABEL,
    createdAt: input.createdAt,
    basedOn: input.basedOn,
    stats: {
      sourceDuration,
      cutDuration,
      ranges: ranges.length,
      removedPauseSeconds: round3(pauseSeconds),
      removedFillers: effective.filter((issue) => issue.kind === "filler").length,
      removedTakes: effective.filter((issue) => issue.kind !== "filler").length,
      droppedSegments: dropped.map((segment) => segment.id),
      movedSegments: moved,
      hookSeconds: round3(hookSeconds),
    },
    applied: null,
    request,
    transcriptVersion: input.transcriptVersion,
    segmentsVersion: input.segmentsVersion,
    mediaRange: pick,
    ranges,
    removed,
    warnings,
  };
}
