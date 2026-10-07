import { existsSync, statSync } from "node:fs";
import {
  EDIT_LIMITS,
  VOICE_LINE_ATTRIBUTE,
  captionCuesFromWords,
  type CaptionCue,
  type EditOperation,
  type EditOperationResult,
  type VoiceLine,
  type VoiceScript,
  type VoiceTake,
} from "@hyperframes/agent-protocol";
import { resolveWithinProject } from "../helpers/safePath.js";
import type { TimedWord } from "../voice/project/align.js";
import { alignSourceWords, takeCaptionWords } from "../voice/project/captionWords.js";
import { readScript, updateScript } from "../voice/project/takesStore.js";
import { EPS, fmt, loadModel, round3, type Batch, type EditEnv } from "./batch.js";
import { listCaptionPresets } from "./captions.js";
import { EditFailure } from "./errors.js";
import { applyCaptions } from "./opsCaptions.js";
import { SENTENCE_END } from "./opsTranscript.js";
import type { ClipNode } from "./timeline.js";

const MAX_WORDS = 6;
/** How far before a take's start or past its end a clip's in-point may sit and still belong to the take. */
const TAKE_SLACK = 0.05;

/**
 * The take a clip plays: of the line's takes in the clip's file, the one holding the clip's in-point (the line's
 * selected take when several do), else the selected one.
 */
function takePlayed(line: VoiceLine, clip: ClipNode): VoiceTake | null {
  const inFile = line.takes.filter((take) => take.file === clip.src);
  const at = clip.mediaStart ?? 0;
  const holding = inFile.filter(
    (take) => at >= take.start - TAKE_SLACK && at < take.end + TAKE_SLACK,
  );
  const pool = holding.length > 0 ? holding : inFile;
  return pool.find((take) => take.id === line.selectedTakeId) ?? pool[0] ?? null;
}

/** The recognised words inside the take's range, relative to its start. */
function wordsOfTake(words: readonly TimedWord[], take: VoiceTake): TimedWord[] {
  return words
    .filter((word) => {
      const middle = (word.start + word.end) / 2;
      return middle >= take.start - EPS && middle < take.end + EPS;
    })
    .map((word) => ({
      text: word.text,
      start: round3(Math.max(0, word.start - take.start)),
      end: round3(Math.max(0, word.end - take.start)),
    }));
}

/** Recognised words of recently transcribed voiceover files: Studio's dry run and the real apply share one recognition. */
const RECOGNISED_KEPT = 8;
const recognised = new Map<string, TimedWord[]>();

/** The recognizer's words for the file, from the recent ones when the file and language are unchanged. */
async function heardWords(
  env: EditEnv,
  script: VoiceScript,
  take: VoiceTake,
): Promise<TimedWord[]> {
  const transcribe = env.adapter.transcribeMedia;
  if (!transcribe) {
    throw new EditFailure(
      "unsupported",
      "This Studio has no speech recognition to time the voiceover words: generate the voiceover again so its words are recorded",
    );
  }
  const file = resolveWithinProject(env.project.dir, take.file);
  if (!file || !existsSync(file)) {
    throw new EditFailure("unknown_asset", `The voiceover file ${take.file} is missing`);
  }
  const language = script.language?.split("-")[0];
  const { size, mtimeMs } = statSync(file);
  const key = `${file}\0${size}\0${mtimeMs}\0${language ?? ""}`;
  const known = recognised.get(key);
  if (known) return known;
  let answer;
  try {
    answer = await transcribe({
      inputPath: file,
      ...(language && { language }),
      signal: env.signal ?? new AbortController().signal,
    });
  } catch (error) {
    if (env.signal?.aborted) throw error;
    const message = error instanceof Error ? error.message : String(error);
    throw new EditFailure("unsupported", `Speech recognition failed on ${take.file}: ${message}`);
  }
  if ("unavailable" in answer) {
    throw new EditFailure(
      "unsupported",
      `Speech recognition is unavailable (${answer.unavailable}): the captions need the voiceover's word timings`,
    );
  }
  recognised.set(key, answer.words);
  for (const [oldKey] of recognised) {
    if (recognised.size <= RECOGNISED_KEPT) break;
    recognised.delete(oldKey);
  }
  return answer.words;
}

/**
 * Words of a take that has none: the file is recognised once per batch. Nothing is written here — a dry run and a
 * refused batch must leave the project as it was. The words every take of that file lacks are stored in `takes.json`
 * after the batch committed (`Batch.afterCommit`), so the next captions need no recognition. Null when the file holds
 * no speech in the take's range.
 */
async function recogniseTake(
  env: EditEnv,
  batch: Batch,
  script: VoiceScript,
  take: VoiceTake,
  heardByFile: Map<string, TimedWord[]>,
): Promise<TimedWord[] | null> {
  let heard = heardByFile.get(take.file);
  if (!heard) {
    heard = await heardWords(env, script, take);
    heardByFile.set(take.file, heard);
    const found = heard;
    batch.afterCommit.push(async () => {
      await updateScript(env.project.dir, (current) => ({
        ...current,
        lines: current.lines.map((line) => ({
          ...line,
          takes: line.takes.map((entry) => {
            if (entry.file !== take.file || entry.words) return entry;
            const words = wordsOfTake(found, entry);
            return words.length > 0 ? { ...entry, words } : entry;
          }),
        })),
      }));
    });
  }
  const words = wordsOfTake(heard, take);
  return words.length > 0 ? words : null;
}

