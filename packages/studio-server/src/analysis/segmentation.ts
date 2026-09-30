import {
  ANALYSIS_LIMITS,
  type SaveSegmentsRequest,
  type Segment,
  type SegmentMap,
  type SilenceMap,
  type SpeakerMap,
  type TranscriptArtifact,
  type TranscriptSentence,
} from "@hyperframes/agent-protocol";
import { AnalysisFailure } from "./errors.js";
import { isStopword, normalizeToken } from "./lexicon.js";

/** A pause this long between sentences always starts a new segment. */
const HARD_PAUSE_SECONDS = 1.5;
/** A speaker's turn must last longer than this to start (and end) a segment. */
const LONG_TURN_SECONDS = 20;
const MIN_SEGMENT_SECONDS = 40;
const MAX_SEGMENT_SECONDS = 150;
/** A segment shorter than this is merged into a neighbour even when that makes it longer than the maximum. */
const TINY_SEGMENT_SECONDS = 15;
/** Sentences on each side of a gap that the topic comparison looks at. */
const TOPIC_WINDOW = 6;
/** A topic boundary needs at least this many sentences on both sides. */
const TOPIC_MIN_SIDE = 3;
const TOPIC_MIN_DEPTH = 0.3;
const TITLE_WORDS = 8;

const NO_VECTOR: ReadonlyMap<string, number> = new Map();

interface Block {
  first: number;
  last: number;
}

/** Content-word counts of a sentence, crudely stemmed (first five letters) so inflected forms still match. */
function termCounts(sentence: TranscriptSentence): Map<string, number> {
  const counts = new Map<string, number>();
  for (const raw of sentence.text.split(/\s+/)) {
    const token = normalizeToken(raw);
    if (token.length < 2 || isStopword(token)) continue;
    const stem = token.length > 5 ? token.slice(0, 5) : token;
    counts.set(stem, (counts.get(stem) ?? 0) + 1);
  }
  return counts;
}

function cosine(a: ReadonlyMap<string, number>, b: ReadonlyMap<string, number>): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (const [term, count] of a) {
    normA += count * count;
    dot += count * (b.get(term) ?? 0);
  }
  for (const count of b.values()) normB += count * count;
  return normA === 0 || normB === 0 ? 1 : dot / Math.sqrt(normA * normB);
}

function windowVector(
  vectors: readonly ReadonlyMap<string, number>[],
  from: number,
  to: number,
): Map<string, number> {
  const sum = new Map<string, number>();
  for (let i = from; i <= to; i++)
    for (const [term, count] of vectors[i] ?? NO_VECTOR)
      sum.set(term, (sum.get(term) ?? 0) + count);
  return sum;
}

/**
 * Lexical-cohesion topic boundaries (TextTiling): the similarity of the six sentences before a gap to the six after it,
 * turned into depth scores; a boundary is a local maximum of depth that stands out from the rest of the transcript.
 * Returns the depth per gap (gap `g` lies between sentence `g` and `g + 1`) and which gaps are topic boundaries.
 */
function topicShifts(sentences: readonly TranscriptSentence[]): {
  depth: number[];
  boundary: boolean[];
} {
  const gaps = Math.max(0, sentences.length - 1);
  const vectors = sentences.map(termCounts);
  const similarity: number[] = [];
  for (let g = 0; g < gaps; g++) {
    similarity.push(
      cosine(
        windowVector(vectors, Math.max(0, g - TOPIC_WINDOW + 1), g),
        windowVector(vectors, g + 1, Math.min(sentences.length - 1, g + TOPIC_WINDOW)),
      ),
    );
  }
  const depth = similarity.map((value, g) => {
    let left = value;
    for (let k = g - 1; k >= 0 && (similarity[k] ?? 0) >= left; k--) left = similarity[k] ?? left;
    let right = value;
    for (let k = g + 1; k < gaps && (similarity[k] ?? 0) >= right; k++)
      right = similarity[k] ?? right;
    return left - value + (right - value);
  });
  const mean = depth.reduce((sum, value) => sum + value, 0) / Math.max(1, depth.length);
  const variance =
    depth.reduce((sum, value) => sum + (value - mean) ** 2, 0) / Math.max(1, depth.length);
  const cutoff = Math.max(TOPIC_MIN_DEPTH, mean + Math.sqrt(variance) / 2);
  const boundary = depth.map((value, g) => {
    if (value < cutoff || g + 1 < TOPIC_MIN_SIDE || sentences.length - 1 - g < TOPIC_MIN_SIDE)
      return false;
    return value > (depth[g - 1] ?? -1) && value >= (depth[g + 1] ?? -1);
  });
  return { depth, boundary };
}

