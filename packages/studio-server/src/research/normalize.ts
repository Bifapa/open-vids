import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { findFfBinary } from "@hyperframes/parsers/ff-binaries";
import sharp from "sharp";
import { isRecord, type ResearchMediaKind } from "@hyperframes/agent-protocol";
import { isAnalysisFailure } from "../analysis/errors.js";
import { runFfmpeg } from "../analysis/ffmpeg.js";
import { ResearchFailure } from "./errors.js";

const run = promisify(execFile);

/** Longest video Research imports (a stock clip, not a film). */
export const MAX_VIDEO_SECONDS = 20 * 60;
const MAX_VIDEO_WIDTH = 1920;
const MAX_IMAGE_PIXELS = 120_000_000;

/** What ffprobe (or sharp, for pictures) says about a downloaded file. */
export interface MediaInspection {
  kind: ResearchMediaKind | null;
  /** ffprobe's `format_name` (`mov,mp4,m4a,3gp,3g2,mj2`), or the image format sharp read (`jpeg`, `png`…). */
  container: string | null;
  videoCodec: string | null;
  audioCodec: string | null;
  pixelFormat: string | null;
  width: number | null;
  height: number | null;
  duration: number | null;
}

/** The media tools normalization needs (injectable: tests use small fakes, production ffprobe/ffmpeg/sharp). */
export interface MediaToolkit {
  inspect(file: string, signal: AbortSignal): Promise<MediaInspection>;
  /** Converts `input` to the editor-friendly form of `kind`, written to `output` (whose extension says the format). */
  convert(
    input: string,
    output: string,
    kind: ResearchMediaKind,
    signal: AbortSignal,
  ): Promise<void>;
}

/** What to do with a downloaded file: keep the bytes as they are, or convert them. */
export type NormalizationPlan =
  | { action: "keep"; kind: ResearchMediaKind; extension: string }
  | { action: "convert"; kind: ResearchMediaKind; extension: string; label: string };

const finiteOrNull = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value : null;
const numberOfText = (value: unknown): number | null => {
  const parsed = typeof value === "string" ? Number(value) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : null;
};

