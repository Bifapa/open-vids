import {
  isChapter,
  type QaIssueDraft,
  type TimelineClip,
  type TranscriptArtifact,
} from "@hyperframes/agent-protocol";
import { hasNonSpeechToken } from "../helpers/audioNameTokens.js";
import {
  clipName,
  isAudible,
  isCaptionsHost,
  isContent,
  isVisual,
  rateOf,
  round3,
  type QaTimeline,
} from "./timelineModel.js";

/** A visual clip shorter than this reads as a flash, not a shot. */
export const FLASH_SECONDS = 0.25;
/** A hole on the main track between this and FLASH-like sizes is a stutter; longer holes are deliberate (or black). */
const MICRO_GAP_MIN = 0.04;
const MICRO_GAP_MAX = 0.5;
/** A video may run this far past its media before it counts as frozen (rounding of authored durations). */
const OVERRUN_TOLERANCE = 0.1;
/** A cut this close to a word's edge is not "inside" it (the recognizer's timings are rarely tighter). */
const WORD_EDGE_MARGIN = 0.1;
const MESSAGE_LIMIT = 560;

const limit = (text: string, max = MESSAGE_LIMIT): string =>
  text.length > max ? `${text.slice(0, max - 1)}…` : text;

function describe(target: TimelineClip): string {
  return target.src ?? (target.label ? `"${target.label}"` : target.kind);
}

function flashClips(timeline: QaTimeline): QaIssueDraft[] {
  return timeline.snapshot.clips
    .filter(
      (c) =>
        (c.kind === "video" || c.kind === "image" || c.kind === "text") &&
        c.duration > 0 &&
        c.duration < FLASH_SECONDS,
    )
    .map(
      (c): QaIssueDraft => ({
        kind: "awkward_cut",
        severity: "warning",
        source: "timeline",
        check: "timeline.flash_clip",
        start: c.start,
        end: c.end,
        clipIds: [clipName(c)],
        subject: clipName(c),
        message: `A ${c.kind} clip (${describe(c)}) is on screen for only ${round3(c.duration)} s, which reads as a flash.`,
        fixable: true,
        owner: "editor",
        suggestion: `Lengthen it to at least ${FLASH_SECONDS} s (ideally 1 s or more), or remove it.`,
      }),
    );
}

/** Holes of 0.04–0.5 s on the main track that no other picture covers: the screen blinks to black. */
function microGaps(timeline: QaTimeline): QaIssueDraft[] {
  const clips = timeline.snapshot.clips.filter(isVisual);
  const fills = clips.filter(isContent);
  const main = clips.filter((c) => c.track === 0).sort((a, b) => a.start - b.start);
  const issues: QaIssueDraft[] = [];
  let previous: TimelineClip | null = null;
  let cursor = 0;
  for (const next of main) {
    if (previous) {
      const gap = next.start - cursor;
      const covered = fills.some(
        (other) => other.track !== 0 && other.start < next.start && other.end > cursor,
      );
      if (gap > MICRO_GAP_MIN && gap < MICRO_GAP_MAX && !covered) {
        issues.push({
          kind: "awkward_cut",
          severity: "warning",
          source: "timeline",
          check: "timeline.micro_gap",
          start: cursor,
          end: next.start,
          clipIds: [clipName(previous), clipName(next)],
          subject: `gap:${clipName(previous)}:${clipName(next)}`,
          message: `A ${round3(gap)} s hole between two clips on the main track makes the picture blink.`,
          fixable: true,
          owner: "editor",
          suggestion: "Close the gap (ripple the later clips) or extend the clip before it.",
        });
      }
    }
    if (next.end > cursor) cursor = next.end;
    previous = next;
  }
  return issues;
}

/**
 * Stretches of the composition where nothing is on screen: no footage, picture, graphic sub-composition, text or
 * element covers them, so the composition's background shows (black). Only for timelines that have footage at all
 * (a composition drawn purely from elements has no holes to speak of); a hole at the very start or end up to a second
 * long is a fade. The render's own black-frame detection reports the same stretch when the picture really is black.
 */