function dominantSpeaker(
  sentences: readonly TranscriptSentence[],
  first: number,
  last: number,
): string | null {
  const seconds = new Map<string, number>();
  for (let i = first; i <= last; i++) {
    const sentence = sentences[i];
    if (!sentence?.speaker) continue;
    seconds.set(
      sentence.speaker,
      (seconds.get(sentence.speaker) ?? 0) + (sentence.end - sentence.start),
    );
  }
  let best: string | null = null;
  let bestSeconds = 0;
  for (const [speaker, total] of seconds) {
    if (total > bestSeconds) {
      best = speaker;
      bestSeconds = total;
    }
  }
  return best;
}

function segmentOf(
  transcript: TranscriptArtifact,
  id: string,
  first: number,
  last: number,
  fields: Pick<Segment, "title" | "summary" | "role" | "priority">,
): Segment {
  const { sentences } = transcript;
  const head = sentences[first];
  const tail = sentences[last];
  if (!head || !tail) throw new AnalysisFailure("failed", `segment ${id} has no sentences`);
  return {
    id,
    start: head.start,
    end: tail.end,
    firstSentence: head.id,
    lastSentence: tail.id,
    ...fields,
    speaker: dominantSpeaker(sentences, first, last),
  };
}

/**
 * A first segmentation without any understanding of the content: sentences are grouped at long pauses (1.5 s or more),
 * where a speaker's long turn (over 20 s) begins or ends, and at topic shifts (lexical cohesion between windows of six
 * sentences). Segments aim for 40–150 s: tiny ones merge into the neighbour across the weaker boundary, longer ones split
 * at the strongest inner boundary. Every sentence belongs to exactly one segment. An agent replaces this draft with
 * `semanticSegments` after reading the transcript.
 */
