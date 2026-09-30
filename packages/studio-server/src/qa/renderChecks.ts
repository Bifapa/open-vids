import type { QaIssueDraft, TimeRange, TimelineClip } from "@hyperframes/agent-protocol";
import type { AudioLevels } from "../analysis/audioLevels.js";
import { runFfmpeg } from "../analysis/ffmpeg.js";
import { parseBlackdetect, parseFreezedetect } from "../analysis/ffmpegParse.js";
import {
  clipIdsOverlapping,
  clipName,
  isAudible,
  isContent,
  isVisual,
  rateOf,
  round3,
  sourceTime,
  topContentAt,
  type QaTimeline,
} from "./timelineModel.js";

/** Picture below this luma level counts as black (`blackdetect pix_th`). */
const BLACK_MIN_SECONDS = 0.2;
const BLACK_PIXEL_THRESHOLD = 0.1;
/** Black of at least this long inside the video is an error; shorter is a warning. */
const BLACK_ERROR_SECONDS = 0.5;
/** A black head or tail up to this long is a fade in/out. */
const FADE_SECONDS = 1;
const FADE_EDGE_SECONDS = 0.1;
const FREEZE_NOISE = "-60dB";
const FREEZE_MIN_SECONDS = 1;
/** Only the middle band of the picture: captions and lower thirds animate in the top and bottom bands. */
const freezeBandFilter = (noise: string) =>
  `crop=iw:ih*0.36:0:ih*0.3,freezedetect=n=${noise}:d=${FREEZE_MIN_SECONDS}`;
/** Below this the audio counts as silent, from this long on, away from the very start and end. */
export const SILENCE_DB = -50;
const SILENCE_MIN_SECONDS = 1;
const SILENCE_EDGE_SECONDS = 0.5;

export interface FfmpegRunOptions {
  signal: AbortSignal;
  ffmpegPath?: string;
}

export interface PictureFindings {
  black: TimeRange[];
  frozen: TimeRange[];
}

/**
 * One decode of the render's picture at thumbnail size: black frames over the whole frame, and frozen picture over its
 * middle band only. Captions and lower thirds sit in the top and bottom bands and animate on top of a stuck clip
 * (every highlighted word changes pixels), which would hide the freeze from a whole-frame detector.
 */
export async function analysePicture(
  path: string,
  duration: number,
  options: FfmpegRunOptions,
): Promise<PictureFindings> {
  const stderr = await runFfmpeg(
    [
      "-i",
      path,
      "-an",
      "-filter_complex",
      [
        "[0:v:0]scale=320:-2,split=2[whole][band]",
        `[whole]blackdetect=d=${BLACK_MIN_SECONDS}:pix_th=${BLACK_PIXEL_THRESHOLD}[black]`,
        `[band]${freezeBandFilter(FREEZE_NOISE)}[freeze]`,
      ].join(";"),
      "-map",
      "[black]",
      "-f",
      "null",
      "-",
      "-map",
      "[freeze]",
      "-f",
      "null",
      "-",
    ],
    options,
  );
  return { black: parseBlackdetect(stderr), frozen: parseFreezedetect(stderr, duration) };
}

/** A render freeze is dropped when the source is static over at least this much of the same stretch. */
const STATIC_SOURCE_FRACTION = 0.8;
/**
 * How still a source must be to count as static. Looser than the render's own threshold on purpose: the encode
 * flattens sensor noise and dither that a −60 dB comparison of the raw source still sees as motion, so a talking card
 * that looks frozen in the render moves by a hair in its source. A 1 % mean frame difference is invisible.
 */
const SOURCE_STATIC_NOISE = "-40dB";

/**
 * Keeps the render freezes that are the render's fault. Where a video clip is on top, the same band runs on the
 * stretch of the clip's source that the freeze covers: a source that is itself static over most of it (a talking
 * card, a static slide recording) is static by design, not a stuck render. A stretch past the end of the source has no
 * frames there, so it stays (the timeline's past-media check reports the same stretch). A source that cannot be
 * checked keeps the finding, since it was not shown to be static.
 */