/**
 * Captions from the voiceover on the timeline: each clip that speaks a voice line (`data-ov-voice-line`) shows the
 * line's own text, timed by the recognised words of the take the clip plays. The words go through the clip's
 * in-point, length and speed, the cues of all clips are merged, and one `apply_captions` writes them, so the preset,
 * track and replace-on-reapply rules are the same.
 */
export async function captionsFromVoiceover(
  env: EditEnv,
  batch: Batch,
  op: Extract<EditOperation, { op: "captions_from_voiceover" }>,
): Promise<EditOperationResult> {
  const skinsDir = env.adapter.captionSkinsDir?.() ?? null;
  if (!skinsDir) {
    throw new EditFailure("unsupported", "The caption presets are not installed with this Studio");
  }
  const preset = op.preset ?? listCaptionPresets(skinsDir)[0]?.name;
  if (!preset) throw new EditFailure("unsupported", "No caption preset is installed");

  const model = await loadModel(env, batch.html);
  const wanted = op.lines ? new Set(op.lines) : null;
  const spoken = model.clips
    .flatMap((clip) => {
      const lineId = clip.element.getAttribute(VOICE_LINE_ATTRIBUTE);
      return lineId && clip.src !== null && (!wanted || wanted.has(lineId))
        ? [{ clip, lineId }]
        : [];
    })
    .sort((a, b) => a.clip.start - b.clip.start || a.clip.track - b.clip.track);
  for (const id of wanted ?? []) {
    if (!spoken.some((entry) => entry.lineId === id)) {
      throw new EditFailure(
        "unknown_clip",
        `No clip on ${env.compositionPath} speaks voice line "${id}"`,
      );
    }
  }
  if (spoken.length === 0) {
    throw new EditFailure(
      "unsupported",
      "No clip on this timeline speaks a voiceover line: place the narration with add_clip voiceLine first",
    );
  }

  const script = readScript(env.project.dir);
  const heardByFile = new Map<string, TimedWord[]>();
  const cues: CaptionCue[] = [];
  const captioned = new Set<string>();
  for (const { clip, lineId } of spoken) {
    const line = script.lines.find((entry) => entry.id === lineId);
    if (!line) {
      batch.warnings.push(
        `Clip ${clip.id} speaks voice line "${lineId}", which the voiceover script no longer has: not captioned.`,
      );
      continue;
    }
    const take = takePlayed(line, clip);
    if (!take) {
      batch.warnings.push(
        `Clip ${clip.id} plays ${clip.src}, which is no take of voice line "${lineId}": not captioned.`,
      );
      continue;
    }
    let words = takeCaptionWords(line, take);
    if (!words) {
      const heard = await recogniseTake(env, batch, script, take, heardByFile);
      words = heard ? alignSourceWords(line.text, heard) : null;
    }
    if (!words || words.length === 0) {
      batch.warnings.push(`Voice line "${lineId}" has no recognised speech: not captioned.`);
      continue;
    }
    // Word times are relative to the take; the clip plays the file from its in-point at its speed. Scaling the
    // words around the in-point to timeline seconds lets the shared cue builder (which assumes speed 1) place them.
    const from = clip.mediaStart ?? 0;
    const rate = clip.playbackRate;
    const scaled = words.map((word) => ({
      text: word.text,
      start: from + (take.start + word.start - from) / rate,
      end: from + (take.start + word.end - from) / rate,
    }));
    const sentenceEnds = new Set(
      scaled.flatMap((word, index) => (SENTENCE_END.test(word.text) ? [index] : [])),
    );
    const made = captionCuesFromWords(
      scaled,
      [{ from, to: from + clip.duration, at: clip.start }],
      { maxWords: MAX_WORDS, sentenceEnds },
    );
    if (made.length > 0) captioned.add(lineId);
    cues.push(...made);
  }
  if (cues.length === 0) {
    throw new EditFailure(
      "unsupported",
      "The voiceover clips on this timeline play no recognised speech to caption",
    );
  }
  cues.sort((a, b) => a.start - b.start);
  // Two cues must not start together (clips that overlap in time): nudge instead of dropping words.
  for (const [index, cue] of cues.entries()) {
    const previous = cues[index - 1];
    if (previous && cue.start <= previous.start) cue.start = round3(previous.start + 0.001);
  }
  if (cues.length > EDIT_LIMITS.transcriptCaptionCues) {
    throw new EditFailure(
      "out_of_bounds",
      `${cues.length} cues exceed the limit of ${EDIT_LIMITS.transcriptCaptionCues}; pass lines to caption fewer of them`,
    );
  }
  const written = await applyCaptions(env, batch, {
    op: "apply_captions",
    preset,
    cues,
    ...(op.track !== undefined && { track: op.track }),
  });
  return {
    ...written,
    op: op.op,
    note: `${cues.length} cues from ${captioned.size} voice ${captioned.size === 1 ? "line" : "lines"}, ${fmt(cues[0]?.start ?? 0)}–${fmt(cues[cues.length - 1]?.end ?? 0)} s`,
  };
}
