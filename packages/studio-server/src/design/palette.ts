import { spawn } from "node:child_process";
import { findFfBinary } from "@hyperframes/parsers/ff-binaries";
import { DesignFailure } from "./errors.js";

/** Sampled frames are scaled to this fixed size (colours do not need more; the byte size of a frame is then known). */
const FRAME_WIDTH = 64;
const FRAME_HEIGHT = 36;
const FRAME_BYTES = FRAME_WIDTH * FRAME_HEIGHT * 3;

const BIN_BITS = 5;
const BIN_SHIFT = 8 - BIN_BITS;
const BIN_COUNT = 1 << (BIN_BITS * 3);
/** Boxes median cut produces before near-duplicates are merged. */
const CUT_BOXES = 24;
/** CIE76 distance below which two colours count as the same. */
const MERGE_DELTA_E = 10;
/** A colour under this share of the pixels is noise, not a dominant colour. */
const MIN_SHARE = 0.005;
export const DEFAULT_PALETTE_COLORS = 12;
const ERROR_TAIL_CHARS = 600;

export interface PaletteColor {
  /** `#rrggbb`, lowercase. */
  value: string;
  /** Share of the sampled pixels, 0–1 (four decimals). */
  share: number;
}

interface Bin {
  index: number;
  count: number;
  r: number;
  g: number;
  b: number;
}

interface Box {
  bins: Bin[];
  count: number;
}

