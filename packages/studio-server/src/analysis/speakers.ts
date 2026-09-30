import type { SpeakerInfo, SpeakerMap, SpeakerTurn } from "@hyperframes/agent-protocol";
import type { SpeakerDiarization } from "../types.js";

/** Same-speaker turns closer than this are one turn. */
const MERGE_GAP_SECONDS = 0.5;
/** Turns shorter than this are diarization noise. */
const MIN_TURN_SECONDS = 0.3;
/** A voice with less than this share of the speech AND less than MICRO_SPEAKER_SECONDS in total is diarization noise. */
const MICRO_SPEAKER_SHARE = 0.03;
const MICRO_SPEAKER_SECONDS = 15;

const round3 = (value: number): number => Math.round(value * 1000) / 1000;

interface RawTurn {
  speaker: number;
  start: number;
  end: number;
}

/** Merges consecutive turns of the same voice whose gap is under the merge gap (input sorted by start). */
function mergeAdjacent(turns: readonly RawTurn[]): RawTurn[] {
  const merged: RawTurn[] = [];
  for (const turn of turns) {
    const previous = merged[merged.length - 1];
    if (
      previous &&
      previous.speaker === turn.speaker &&
      turn.start - previous.end < MERGE_GAP_SECONDS
    )
      previous.end = Math.max(previous.end, turn.end);
    else merged.push({ ...turn });
  }
  return merged;
}

/**
 * Hands the turns of noise voices (under 3 % of the speech and under 15 s in total) to the neighbouring turn whose
 * voice is real, the one it touches most closely (the earlier one on a tie), then merges what became adjacent.
 */
function absorbMicroSpeakers(turns: readonly RawTurn[]): RawTurn[] {
  const seconds = new Map<number, number>();
  let total = 0;
  for (const turn of turns) {
    seconds.set(turn.speaker, (seconds.get(turn.speaker) ?? 0) + turn.end - turn.start);
    total += turn.end - turn.start;
  }
  const isMicro = (speaker: number): boolean => {
    const voice = seconds.get(speaker) ?? 0;
    return voice < MICRO_SPEAKER_SHARE * total && voice < MICRO_SPEAKER_SECONDS;
  };
  const real = turns.filter((turn) => !isMicro(turn.speaker));
  if (real.length === 0 || real.length === turns.length) return [...turns];

  const reassigned = turns.map((turn, index) => {
    if (!isMicro(turn.speaker)) return turn;
    let before: RawTurn | undefined;
    for (let k = index - 1; k >= 0 && !before; k--) {
      const candidate = turns[k];
      if (candidate && !isMicro(candidate.speaker)) before = candidate;
    }
    let after: RawTurn | undefined;
    for (let k = index + 1; k < turns.length && !after; k++) {
      const candidate = turns[k];
      if (candidate && !isMicro(candidate.speaker)) after = candidate;
    }
    const gapBefore = before ? Math.max(0, turn.start - before.end) : Infinity;
    const gapAfter = after ? Math.max(0, after.start - turn.end) : Infinity;
    const neighbour = gapAfter < gapBefore ? after : before;
    return { ...turn, speaker: neighbour?.speaker ?? turn.speaker };
  });
  return mergeAdjacent(reassigned);
}

function singleSpeaker(
  source: string,
  duration: number,
  words: readonly { start: number; end: number }[] | undefined,
  note: string,
): SpeakerMap {
  const turns: SpeakerTurn[] = [];
  let seconds = 0;
  if (words && words.length > 0) {
    for (const word of [...words].sort((a, b) => a.start - b.start)) {
      seconds += word.end - word.start;
      const previous = turns[turns.length - 1];
      if (previous && word.start - previous.end < MERGE_GAP_SECONDS)
        previous.end = round3(Math.max(previous.end, word.end));
      else turns.push({ speaker: "S1", start: round3(word.start), end: round3(word.end) });
    }
  } else if (duration > 0) {
    turns.push({ speaker: "S1", start: 0, end: round3(duration) });
    seconds = duration;
  }
  return {
    source,
    method: "single",
    speakers: [{ id: "S1", label: null, seconds: round3(seconds), share: 1 }],
    turns,
    note,
  };
}

/**
 * Speaker map from diarization turns. Voices get ids `S1…` by first appearance; adjacent turns of one voice (gap under
 * 0.5 s) merge, turns under 0.3 s are dropped and noise voices (under 3 % share and 15 s) join the neighbouring turn's
 * voice, before the ids are assigned. Without diarization, or when it finds only one voice, the map is a
 * single speaker `S1` covering the speech (the words when given, else the whole media).
 */
export function buildSpeakerMap(
  source: string,
  diarization: SpeakerDiarization | null,
  note: string | null,
  duration: number,
  words?: readonly { start: number; end: number }[],
): SpeakerMap {
  if (!diarization) {
    return singleSpeaker(
      source,
      duration,
      words,
      note ?? "Speaker diarization was not available; one speaker is assumed.",
    );
  }
  const limit = duration > 0 ? duration : Infinity;
  const raw: RawTurn[] = diarization.turns
    .filter((turn) => Number.isFinite(turn.start) && Number.isFinite(turn.end))
    .map((turn) => ({
      speaker: turn.speaker,
      start: Math.max(0, turn.start),
      end: Math.min(turn.end, limit),
    }))
    .filter((turn) => turn.end > turn.start)
    .sort((a, b) => a.start - b.start || a.end - b.end || a.speaker - b.speaker);
  // Dropping a blip can leave two turns of one voice next to each other, so merge again afterwards.
  const cleaned = absorbMicroSpeakers(
    mergeAdjacent(mergeAdjacent(raw).filter((turn) => turn.end - turn.start >= MIN_TURN_SECONDS)),
  );

  const ids = new Map<number, string>();
  for (const turn of cleaned) if (!ids.has(turn.speaker)) ids.set(turn.speaker, `S${ids.size + 1}`);
  if (ids.size < 2) {
    return singleSpeaker(
      source,
      duration,
      words,
      note ??
        (ids.size === 0
          ? "Diarization found no speech turns; one speaker is assumed."
          : "Diarization found a single voice."),
    );
  }

  const turns: SpeakerTurn[] = cleaned.map((turn) => ({
    speaker: ids.get(turn.speaker) ?? "S1",
    start: round3(turn.start),
    end: round3(turn.end),
  }));
  let total = 0;
  const seconds = new Map<string, number>();
  for (const turn of turns) {
    const length = turn.end - turn.start;
    total += length;
    seconds.set(turn.speaker, (seconds.get(turn.speaker) ?? 0) + length);
  }
  const speakers: SpeakerInfo[] = [...ids.values()].map((id) => ({
    id,
    label: null,
    seconds: round3(seconds.get(id) ?? 0),
    share: total > 0 ? round3((seconds.get(id) ?? 0) / total) : 0,
  }));
  return { source, method: "diarization", speakers, turns, note: null };
}
