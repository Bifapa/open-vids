import {
  EDIT_LIMITS,
  type CaptionCue,
  type EditOperation,
  type EditOperationResult,
} from "@hyperframes/agent-protocol";
import { isAnalysisFailure } from "../analysis/errors.js";
import { EPS, fmt, loadModel, round3, type Batch, type EditEnv } from "./batch.js";
import { EditFailure } from "./errors.js";
import { applyCaptions } from "./opsCaptions.js";
import type { ClipNode } from "./timeline.js";

const DEFAULT_MAX_WORDS = 6;
const MAX_CUE_CHARS = 42;
/** A pause longer than this ends a cue. */
const CUE_GAP = 0.7;
const SENTENCE_END = /[.!?…]["')\]]*$/;

interface TimedWord {
  text: string;
  start: number;
  end: number;
}

/** Words become cues: a cue ends at a sentence end, a long pause, the word or character limit. */
export function wordsToCues(words: readonly TimedWord[], maxWords: number): CaptionCue[] {
  const cues: CaptionCue[] = [];
  let run: TimedWord[] = [];
  const flush = () => {
    const first = run[0];
    const last = run[run.length - 1];
    if (first && last) {
      const previous = cues[cues.length - 1];
      // Two cues must not start together; nudge instead of dropping words.
      const start =
        previous && first.start <= previous.start ? previous.start + 0.001 : first.start;
      cues.push({
        text: run.map((word) => word.text).join(" "),
        start: round3(start),
        end: round3(Math.max(last.end, start + 0.1)),
      });
    }
    run = [];
  };
  for (const word of words) {
    const last = run[run.length - 1];
    const text = run.map((entry) => entry.text).join(" ");
    if (
      last &&
      (word.start - last.end > CUE_GAP ||
        run.length >= maxWords ||
        text.length + word.text.length + 1 > MAX_CUE_CHARS)
    ) {
      flush();
    }
    run.push(word);
    if (SENTENCE_END.test(word.text)) flush();
  }
  flush();
  return cues;
}

/** Whether no clip processed earlier (a lower track) already speaks at this timeline time. */
function uncovered(covered: ReadonlyArray<[number, number]>, time: number): boolean {
  return !covered.some(([from, to]) => time >= from - EPS && time < to);
}

/**
 * Captions for the current timeline from the cached transcripts of its clips: each video/audio clip contributes the
 * words of the stretch of source it plays (in-point, length and speed applied); where clips overlap, the lower track
 * speaks. The cues are written with `apply_captions`, so the preset, track and replace-on-reapply rules are the same.
 */
export async function captionsFromTranscript(
  env: EditEnv,
  batch: Batch,
  op: Extract<EditOperation, { op: "captions_from_transcript" }>,
): Promise<EditOperationResult> {
  const { analysis } = env;
  if (!analysis) {
    throw new EditFailure(
      "unsupported",
      "This Studio has no analysis cache to take transcripts from",
    );
  }
  const model = await loadModel(env, batch.html);
  const refs = op.clips;
  const pool: ClipNode[] = refs
    ? refs.map((ref) => {
        const found = model.clips.find((clip) => clip.id === ref || clip.domId === ref);
        if (!found)
          throw new EditFailure("unknown_clip", `No clip "${ref}" in ${env.compositionPath}`);
        return found;
      })
    : model.clips;
  const candidates = pool
    .filter(
      (clip) =>
        (clip.kind === "video" || clip.kind === "audio") &&
        clip.src !== null &&
        !clip.element.hasAttribute("muted"),
    )
    .sort((a, b) => a.track - b.track || a.start - b.start);

  const covered: Array<[number, number]> = [];
  const words: TimedWord[] = [];
  const missing = new Set<string>();
  let used = 0;
  for (const clip of candidates) {
    const source = clip.src;
    if (source === null) continue;
    let transcript;
    try {
      transcript = (await analysis.sourceData(env.project, source)).transcript;
    } catch (error) {
      if (!isAnalysisFailure(error)) throw error;
      transcript = null;
    }
    if (!transcript) {
      missing.add(source);
      continue;
    }
    const from = clip.mediaStart ?? 0;
    const to = from + clip.duration * clip.playbackRate;
    const onTimeline = (sourceTime: number) =>
      clip.start + (Math.min(Math.max(sourceTime, from), to) - from) / clip.playbackRate;
    const before = words.length;
    for (const word of transcript.words) {
      const middle = (word.start + word.end) / 2;
      if (middle < from || middle >= to) continue;
      if (!uncovered(covered, onTimeline(middle))) continue;
      words.push({ text: word.text, start: onTimeline(word.start), end: onTimeline(word.end) });
    }
    covered.push([clip.start, clip.end]);
    if (words.length > before) used += 1;
  }
  if (words.length === 0) {
    throw new EditFailure(
      "unsupported",
      missing.size > 0
        ? `No cached transcript for ${[...missing].join(", ")}; run analyze_media on the source first`
        : "The clips on this timeline play no transcribed speech",
    );
  }
  words.sort((a, b) => a.start - b.start);
  const cues = wordsToCues(words, op.maxWords ?? DEFAULT_MAX_WORDS);
  if (cues.length > EDIT_LIMITS.transcriptCaptionCues) {
    throw new EditFailure(
      "out_of_bounds",
      `${cues.length} cues exceed the limit of ${EDIT_LIMITS.transcriptCaptionCues}; pass clips to caption fewer of them`,
    );
  }
  // Audio-only sources are usually music; only a video without a transcript is worth a warning.
  const unspoken = candidates.filter(
    (clip) => clip.kind === "video" && clip.src !== null && missing.has(clip.src),
  );
  if (unspoken.length > 0) {
    const sources = [...new Set(unspoken.map((clip) => clip.src))].join(", ");
    batch.warnings.push(
      `No cached transcript for ${sources}: those clips are not captioned (analyze_media first).`,
    );
  }
  const written = await applyCaptions(env, batch, {
    op: "apply_captions",
    preset: op.preset,
    cues,
    ...(op.track !== undefined && { track: op.track }),
  });
  return {
    ...written,
    op: op.op,
    note: `${cues.length} cues from ${used} ${used === 1 ? "clip" : "clips"}, ${fmt(cues[0]?.start ?? 0)}–${fmt(cues[cues.length - 1]?.end ?? 0)} s`,
  };
}