function emptyHoles(timeline: QaTimeline): QaIssueDraft[] {
  const { clips, composition } = timeline.snapshot;
  if (!clips.some(isContent)) return [];
  const covering = clips
    .filter((c) => isVisual(c) && !isCaptionsHost(c) && c.end > c.start)
    .sort((a, b) => a.start - b.start);
  const holes: Array<{ start: number; end: number }> = [];
  let cursor = 0;
  for (const c of covering) {
    if (c.start > cursor) holes.push({ start: cursor, end: c.start });
    cursor = Math.max(cursor, c.end);
  }
  if (composition.duration > cursor) holes.push({ start: cursor, end: composition.duration });
  return holes
    .filter((hole) => {
      const length = hole.end - hole.start;
      const atEdge = hole.start === 0 || hole.end >= composition.duration;
      return length >= MICRO_GAP_MAX && !(atEdge && length <= 1);
    })
    .map((hole): QaIssueDraft => {
      const neighbours = clips.filter(
        (c) =>
          isVisual(c) &&
          !isCaptionsHost(c) &&
          (Math.abs(c.end - hole.start) < 0.05 || Math.abs(c.start - hole.end) < 0.05),
      );
      return {
        kind: "black_frames",
        severity: "error",
        source: "timeline",
        check: "timeline.gap",
        start: hole.start,
        end: hole.end,
        clipIds: neighbours.map(clipName).slice(0, 32),
        subject: null,
        message: `Nothing is on screen for ${round3(hole.end - hole.start)} s (${round3(hole.start)}–${round3(hole.end)} s): the picture is black there.`,
        fixable: true,
        owner: "editor",
        suggestion: "Fill the gap with a clip or close it (ripple the later clips).",
      };
    });
}

function missingFiles(timeline: QaTimeline): QaIssueDraft[] {
  return timeline.snapshot.clips
    .filter((c) => c.src !== null && timeline.missing.has(c.src))
    .map(
      (c): QaIssueDraft => ({
        kind: c.track > 0 ? "missing_broll" : "other",
        severity: "error",
        source: "timeline",
        check: "timeline.missing_file",
        start: c.start,
        end: c.end,
        clipIds: [clipName(c)],
        subject: c.src,
        message: `The file ${c.src} that clip ${clipName(c)} plays is not in the project.`,
        fixable: true,
        owner: "editor",
        suggestion: "Replace the clip with an existing asset or remove it.",
      }),
    );
}

/** A video clip that plays past the end of its media shows the last frame until it ends: a stuck picture. */
function pastMedia(timeline: QaTimeline): QaIssueDraft[] {
  const issues: QaIssueDraft[] = [];
  for (const c of timeline.snapshot.clips) {
    if (c.kind !== "video" || c.sourceDuration === null) continue;
    const from = c.mediaStart ?? 0;
    const rate = rateOf(timeline, c);
    if (from + c.duration * rate <= c.sourceDuration + OVERRUN_TOLERANCE) continue;
    const frozenFrom = c.start + Math.max(0, c.sourceDuration - from) / rate;
    issues.push({
      kind: "frozen_frames",
      severity: "error",
      source: "timeline",
      check: "timeline.past_media",
      start: Math.min(frozenFrom, c.end),
      end: c.end,
      clipIds: [clipName(c)],
      subject: clipName(c),
      message: `Video ${describe(c)} plays past the end of its media (${round3(c.sourceDuration)} s long, used from ${round3(from)} s): the picture is stuck on the last frame for ${round3(c.end - frozenFrom)} s.`,
      fixable: true,
      owner: "editor",
      suggestion:
        "Trim the clip to end when its media ends, loop or slow it, or use a longer source.",
    });
  }
  return issues;
}