async function ffprobeInspect(file: string, signal: AbortSignal): Promise<MediaInspection> {
  const binary = findFfBinary("ffprobe");
  if (!binary)
    throw new ResearchFailure(
      "unsupported",
      "ffprobe is not installed, so the file cannot be checked",
    );
  let stdout: string;
  try {
    ({ stdout } = await run(
      binary,
      ["-v", "error", "-print_format", "json", "-show_format", "-show_streams", "--", file],
      { maxBuffer: 16 * 1024 * 1024, timeout: 60_000, signal, windowsHide: true },
    ));
  } catch (error) {
    if (signal.aborted) throw new ResearchFailure("network", "The import was cancelled");
    const reason = error instanceof Error ? error.message.split("\n")[0] : String(error);
    throw new ResearchFailure(
      "not_media",
      `The downloaded file is not readable as media (${reason})`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw new ResearchFailure("not_media", "The downloaded file is not readable as media");
  }
  const streams =
    isRecord(parsed) && Array.isArray(parsed.streams) ? parsed.streams.filter(isRecord) : [];
  const format = isRecord(parsed) && isRecord(parsed.format) ? parsed.format : {};
  const video = streams.find(
    (stream) =>
      stream.codec_type === "video" &&
      !(isRecord(stream.disposition) && stream.disposition.attached_pic === 1),
  );
  const audio = streams.find((stream) => stream.codec_type === "audio");
  const hasPicture = streams.some((stream) => stream.codec_type === "video");
  const duration = numberOfText(format.duration) ?? numberOfText(video?.duration);
  const kind: ResearchMediaKind | null = video
    ? // One frame of an image (jpg/png/webp as a "video" stream) is a picture, not a clip.
      duration === null || duration <= 0.05 || /image2|_pipe/.test(String(format.format_name))
      ? "picture"
      : "video"
    : audio
      ? "audio"
      : hasPicture
        ? "picture"
        : null;
  return {
    kind,
    container: typeof format.format_name === "string" ? format.format_name : null,
    videoCodec: typeof video?.codec_name === "string" ? video.codec_name : null,
    audioCodec: typeof audio?.codec_name === "string" ? audio.codec_name : null,
    pixelFormat: typeof video?.pix_fmt === "string" ? video.pix_fmt : null,
    width: finiteOrNull(video?.width),
    height: finiteOrNull(video?.height),
    duration,
  };
}

async function sharpInspect(file: string): Promise<MediaInspection | null> {
  try {
    const meta = await sharp(file, {
      limitInputPixels: MAX_IMAGE_PIXELS,
      animated: false,
    }).metadata();
    if (!meta.format) return null;
    return {
      kind: "picture",
      container: meta.format,
      videoCodec: null,
      audioCodec: null,
      pixelFormat: null,
      width: meta.width ?? null,
      height: meta.height ?? null,
      duration: null,
    };
  } catch {
    return null;
  }
}

/** Production toolkit: sharp recognizes and converts pictures, ffprobe/ffmpeg handle video and audio. */
export const systemToolkit: MediaToolkit = {
  async inspect(file, signal) {
    const image = await sharpInspect(file);
    if (image) return image;
    return ffprobeInspect(file, signal);
  },
  async convert(input, output, kind, signal) {
    if (kind === "picture") {
      try {
        await sharp(input, { limitInputPixels: MAX_IMAGE_PIXELS, density: 150 })
          .png()
          .toFile(output);
      } catch (error) {
        throw new ResearchFailure(
          "unsupported",
          `The picture could not be converted to PNG (${error instanceof Error ? error.message : String(error)})`,
        );
      }
      return;
    }
    const args =
      kind === "video"
        ? [
            "-y",
            "-i",
            input,
            "-map",
            "0:v:0",
            "-map",
            "0:a:0?",
            "-sn",
            "-dn",
            "-vf",
            `scale=trunc(min(${MAX_VIDEO_WIDTH}\\,iw)/2)*2:-2,format=yuv420p`,
            "-c:v",
            "libx264",
            "-preset",
            "veryfast",
            "-crf",
            "21",
            "-c:a",
            "aac",
            "-b:a",
            "160k",
            "-movflags",
            "+faststart",
            output,
          ]
        : ["-y", "-i", input, "-vn", "-map", "0:a:0", "-c:a", "aac", "-b:a", "192k", output];
    try {
      await runFfmpeg(args, { signal });
    } catch (error) {
      if (isAnalysisFailure(error)) {
        throw new ResearchFailure(
          error.error.code === "cancelled" ? "network" : "unsupported",
          error.error.code === "cancelled"
            ? "The import was cancelled"
            : `Conversion failed: ${error.error.message}`,
        );
      }
      throw error;
    }
  },
};

const IMAGE_FORMATS: Record<string, string> = { jpeg: "jpg", png: "png", webp: "webp", gif: "gif" };

/**
 * What to do with a file that was downloaded: the editor wants H.264/AAC MP4 (or MOV) video, JPG/PNG/WEBP/GIF
 * pictures and MP3/M4A/AAC/WAV audio; everything else is converted. A file that is not the `expected` kind is refused.
 */
export function planNormalization(
  inspection: MediaInspection,
  expected: ResearchMediaKind,
  extension: string | null,
): NormalizationPlan {
  const kind = inspection.kind;
  if (kind === null) {
    throw new ResearchFailure(
      "not_media",
      "The downloaded file has no video, audio or picture in it",
    );
  }
  if (kind !== expected) {
    const name = { video: "a video", picture: "a picture", audio: "an audio file" };
    throw new ResearchFailure(
      "not_media",
      `The file is ${name[kind]}, but ${name[expected]} was wanted`,
    );
  }
  const container = inspection.container ?? "";
  switch (kind) {
    case "video": {
      if (inspection.duration !== null && inspection.duration > MAX_VIDEO_SECONDS) {
        throw new ResearchFailure(
          "too_large",
          `The video is ${Math.round(inspection.duration / 60)} minutes long; Research imports clips up to ${MAX_VIDEO_SECONDS / 60} minutes`,
        );
      }
      const editorReady =
        /\b(mp4|mov)\b/.test(container) &&
        inspection.videoCodec === "h264" &&
        (inspection.pixelFormat === null || inspection.pixelFormat === "yuv420p") &&
        (inspection.audioCodec === null ||
          inspection.audioCodec === "aac" ||
          inspection.audioCodec === "mp3");
      if (editorReady)
        return { action: "keep", kind, extension: extension === "mov" ? "mov" : "mp4" };
      return {
        action: "convert",
        kind,
        extension: "mp4",
        label: `${describeCodec(inspection.videoCodec, container)} → H.264/AAC MP4`,
      };
    }
    case "audio": {
      const codec = inspection.audioCodec ?? "";
      if (codec === "mp3") return { action: "keep", kind, extension: "mp3" };
      if (codec === "aac") {
        return { action: "keep", kind, extension: /\b(mp4|mov)\b/.test(container) ? "m4a" : "aac" };
      }
      if (codec.startsWith("pcm_") && /\bwav\b/.test(container))
        return { action: "keep", kind, extension: "wav" };
      return {
        action: "convert",
        kind,
        extension: "m4a",
        label: `${describeCodec(codec, container)} → AAC M4A`,
      };
    }
    case "picture": {
      const kept = IMAGE_FORMATS[container];
      if (kept) return { action: "keep", kind, extension: kept };
      return { action: "convert", kind, extension: "png", label: `${container || "image"} → PNG` };
    }
  }
}

function describeCodec(codec: string | null, container: string): string {
  const first = container.split(",")[0] ?? "";
  return (
    [codec?.toUpperCase(), first && first !== codec ? `/${first.toUpperCase()}` : ""].join("") ||
    "Unknown format"
  );
}