export function draftSegments(input: {
  transcript: TranscriptArtifact;
  transcriptVersion: string;
  silence: SilenceMap | null;
  speakers: SpeakerMap | null;
}): SegmentMap {
  const { transcript, transcriptVersion, silence, speakers } = input;
  const { sentences, words } = transcript;
  const base = { source: transcript.source, origin: "draft" as const, transcriptVersion };
  if (sentences.length === 0) return { ...base, segments: [] };

  // Pause after each sentence: the gap, or the silence the map places there when the recognizer stretched a word.
  const gaps = sentences.length - 1;
  const pause: number[] = [];
  const silences = silence?.silences ?? [];
  for (let g = 0; g < gaps; g++) {
    const current = sentences[g];
    const next = sentences[g + 1];
    const lastWord = current ? words[current.lastWord] : undefined;
    const firstWord = next ? words[next.firstWord] : undefined;
    if (!current || !next || !lastWord || !firstWord) {
      pause.push(0);
      continue;
    }
    const from = (lastWord.start + lastWord.end) / 2;
    const to = (firstWord.start + firstWord.end) / 2;
    let quiet = 0;
    for (const range of silences)
      quiet += Math.max(0, Math.min(range.end, to) - Math.max(range.start, from));
    pause.push(Math.max(next.start - current.end, quiet));
  }

  // Speaker rule: runs of consecutive sentences by one voice; a run over 20 s starts a segment, and so does the change after it.
  const speakerBoundary: boolean[] = new Array<boolean>(gaps).fill(false);
  if (speakers?.method === "diarization") {
    const runs: Block[] = [];
    for (const [i, sentence] of sentences.entries()) {
      const previous = runs[runs.length - 1];
      if (previous && sentences[previous.last]?.speaker === sentence.speaker) previous.last = i;
      else runs.push({ first: i, last: i });
    }
    const long = runs.map((run) => {
      const head = sentences[run.first];
      const tail = sentences[run.last];
      return head && tail ? tail.end - head.start > LONG_TURN_SECONDS : false;
    });
    for (let r = 1; r < runs.length; r++)
      if (long[r] || long[r - 1]) speakerBoundary[(runs[r]?.first ?? 1) - 1] = true;
  }

  const topics = topicShifts(sentences);
  /** How strongly a gap separates two segments: used to pick which neighbour to merge with and where to split. */
  const strength = (g: number): number =>
    (pause[g] ?? 0) + (topics.depth[g] ?? 0) + (speakerBoundary[g] ? 1 : 0);
  const seconds = (block: Block): number =>
    (sentences[block.last]?.end ?? 0) - (sentences[block.first]?.start ?? 0);

  let blocks: Block[] = [];
  let first = 0;
  for (let g = 0; g < gaps; g++) {
    if ((pause[g] ?? 0) >= HARD_PAUSE_SECONDS || speakerBoundary[g] || topics.boundary[g]) {
      blocks.push({ first, last: g });
      first = g + 1;
    }
  }
  blocks.push({ first, last: sentences.length - 1 });

  // Merge short blocks into the neighbour across the weaker boundary.
  const settled = new Set<number>();
  for (;;) {
    let index = -1;
    for (const [i, block] of blocks.entries()) {
      if (settled.has(block.first) || seconds(block) >= MIN_SEGMENT_SECONDS) continue;
      if (index < 0 || seconds(block) < seconds(blocks[index] ?? block)) index = i;
    }
    const block = blocks[index];
    if (!block || blocks.length === 1) break;
    const before = blocks[index - 1];
    const after = blocks[index + 1];
    const options: Array<{ target: number; gap: number; merged: number }> = [];
    if (before)
      options.push({
        target: index - 1,
        gap: block.first - 1,
        merged: seconds({ first: before.first, last: block.last }),
      });
    if (after)
      options.push({
        target: index + 1,
        gap: block.last,
        merged: seconds({ first: block.first, last: after.last }),
      });
    const fits = options.filter((option) => option.merged <= MAX_SEGMENT_SECONDS);
    const pool = fits.length > 0 ? fits : seconds(block) < TINY_SEGMENT_SECONDS ? options : [];
    const choice = [...pool].sort(
      (a, b) => strength(a.gap) - strength(b.gap) || a.merged - b.merged,
    )[0];
    if (!choice) {
      settled.add(block.first);
      continue;
    }
    const other = blocks[choice.target];
    if (!other) break;
    const merged: Block = {
      first: Math.min(block.first, other.first),
      last: Math.max(block.last, other.last),
    };
    blocks = blocks.flatMap((entry, i) => {
      if (i === Math.min(index, choice.target)) return [merged];
      if (i === Math.max(index, choice.target)) return [];
      return [entry];
    });
  }

  // Split long blocks at the strongest inner boundary that leaves both parts at least the minimum.
  const split = (block: Block): Block[] => {
    if (seconds(block) <= MAX_SEGMENT_SECONDS || block.first === block.last) return [block];
    const middle = ((sentences[block.first]?.start ?? 0) + (sentences[block.last]?.end ?? 0)) / 2;
    const candidates: number[] = [];
    for (let g = block.first; g < block.last; g++) candidates.push(g);
    const roomy = candidates.filter(
      (g) =>
        seconds({ first: block.first, last: g }) >= MIN_SEGMENT_SECONDS &&
        seconds({ first: g + 1, last: block.last }) >= MIN_SEGMENT_SECONDS,
    );
    const pool = roomy.length > 0 ? roomy : candidates;
    const distance = (g: number) => Math.abs((sentences[g]?.end ?? 0) - middle);
    const at = [...pool].sort(
      (a, b) => strength(b) - strength(a) || distance(a) - distance(b) || a - b,
    )[0];
    if (at === undefined) return [block];
    return [
      ...split({ first: block.first, last: at }),
      ...split({ first: at + 1, last: block.last }),
    ];
  };
  blocks = blocks.flatMap(split);

  const segments = blocks.map((block, index) => {
    const opening = words.slice(
      sentences[block.first]?.firstWord ?? 0,
      (sentences[block.last]?.lastWord ?? 0) + 1,
    );
    const title = opening
      .slice(0, TITLE_WORDS)
      .map((word) => word.text)
      .join(" ")
      .slice(0, ANALYSIS_LIMITS.titleChars);
    const role =
      blocks.length > 3 && index === 0
        ? "intro"
        : blocks.length > 3 && index === blocks.length - 1
          ? "outro"
          : "main";
    return segmentOf(transcript, `g${index + 1}`, block.first, block.last, {
      title,
      summary: "",
      role,
      priority: "should",
    });
  });
  return { ...base, segments };
}