export async function withoutStaticSources(
  frozen: readonly TimeRange[],
  timeline: QaTimeline,
  sourcePath: (src: string) => string | null,
  options: FfmpegRunOptions,
): Promise<TimeRange[]> {
  const kept: TimeRange[] = [];
  for (const range of frozen) {
    const top = topContentAt(timeline.snapshot.clips, (range.start + range.end) / 2);
    const file = top?.kind === "video" && top.src !== null ? sourcePath(top.src) : null;
    const from = top ? Math.max(range.start, top.start) : 0;
    const to = top ? Math.min(range.end, top.end) : 0;
    if (!top || !file || to <= from) {
      kept.push(range);
      continue;
    }
    const rate = rateOf(timeline, top);
    try {
      const stderr = await runFfmpeg(
        [
          "-ss",
          sourceTime(timeline, top, from).toFixed(3),
          "-t",
          ((to - from) * rate).toFixed(3),
          "-i",
          file,
          "-an",
          "-vf",
          `scale=320:-2,${freezeBandFilter(SOURCE_STATIC_NOISE)}`,
          "-f",
          "null",
          "-",
        ],
        options,
      );
      const length = (to - from) * rate;
      const still = parseFreezedetect(stderr, length).reduce(
        (sum, found) => sum + (found.end - found.start),
        0,
      );
      if (still / length < STATIC_SOURCE_FRACTION) kept.push(range);
    } catch (error) {
      if (options.signal.aborted) throw error;
      kept.push(range);
    }
  }
  return kept;
}

/** Runs of frames quieter than `SILENCE_DB`, at least a second long, leaving out the first and last half second. */
export function silentRuns(levels: AudioLevels, duration: number): TimeRange[] {
  const { frameSeconds, frameDb } = levels;
  const total = Math.min(duration > 0 ? duration : Infinity, frameDb.length * frameSeconds);
  const runs: TimeRange[] = [];
  let from: number | null = null;
  const close = (endTime: number) => {
    if (from === null) return;
    const start = Math.max(from, SILENCE_EDGE_SECONDS);
    const end = Math.min(endTime, total - SILENCE_EDGE_SECONDS);
    if (end - start >= SILENCE_MIN_SECONDS) runs.push({ start: round3(start), end: round3(end) });
    from = null;
  };
  for (const [index, level] of frameDb.entries()) {
    if (level < SILENCE_DB) from ??= index * frameSeconds;
    else close(index * frameSeconds);
  }
  close(frameDb.length * frameSeconds);
  return runs;
}

function blackIssues(black: readonly TimeRange[], timeline: QaTimeline, duration: number) {
  const clips = timeline.snapshot.clips.filter(isVisual);
  return black.map((range): QaIssueDraft => {
    const length = range.end - range.start;
    const atHead = range.start <= FADE_EDGE_SECONDS;
    const atTail = duration > 0 && range.end >= duration - FADE_EDGE_SECONDS;
    const fade = length <= FADE_SECONDS && (atHead || atTail);
    const middle = (range.start + range.end) / 2;
    const covered = clips.some(
      (clip) => isContent(clip) && clip.start <= middle && middle < clip.end,
    );
    return {
      kind: "black_frames",
      severity: fade ? "info" : length >= BLACK_ERROR_SECONDS ? "error" : "warning",
      source: "render",
      check: "blackdetect",
      start: range.start,
      end: range.end,
      clipIds: clipIdsOverlapping(clips, range.start, range.end, 0.15),
      subject: null,
      message: fade
        ? `The picture fades ${atHead ? "in from" : "out to"} black for ${round3(length)} s at the ${atHead ? "start" : "end"}.`
        : `The picture is black for ${round3(length)} s (${round3(range.start)}–${round3(range.end)} s).`,
      fixable: !fade,
      owner: fade ? null : "editor",
      suggestion: fade
        ? null
        : covered
          ? "The clip playing here renders black: check its source and opacity."
          : "Nothing covers this stretch of the timeline: fill the gap with a clip or close it.",
    };
  });
}