interface SpeechWord {
  start: number;
  /** The recognizer's end, capped at what the word's letters take to say. */
  end: number;
  text: string;
}

/** A letter or digit: a "word" without one (`♪`, `…`) is not speech. Annotations are `[Music]`, `(applause)`, `*laughs*`. */
const SPEECH_TOKEN = /[\p{L}\p{N}]/gu;
const ANNOTATION = /^(?:\[[^\]]*\]|\([^)]*\)|\{[^}]*\}|\*[^*]*\*)$/u;
const EDGE_PUNCTUATION = /^[\s.,;:!?"'«»…-]+|[\s.,;:!?"'«»…-]+$/gu;
/** Recognizer timings stretch a word over the pause after it: a word lasts at most this plus a share per letter. */
const WORD_BASE_SECONDS = 0.3;
const WORD_SECONDS_PER_LETTER = 0.09;
/** Less speech than this (seconds, or share of the source) is the recognizer hearing things in music or noise. */
const MIN_SPEECH_SECONDS = 1;
const MIN_SPEECH_SHARE = 0.02;

/**
 * Whether a source can carry speech: false when a folder or the file name has a token such as `music` or `sfx`
 * (tokens split at anything but letters and digits, a trailing number such as `music2` ignored).
 */
export function isSpeechSource(src: string): boolean {
  return !hasNonSpeechToken(src);
}

/** The words that are speech, with their ends capped: no `♪`, `…`, `[Music]`, `(applause)` or `*laughs*`. */
function speechWords(words: TranscriptArtifact["words"]): SpeechWord[] {
  const speech: SpeechWord[] = [];
  for (const word of words) {
    const letters = word.text.match(SPEECH_TOKEN)?.length ?? 0;
    if (letters === 0 || ANNOTATION.test(word.text.replace(EDGE_PUNCTUATION, ""))) continue;
    speech.push({
      start: word.start,
      end: Math.min(word.end, word.start + WORD_BASE_SECONDS + WORD_SECONDS_PER_LETTER * letters),
      text: word.text,
    });
  }
  return speech;
}

/** Whether a transcript has enough speech for a cut through it to matter. */
function hasSpeech(transcript: TranscriptArtifact, sourceDuration: number | null): boolean {
  if (transcript.speechSeconds < MIN_SPEECH_SECONDS) return false;
  return !(
    sourceDuration !== null &&
    sourceDuration > 0 &&
    transcript.speechSeconds / sourceDuration < MIN_SPEECH_SHARE
  );
}

/** The first word whose interior contains `time` (a cut through it chops the word). */
function wordAround(words: readonly SpeechWord[], time: number): SpeechWord | null {
  let low = 0;
  let high = words.length - 1;
  while (low <= high) {
    const mid = (low + high) >> 1;
    const word = words[mid];
    if (!word) return null;
    if (time <= word.start + WORD_EDGE_MARGIN) high = mid - 1;
    else if (time >= word.end - WORD_EDGE_MARGIN) low = mid + 1;
    else return word;
  }
  return null;
}

/** Seconds around a measured silence that still count as the pause (the level frames are 50 ms). */
const SILENCE_EDGE_MARGIN = 0.05;

function inSilence(silences: readonly { start: number; end: number }[], time: number): boolean {
  return silences.some(
    (range) => time >= range.start - SILENCE_EDGE_MARGIN && time <= range.end + SILENCE_EDGE_MARGIN,
  );
}

/**
 * A cut (clip start or end) that lands inside a spoken word of a clip whose source has a fresh transcript with real
 * speech. Recognizer word timings stretch over the pauses after a word, so a cut in a measured silence, or after the
 * time the word's letters take to say, is a cut in a pause and is not reported. Music and effects sources are not
 * looked at.
 */
function cutsInsideWords(timeline: QaTimeline): QaIssueDraft[] {
  const issues: QaIssueDraft[] = [];
  const wordsBySource = new Map<string, SpeechWord[]>();
  for (const c of timeline.snapshot.clips) {
    if (!isAudible(timeline, c) || c.src === null || !isSpeechSource(c.src)) continue;
    const transcript = timeline.transcripts.get(c.src);
    if (!transcript || transcript.words.length === 0 || !hasSpeech(transcript, c.sourceDuration))
      continue;
    let words = wordsBySource.get(c.src);
    if (!words) {
      words = speechWords(transcript.words);
      wordsBySource.set(c.src, words);
    }
    const silences = timeline.silences?.get(c.src) ?? [];
    const rate = rateOf(timeline, c);
    const from = c.mediaStart ?? 0;
    const to = from + c.duration * rate;
    const edges = [
      { edge: "in", source: from, at: c.start, label: "starts" },
      ...(c.sourceDuration !== null && to >= c.sourceDuration - 0.05
        ? []
        : [{ edge: "out", source: to, at: c.end, label: "ends" }]),
    ];
    for (const { edge, source, at, label } of edges) {
      const word = wordAround(words, source);
      if (!word || inSilence(silences, source)) continue;
      issues.push({
        kind: "awkward_cut",
        severity: "warning",
        source: "timeline",
        check: "timeline.cut_in_word",
        start: at,
        end: at,
        clipIds: [clipName(c)],
        subject: `${clipName(c)}:${edge}`,
        message: `Clip ${describe(c)} ${label} in the middle of the word "${word.text.trim()}" (source ${round3(source)} s): the speech is cut mid-word.`,
        fixable: true,
        owner: "editor",
        suggestion: `Move the ${edge === "in" ? "start" : "end"} to a pause: before the word at source ${round3(word.start)} s or after it at ${round3(word.end)} s.`,
      });
    }
  }
  return issues;
}

/**
 * Missing Asset nodes of built chapters that still wait for material. Research only fills them when the user allows
 * it, so the correction loop cannot fix these (`fixable: false`); they are reported so the Director tells the user.
 */
function unresolvedMissingAssets(timeline: QaTimeline): QaIssueDraft[] {
  const { graph, snapshot } = timeline;
  const build = graph?.build;
  if (!graph || !build || build.composition !== snapshot.composition.path) return [];
  const built = new Map(build.chapters.map((chapter) => [chapter.node, chapter]));
  const issues: QaIssueDraft[] = [];
  for (const attachment of graph.attachments) {
    const chapterRecord = built.get(attachment.chapter);
    const node = graph.nodes.find((entry) => entry.id === attachment.node);
    const chapter = graph.nodes.find((entry) => entry.id === attachment.chapter);
    if (!chapterRecord || node?.kind !== "missing" || !chapter || !isChapter(chapter)) continue;
    const own = snapshot.clips.filter((c) => c.provenance?.storyNode === chapter.id);
    issues.push({
      kind: "missing_broll",
      severity: "warning",
      source: "timeline",
      check: "story.missing_asset",
      start: own.length ? Math.min(...own.map((c) => c.start)) : chapterRecord.start,
      end: own.length ? Math.max(...own.map((c) => c.end)) : chapterRecord.end,
      clipIds: own.map(clipName).slice(0, 32),
      subject: `story:${node.id}@${chapter.id}`,
      message: limit(
        `Chapter "${chapter.title}" still waits for ${node.mediaKind} material "${node.title}": ${node.need}`,
      ),
      fixable: false,
      owner: "research",
      suggestion: "The user can allow Research to find it (Find missing material) or add a file.",
    });
  }
  return issues;
}

/** Findings derived from the timeline alone. */
export function timelineIssues(timeline: QaTimeline): QaIssueDraft[] {
  return [
    ...flashClips(timeline),
    ...microGaps(timeline),
    ...emptyHoles(timeline),
    ...missingFiles(timeline),
    ...pastMedia(timeline),
    ...cutsInsideWords(timeline),
    ...unresolvedMissingAssets(timeline),
  ];
}
