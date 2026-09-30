import type { TimeRange } from "@hyperframes/agent-protocol";

/**
 * Adaptive silence detection over per-frame loudness. Pure: no process, no file. Recordings have noise floors anywhere
 * from -75 to -35 dBFS, so no fixed threshold fits them all; the threshold is derived from the recording's own floor and
 * speech level instead.
 */

/** PCM the meter expects: mono signed 16-bit little-endian. */
export const LEVEL_SAMPLE_RATE = 8000;
export const LEVEL_FRAME_SECONDS = 0.05;
export const MIN_SILENCE_SECONDS = 0.35;

/** What a frame of digital silence reads as (log of zero would be -Infinity). */
export const DB_FLOOR = -100;
/** The threshold sits this share of the floor-to-speech spread above the floor, within the margin bounds. */
const MARGIN_SHARE = 0.3;
const MIN_MARGIN_DB = 6;
const MAX_MARGIN_DB = 15;
const MIN_THRESHOLD_DB = -70;
const MAX_THRESHOLD_DB = -25;
/** Below this floor-to-speech spread the recording has no quiet-vs-loud contrast to adapt to. */
const MIN_CONTRAST_DB = 6;
/** With no contrast, a recording is silence only when it is quieter than this. */
const UNIFORM_SILENCE_DB = -50;
const FLOOR_PERCENTILE = 0.1;
const SPEECH_PERCENTILE = 0.9;
/** A run of silence survives this many consecutive louder frames (a click, a breath) and stays one silence. */
const DEFAULT_BRIDGE_FRAMES = 2;

export interface SilenceOptions {
  /** Shortest silence kept, seconds. */
  minSilence?: number;
  /** Louder frames (at most) that do not end a silence. */
  bridgeFrames?: number;
}

export interface SilenceDetection {
  thresholdDb: number;
  silences: TimeRange[];
}

const round3 = (value: number): number => Math.round(value * 1000) / 1000;

const clamp = (value: number, low: number, high: number): number =>
  Math.min(high, Math.max(low, value));

/** Nearest-rank percentile (`share` in 0–1) of unsorted values; `DB_FLOOR` for none. */
export function percentile(values: ArrayLike<number>, share: number): number {
  if (values.length === 0) return DB_FLOOR;
  const sorted = Float32Array.from(values).sort();
  return sorted[Math.round(clamp(share, 0, 1) * (sorted.length - 1))] ?? DB_FLOOR;
}

/** The level (dBFS) below which frames count as silence, from the recording's own noise floor and speech level. */
export function silenceThreshold(frameDb: ArrayLike<number>): number {
  const floor = percentile(frameDb, FLOOR_PERCENTILE);
  const speech = percentile(frameDb, SPEECH_PERCENTILE);
  const spread = speech - floor;
  if (spread < MIN_CONTRAST_DB) return UNIFORM_SILENCE_DB;
  const margin = clamp(spread * MARGIN_SHARE, MIN_MARGIN_DB, MAX_MARGIN_DB);
  return Math.round(clamp(floor + margin, MIN_THRESHOLD_DB, MAX_THRESHOLD_DB) * 10) / 10;
}

/**
 * Silences of a recording given the RMS level (dBFS) of each consecutive frame of `frameSeconds`: runs of frames below
 * the adaptive threshold that last at least `minSilence`. A run interrupted by no more than `bridgeFrames` louder frames
 * stays one silence; a silence never starts or ends on such a spike.
 */
export function detectSilences(
  frameDb: ArrayLike<number>,
  frameSeconds: number,
  options: SilenceOptions = {},
): SilenceDetection {
  const minSilence = options.minSilence ?? MIN_SILENCE_SECONDS;
  const bridge = options.bridgeFrames ?? DEFAULT_BRIDGE_FRAMES;
  const thresholdDb = silenceThreshold(frameDb);
  const silences: TimeRange[] = [];
  const count = frameDb.length;
  const quiet = (index: number): boolean => (frameDb[index] ?? 0) < thresholdDb;

  let index = 0;
  while (index < count) {
    if (!quiet(index)) {
      index++;
      continue;
    }
    const first = index;
    let last = index;
    let cursor = index + 1;
    while (cursor < count) {
      if (quiet(cursor)) {
        last = cursor++;
        continue;
      }
      let loud = 0;
      while (cursor + loud < count && !quiet(cursor + loud)) loud++;
      const resumes = cursor + loud < count;
      if (!resumes || loud > bridge) break;
      cursor += loud;
    }
    const start = first * frameSeconds;
    const end = (last + 1) * frameSeconds;
    if (end - start >= minSilence - 1e-9) silences.push({ start: round3(start), end: round3(end) });
    index = last + 1;
  }
  return { thresholdDb, silences };
}

/**
 * Turns a stream of mono s16le PCM into RMS levels per frame. Chunks may end anywhere, even between the two bytes of a
 * sample; a final partial frame counts when it holds at least half a frame.
 */
export class FrameMeter {
  readonly frameDb: number[] = [];
  private readonly frameSamples: number;
  private sumSquares = 0;
  private inFrame = 0;
  private carry: number | null = null;
  private samples = 0;

  constructor(sampleRate: number = LEVEL_SAMPLE_RATE, frameSeconds: number = LEVEL_FRAME_SECONDS) {
    this.frameSamples = Math.max(1, Math.round(sampleRate * frameSeconds));
  }

  /** Samples consumed so far. */
  get sampleCount(): number {
    return this.samples;
  }

  push(chunk: Uint8Array): void {
    let offset = 0;
    if (this.carry !== null && chunk.length > 0) {
      this.addSample(this.carry, chunk[0] ?? 0);
      this.carry = null;
      offset = 1;
    }
    for (; offset + 1 < chunk.length; offset += 2) {
      this.addSample(chunk[offset] ?? 0, chunk[offset + 1] ?? 0);
    }
    if (offset < chunk.length) this.carry = chunk[offset] ?? null;
  }

  /** Flushes the partial last frame and returns every frame level. */
  finish(): number[] {
    if (this.inFrame * 2 >= this.frameSamples) this.emit();
    this.sumSquares = 0;
    this.inFrame = 0;
    return this.frameDb;
  }

  private addSample(low: number, high: number): void {
    const raw = (high << 8) | low;
    const value = (raw >= 0x8000 ? raw - 0x10000 : raw) / 32768;
    this.sumSquares += value * value;
    this.samples++;
    if (++this.inFrame === this.frameSamples) this.emit();
  }

  private emit(): void {
    const meanSquare = this.sumSquares / this.inFrame;
    this.frameDb.push(meanSquare > 0 ? Math.max(DB_FLOOR, 10 * Math.log10(meanSquare)) : DB_FLOOR);
    this.sumSquares = 0;
    this.inFrame = 0;
  }
}