function toLab(r: number, g: number, b: number): [number, number, number] {
  const linear = (value: number) => {
    const v = value / 255;
    return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  const lr = linear(r);
  const lg = linear(g);
  const lb = linear(b);
  const f = (t: number) => (t > 216 / 24389 ? Math.cbrt(t) : ((24389 / 27) * t + 16) / 116);
  const x = f((0.4124564 * lr + 0.3575761 * lg + 0.1804375 * lb) / 0.95047);
  const y = f(0.2126729 * lr + 0.7151522 * lg + 0.072175 * lb);
  const z = f((0.0193339 * lr + 0.119192 * lg + 0.9503041 * lb) / 1.08883);
  return [116 * y - 16, 500 * (x - y), 200 * (y - z)];
}

function hex(r: number, g: number, b: number): string {
  return `#${[r, g, b].map((v) => v.toString(16).padStart(2, "0")).join("")}`;
}

function histogram(rgb: Uint8Array): Bin[] {
  const counts = new Uint32Array(BIN_COUNT);
  const sums = new Float64Array(BIN_COUNT * 3);
  const pixels = Math.floor(rgb.length / 3);
  for (let p = 0; p < pixels; p++) {
    const r = rgb[p * 3] ?? 0;
    const g = rgb[p * 3 + 1] ?? 0;
    const b = rgb[p * 3 + 2] ?? 0;
    const index =
      ((r >> BIN_SHIFT) << (BIN_BITS * 2)) | ((g >> BIN_SHIFT) << BIN_BITS) | (b >> BIN_SHIFT);
    counts[index] = (counts[index] ?? 0) + 1;
    sums[index * 3] = (sums[index * 3] ?? 0) + r;
    sums[index * 3 + 1] = (sums[index * 3 + 1] ?? 0) + g;
    sums[index * 3 + 2] = (sums[index * 3 + 2] ?? 0) + b;
  }
  const bins: Bin[] = [];
  for (let index = 0; index < BIN_COUNT; index++) {
    const count = counts[index] ?? 0;
    if (count === 0) continue;
    bins.push({
      index,
      count,
      r: (sums[index * 3] ?? 0) / count,
      g: (sums[index * 3 + 1] ?? 0) / count,
      b: (sums[index * 3 + 2] ?? 0) / count,
    });
  }
  return bins;
}

type Channel = "r" | "g" | "b";
const CHANNELS: readonly Channel[] = ["r", "g", "b"];

/** Splits a box at the population median along its widest channel (ties: r, then g, then b). */
function split(box: Box): [Box, Box] {
  let widest: Channel = "r";
  let widestRange = -1;
  for (const channel of CHANNELS) {
    const values = box.bins.map((bin) => bin[channel]);
    const range = Math.max(...values) - Math.min(...values);
    if (range > widestRange) {
      widest = channel;
      widestRange = range;
    }
  }
  const order = [widest, ...CHANNELS.filter((channel) => channel !== widest)];
  const sorted = [...box.bins].sort((a, b) => {
    for (const channel of order) {
      const difference = a[channel] - b[channel];
      if (difference !== 0) return difference;
    }
    return a.index - b.index;
  });
  let seen = 0;
  let cut = sorted.length - 1;
  for (let i = 0; i < sorted.length - 1; i++) {
    seen += sorted[i]?.count ?? 0;
    if (seen * 2 >= box.count) {
      cut = i + 1;
      break;
    }
  }
  const make = (bins: Bin[]): Box => ({
    bins,
    count: bins.reduce((sum, bin) => sum + bin.count, 0),
  });
  return [make(sorted.slice(0, cut)), make(sorted.slice(cut))];
}

interface Swatch {
  r: number;
  g: number;
  b: number;
  count: number;
}

function swatchOf(box: Box): Swatch {
  let r = 0;
  let g = 0;
  let b = 0;
  for (const bin of box.bins) {
    r += bin.r * bin.count;
    g += bin.g * bin.count;
    b += bin.b * bin.count;
  }
  return { r: r / box.count, g: g / box.count, b: b / box.count, count: box.count };
}

function distance(a: Swatch, b: Swatch): number {
  const [l1, a1, b1] = toLab(a.r, a.g, a.b);
  const [l2, a2, b2] = toLab(b.r, b.g, b.b);
  return Math.hypot(l1 - l2, a1 - a2, b1 - b2);
}

/**
 * The dominant colours of `rgb` (packed rgb24 pixels): a 5-bit-per-channel histogram, median cut into 24 boxes, boxes
 * closer than ΔE 10 merged (most frequent first, weighted mean), at most `maxColors` returned most frequent first.
 * Fixed algorithm and tie-breaks: the same pixels always give the same palette.
 */
export function quantizePalette(
  rgb: Uint8Array,
  maxColors: number = DEFAULT_PALETTE_COLORS,
): PaletteColor[] {
  const bins = histogram(rgb);
  const total = bins.reduce((sum, bin) => sum + bin.count, 0);
  if (total === 0) return [];
  const boxes: Box[] = [{ bins, count: total }];
  while (boxes.length < CUT_BOXES) {
    let pick = -1;
    for (const [index, box] of boxes.entries()) {
      if (box.bins.length > 1 && (pick === -1 || box.count > (boxes[pick]?.count ?? 0)))
        pick = index;
    }
    const target = boxes[pick];
    if (!target) break;
    boxes.splice(pick, 1, ...split(target));
  }
  const swatches = boxes
    .map(swatchOf)
    .sort((a, b) => b.count - a.count || a.r - b.r || a.g - b.g || a.b - b.b);
  const merged: Swatch[] = [];
  for (const swatch of swatches) {
    const near = merged.find((kept) => distance(kept, swatch) < MERGE_DELTA_E);
    if (!near) {
      merged.push({ ...swatch });
      continue;
    }
    const count = near.count + swatch.count;
    near.r = (near.r * near.count + swatch.r * swatch.count) / count;
    near.g = (near.g * near.count + swatch.g * swatch.count) / count;
    near.b = (near.b * near.count + swatch.b * swatch.count) / count;
    near.count = count;
  }
  return merged
    .map((swatch) => ({
      value: hex(Math.round(swatch.r), Math.round(swatch.g), Math.round(swatch.b)),
      count: swatch.count,
    }))
    .sort((a, b) => b.count - a.count || (a.value < b.value ? -1 : 1))
    .filter((color) => color.count / total >= MIN_SHARE)
    .slice(0, maxColors)
    .map((color) => ({
      value: color.value,
      share: Math.round((color.count / total) * 10000) / 10000,
    }));
}

export interface VideoPaletteOptions {
  /** Frames to sample, evenly across the video. */
  frames: number;
  /** Probed duration; null when unknown (then the first `frames` seconds are sampled, one frame per second). */
  durationSec: number | null;
  maxColors?: number;
  signal?: AbortSignal;
  /** Overrides the binary lookup (tests, configured installs). */
  ffmpegPath?: string;
}

function decodeFrames(videoPath: string, options: VideoPaletteOptions): Promise<Buffer> {
  const binary = options.ffmpegPath ?? findFfBinary("ffmpeg");
  if (!binary) {
    return Promise.reject(new DesignFailure("unavailable", "ffmpeg is not installed"));
  }
  const { frames, durationSec, signal } = options;
  const spacing = durationSec !== null && durationSec > 0 ? durationSec / frames : 1;
  const args = [
    "-nostdin",
    "-nostats",
    "-hide_banner",
    "-loglevel",
    "error",
    // Middle of each of the `frames` equal slices of the file.
    "-ss",
    String(spacing / 2),
    "-i",
    videoPath,
    "-an",
    "-sn",
    "-vf",
    `fps=${(1 / spacing).toFixed(6)},scale=${FRAME_WIDTH}:${FRAME_HEIGHT}:flags=area`,
    "-frames:v",
    String(frames),
    "-f",
    "rawvideo",
    "-pix_fmt",
    "rgb24",
    "pipe:1",
  ];
  return new Promise<Buffer>((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DesignFailure("unavailable", "The palette read was cancelled"));
      return;
    }
    const child = spawn(binary, args, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    const chunks: Buffer[] = [];
    let stderr = "";
    const onAbort = () => {
      child.kill("SIGKILL");
      reject(new DesignFailure("unavailable", "The palette read was cancelled"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    child.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => {
      stderr = (stderr + chunk.toString()).slice(-ERROR_TAIL_CHARS * 4);
    });
    child.on("error", (error: NodeJS.ErrnoException) => {
      signal?.removeEventListener("abort", onAbort);
      const missing = error.code === "ENOENT";
      reject(
        new DesignFailure(
          missing ? "unavailable" : "asset_unavailable",
          `ffmpeg could not start: ${error.message}`,
        ),
      );
    });
    child.on("close", (code) => {
      signal?.removeEventListener("abort", onAbort);
      if (code === 0) resolve(Buffer.concat(chunks));
      else {
        const tail = stderr.trim().slice(-ERROR_TAIL_CHARS);
        reject(new DesignFailure("asset_unavailable", `ffmpeg exited with code ${code}: ${tail}`));
      }
    });
  });
}

/**
 * The exact dominant colours of a video from decoded pixels: `frames` frames sampled evenly (ffmpeg → 64×36 rgb24),
 * then {@link quantizePalette}. No model; the same file and options give the same answer.
 */
export async function extractVideoPalette(
  videoAbsPath: string,
  options: VideoPaletteOptions,
): Promise<{ colors: PaletteColor[]; frames: number }> {
  const raw = await decodeFrames(videoAbsPath, options);
  const frames = Math.floor(raw.length / FRAME_BYTES);
  if (frames === 0) {
    throw new DesignFailure("asset_unavailable", "No video frames could be decoded from this file");
  }
  const pixels = new Uint8Array(raw.buffer, raw.byteOffset, frames * FRAME_BYTES);
  return { colors: quantizePalette(pixels, options.maxColors), frames };
}