/**
 * Validates segments an agent wrote after reading the transcript and turns them into the segment map. They must refer
 * to the current transcript version, use existing sentence ids in time order, and cover every sentence exactly once
 * with no gap and no overlap. Throws `AnalysisFailure` (`conflict` for a stale transcript version, `invalid_request`
 * for everything else) naming the first offending sentences.
 */
export function semanticSegments(params: {
  transcript: TranscriptArtifact;
  transcriptVersion: string;
  request: SaveSegmentsRequest;
  speakers: SpeakerMap | null;
}): SegmentMap {
  const { transcript, transcriptVersion, request } = params;
  if (request.source !== transcript.source)
    throw new AnalysisFailure(
      "invalid_request",
      `Segments are for ${request.source}, but this transcript belongs to ${transcript.source}.`,
    );
  if (request.transcriptVersion !== transcriptVersion)
    throw new AnalysisFailure(
      "conflict",
      `The transcript changed since it was read (version ${request.transcriptVersion} is not the current ${transcriptVersion}); read it again and resend the segments.`,
    );
  const { sentences } = transcript;
  if (sentences.length === 0)
    throw new AnalysisFailure("invalid_request", "The transcript has no sentences to segment.");
  const indexOf = new Map(sentences.map((sentence, index) => [sentence.id, index]));
  const label = (from: number, to: number): string =>
    from === to ? `${sentences[from]?.id} is` : `${sentences[from]?.id}–${sentences[to]?.id} are`;

  const ranges: Block[] = [];
  let expected = 0;
  for (const [index, input] of request.segments.entries()) {
    const number = index + 1;
    const first = indexOf.get(input.firstSentence);
    const last = indexOf.get(input.lastSentence);
    if (first === undefined)
      throw new AnalysisFailure(
        "invalid_request",
        `Segment ${number}: unknown sentence id ${input.firstSentence}.`,
      );
    if (last === undefined)
      throw new AnalysisFailure(
        "invalid_request",
        `Segment ${number}: unknown sentence id ${input.lastSentence}.`,
      );
    if (first > last)
      throw new AnalysisFailure(
        "invalid_request",
        `Segment ${number}: firstSentence ${input.firstSentence} comes after lastSentence ${input.lastSentence}.`,
      );
    if (first > expected)
      throw new AnalysisFailure(
        "invalid_request",
        `${label(expected, first - 1)} not in any segment (before segment ${number}).`,
      );
    if (first < expected) {
      const previous = ranges[ranges.length - 1];
      if (previous && first <= previous.first)
        throw new AnalysisFailure(
          "invalid_request",
          `Segment ${number} (${input.firstSentence}–${input.lastSentence}) is out of time order: it starts before segment ${number - 1}.`,
        );
      throw new AnalysisFailure(
        "invalid_request",
        `Segment ${number} overlaps segment ${number - 1}: ${label(first, Math.min(last, expected - 1))} in both.`,
      );
    }
    ranges.push({ first, last });
    expected = last + 1;
  }
  if (expected < sentences.length)
    throw new AnalysisFailure(
      "invalid_request",
      `${label(expected, sentences.length - 1)} not in any segment (after the last segment).`,
    );

  const segments = ranges.map((range, index) => {
    const source = request.segments[index];
    if (!source) throw new AnalysisFailure("failed", "segment input missing");
    return segmentOf(transcript, `g${index + 1}`, range.first, range.last, {
      title: source.title,
      summary: source.summary,
      role: source.role,
      priority: source.priority,
    });
  });
  return { source: transcript.source, origin: "semantic", transcriptVersion, segments };
}