/** Freezes that matter: where the picture is footage (a video clip is on top), not a still, text card or graphic. */
function frozenIssues(frozen: readonly TimeRange[], timeline: QaTimeline): QaIssueDraft[] {
  const clips = timeline.snapshot.clips;
  const issues: QaIssueDraft[] = [];
  for (const range of frozen) {
    const top: TimelineClip | null = topContentAt(clips, (range.start + range.end) / 2);
    if (!top || top.kind !== "video") continue;
    issues.push({
      kind: "frozen_frames",
      severity: "warning",
      source: "render",
      check: "freezedetect",
      start: range.start,
      end: range.end,
      clipIds: [clipName(top)],
      subject: clipName(top),
      message: `The picture of ${top.src ?? top.label} does not move for ${round3(range.end - range.start)} s (${round3(range.start)}–${round3(range.end)} s).`,
      fixable: true,
      owner: "editor",
      suggestion: "Check that the clip is not past the end of its media, or cut away from it.",
    });
  }
  return issues;
}

/**
 * Silence that no audible clip covers, between audible clips that come before and after it: the sound drops out
 * (a gap in the A-roll track, a cut that left the audio behind). Silence before the first or after the last audible
 * clip is not a hole, it is just the start or end of the sound.
 */
function audioHoleIssue(range: TimeRange, audible: readonly TimelineClip[]): QaIssueDraft | null {
  const middle = (range.start + range.end) / 2;
  const before = audible.filter((clip) => clip.end <= middle).sort((a, b) => b.end - a.end)[0];
  const after = audible.filter((clip) => clip.start >= middle).sort((a, b) => a.start - b.start)[0];
  if (!before || !after) return null;
  const music = before.kind === "audio" && after.kind === "audio";
  const name = (clip: TimelineClip) => clip.src ?? clip.label ?? clipName(clip);
  const length = round3(range.end - range.start);
  return {
    kind: "audio_gap",
    severity: "warning",
    source: "render",
    check: "render.audio_hole",
    start: range.start,
    end: range.end,
    clipIds: [clipName(before), clipName(after)],
    subject: `hole:${range.start.toFixed(1)}`,
    message: `The sound drops out for ${length} s (${round3(range.start)}–${round3(range.end)} s) between ${name(before)} and ${name(after)}: no audible clip covers it.`,
    fixable: true,
    owner: music ? "audio" : "editor",
    suggestion:
      "Close the gap (ripple the later clips) or fill it with a clip that has sound, such as room tone or music.",
  };
}

function silenceIssues(silences: readonly TimeRange[], timeline: QaTimeline): QaIssueDraft[] {
  const audible = timeline.snapshot.clips.filter((clip) => isAudible(timeline, clip));
  const issues: QaIssueDraft[] = [];
  for (const range of silences) {
    const middle = (range.start + range.end) / 2;
    const covering = audible.filter((clip) => clip.start <= middle && middle < clip.end);
    const main = covering.find((clip) => clip.kind === "audio") ?? covering[0];
    if (!main) {
      const hole = audioHoleIssue(range, audible);
      if (hole) issues.push(hole);
      continue;
    }
    const music = main.kind === "audio";
    issues.push({
      kind: "audio_gap",
      severity: "warning",
      source: "render",
      check: "audio.silence",
      start: range.start,
      end: range.end,
      clipIds: covering.map(clipName).slice(0, 32),
      subject: clipName(main),
      message: `The render is silent for ${round3(range.end - range.start)} s (${round3(range.start)}–${round3(range.end)} s) although ${music ? "audio" : "video"} clip ${main.src ?? main.label} should be audible.`,
      fixable: true,
      owner: music ? "audio" : "editor",
      suggestion: music
        ? "Check the clip's volume, in-point and fades, or whether its media has a gap."
        : "Check the clip is not muted and its source has sound here; otherwise trim the silence.",
    });
  }
  return issues;
}

/** The render carries no audio stream although the timeline has clips that should be heard. */
export function noAudioStreamIssue(timeline: QaTimeline, duration: number): QaIssueDraft | null {
  const audible = timeline.snapshot.clips.filter((clip) => isAudible(timeline, clip));
  if (audible.length === 0) return null;
  return {
    kind: "audio_gap",
    severity: "error",
    source: "render",
    check: "audio.no_stream",
    start: 0,
    end: duration,
    clipIds: audible.map(clipName).slice(0, 32),
    subject: "render:no_audio",
    message: `The render has no audio track, although ${audible.length} clip${audible.length === 1 ? "" : "s"} on the timeline should be audible.`,
    fixable: true,
    owner: "audio",
    suggestion:
      "Check the audible clips are not muted, have volume above 0 and a source with sound.",
  };
}

export { blackIssues, frozenIssues, silenceIssues };
