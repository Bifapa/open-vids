import { probeMediaMetadata, type FfprobeRunner } from "../helpers/mediaMetadata.js";
import { notAudio, VoiceFailure } from "./errors.js";
import type { ConnectorAudio } from "./types.js";

export type AudioKind = "wav" | "mp3";

export interface NormalizedAudio {
  bytes: Uint8Array;
  kind: AudioKind;
  mimeType: "audio/wav" | "audio/mpeg";
}

/** The rate raw PCM is assumed to have when the provider did not say (Gemini and OpenAI both answer 24 kHz). */
const DEFAULT_PCM_RATE = 24_000;

function ascii(bytes: Uint8Array, offset: number, length: number): string {
  let text = "";
  for (let index = offset; index < offset + length && index < bytes.length; index += 1)
    text += String.fromCharCode(bytes[index] ?? 0);
  return text;
}

/** Which container the bytes are: a RIFF/WAVE file, or MP3 (an ID3v2 tag or an MPEG audio frame sync). */
export function sniffAudio(bytes: Uint8Array): AudioKind | null {
  if (bytes.length >= 12 && ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 4) === "WAVE")
    return "wav";
  if (bytes.length >= 10 && ascii(bytes, 0, 3) === "ID3") return "mp3";
  const first = bytes[0] ?? 0;
  const second = bytes[1] ?? 0;
  // Frame sync: 11 set bits, then a layer other than the reserved 00.
  if (bytes.length >= 4 && first === 0xff && (second & 0xe0) === 0xe0 && (second & 0x06) !== 0)
    return "mp3";
  return null;
}

/** A canonical 44-byte-header WAV around raw signed 16-bit little-endian PCM. */
export function wrapPcmAsWav(pcm: Uint8Array, sampleRate: number, channels = 1): Uint8Array {
  const data = pcm.length - (pcm.length % 2);
  const out = new Uint8Array(44 + data);
  const view = new DataView(out.buffer);
  const write = (offset: number, text: string): void => {
    for (let index = 0; index < text.length; index += 1)
      out[offset + index] = text.charCodeAt(index);
  };
  write(0, "RIFF");
  view.setUint32(4, 36 + data, true);
  write(8, "WAVE");
  write(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, channels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * channels * 2, true);
  view.setUint16(32, channels * 2, true);
  view.setUint16(34, 16, true);
  write(36, "data");
  view.setUint32(40, data, true);
  out.set(pcm.subarray(0, data), 44);
  return out;
}

/**
 * The provider's bytes as a WAV or MP3 file. Raw PCM gets a header; everything else must already be one of the two
 * containers, otherwise the provider answered something else (an error page, JSON) and the failure carries its first
 * 2 KB.
 */
export function normalizeAudio(audio: ConnectorAudio, contentType = ""): NormalizedAudio {
  if (audio.bytes.length === 0) throw notAudio(contentType, audio.bytes);
  const sniffed = sniffAudio(audio.bytes);
  if (sniffed === "wav") return { bytes: audio.bytes, kind: "wav", mimeType: "audio/wav" };
  if (sniffed === "mp3") return { bytes: audio.bytes, kind: "mp3", mimeType: "audio/mpeg" };
  if (audio.format === "pcm")
    return {
      bytes: wrapPcmAsWav(audio.bytes, audio.sampleRate ?? DEFAULT_PCM_RATE),
      kind: "wav",
      mimeType: "audio/wav",
    };
  throw notAudio(contentType, audio.bytes);
}

/** Duration of a WAV from its header: the data chunk over the byte rate (a streamed header's open size is clamped). */
export function wavDurationSeconds(bytes: Uint8Array): number | null {
  if (sniffAudio(bytes) !== "wav") return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let byteRate = 0;
  let offset = 12;
  while (offset + 8 <= bytes.length) {
    const id = ascii(bytes, offset, 4);
    const size = view.getUint32(offset + 4, true);
    if (id === "fmt " && offset + 20 <= bytes.length) byteRate = view.getUint32(offset + 16, true);
    if (id === "data") {
      const available = bytes.length - (offset + 8);
      const length = Math.min(size, available);
      return byteRate > 0 ? length / byteRate : null;
    }
    offset += 8 + size + (size % 2);
  }
  return null;
}

const MPEG1_LAYER3_KBPS = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320];
const MPEG2_LAYER3_KBPS = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160];

/** Duration of a constant-bitrate MP3 from its first frame header; null for anything else. */
export function mp3DurationEstimate(bytes: Uint8Array): number | null {
  let offset = 0;
  if (ascii(bytes, 0, 3) === "ID3" && bytes.length >= 10) {
    offset =
      10 +
      (((bytes[6] ?? 0) & 0x7f) << 21) +
      (((bytes[7] ?? 0) & 0x7f) << 14) +
      (((bytes[8] ?? 0) & 0x7f) << 7) +
      ((bytes[9] ?? 0) & 0x7f);
  }
  for (let index = offset; index + 4 <= bytes.length && index < offset + 4_096; index += 1) {
    const second = bytes[index + 1] ?? 0;
    if (bytes[index] !== 0xff || (second & 0xe0) !== 0xe0) continue;
    const version = (second >> 3) & 0x03;
    const layer = (second >> 1) & 0x03;
    const bitrateIndex = ((bytes[index + 2] ?? 0) >> 4) & 0x0f;
    if (version === 1 || layer !== 1 || bitrateIndex === 0 || bitrateIndex === 15) continue;
    const kbps = (version === 3 ? MPEG1_LAYER3_KBPS : MPEG2_LAYER3_KBPS)[bitrateIndex];
    if (!kbps) return null;
    return ((bytes.length - index) * 8) / (kbps * 1_000);
  }
  return null;
}

/**
 * Duration of a written audio file: ffprobe (through `probeMediaMetadata`, so an injected runner stands in for it)
 * and, when that is unavailable, the WAV header or the first MP3 frame.
 */
export async function measureDuration(
  path: string,
  bytes: Uint8Array,
  kind: AudioKind,
  runner?: FfprobeRunner,
): Promise<number> {
  const metadata = await probeMediaMetadata(path, runner).catch(() => null);
  const probed = metadata?.durationSeconds;
  if (typeof probed === "number" && Number.isFinite(probed) && probed > 0) return probed;
  const estimate = kind === "wav" ? wavDurationSeconds(bytes) : mp3DurationEstimate(bytes);
  if (estimate !== null && Number.isFinite(estimate) && estimate > 0) return estimate;
  throw new VoiceFailure(
    "provider_error",
    "The duration of the generated audio could not be read.",
  );
}
