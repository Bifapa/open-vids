// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  mp3DurationEstimate,
  normalizeAudio,
  sniffAudio,
  wavDurationSeconds,
  wrapPcmAsWav,
} from "./audio.js";
import { isVoiceFailure } from "./errors.js";
import { silentWav } from "./testSupport.js";

const MP3_FRAME = [0xff, 0xfb, 0x90, 0x00]; // MPEG-1 layer III, 128 kbps, 44.1 kHz

describe("audio normalisation", () => {
  it("wraps raw PCM in a 44-byte WAV header at the stated rate", () => {
    const wav = wrapPcmAsWav(new Uint8Array(96_000), 24_000);
    expect(wav).toHaveLength(44 + 96_000);
    expect(sniffAudio(wav)).toBe("wav");
    expect(wavDurationSeconds(wav)).toBeCloseTo(2, 5);
    const normalized = normalizeAudio({
      bytes: new Uint8Array(48_000),
      format: "pcm",
      sampleRate: 24_000,
    });
    expect(normalized).toMatchObject({ kind: "wav", mimeType: "audio/wav" });
    expect(wavDurationSeconds(normalized.bytes)).toBeCloseTo(1, 5);
  });

  it("drops an odd trailing PCM byte", () => {
    expect(wrapPcmAsWav(new Uint8Array(5), 24_000)).toHaveLength(44 + 4);
  });

  it("passes WAV and MP3 through and sniffs the container, not the claimed format", () => {
    const wav = silentWav();
    expect(normalizeAudio({ bytes: wav, format: "mp3" })).toMatchObject({
      kind: "wav",
      bytes: wav,
    });
    const id3 = new Uint8Array([0x49, 0x44, 0x33, 4, 0, 0, 0, 0, 0, 0, ...MP3_FRAME]);
    expect(normalizeAudio({ bytes: id3, format: "mp3" })).toMatchObject({
      kind: "mp3",
      mimeType: "audio/mpeg",
    });
    expect(sniffAudio(new Uint8Array([...MP3_FRAME, 0, 0]))).toBe("mp3");
  });

  it("refuses anything else with not_audio and the first 2 KB", () => {
    for (const bytes of [
      new TextEncoder().encode(`{"error":"${"x".repeat(4000)}"}`),
      new Uint8Array(0),
      new Uint8Array([0xff, 0xe0, 0, 0, 0]),
    ]) {
      try {
        normalizeAudio({ bytes, format: "wav" }, "application/json");
        throw new Error("should have failed");
      } catch (error) {
        expect(isVoiceFailure(error) && error.code).toBe("not_audio");
        if (isVoiceFailure(error) && bytes.length > 100)
          expect(String(error.params?.body)).toHaveLength(2048);
      }
    }
  });

  it("reads the duration of a streamed WAV whose data size is open", () => {
    const wav = silentWav(2);
    new DataView(wav.buffer).setUint32(40, 0xffffffff, true);
    expect(wavDurationSeconds(wav)).toBeCloseTo(2, 5);
  });

  it("estimates a constant-bitrate MP3 from its first frame", () => {
    const bytes = new Uint8Array(16_000);
    bytes.set(MP3_FRAME, 0);
    expect(mp3DurationEstimate(bytes)).toBeCloseTo(1, 5);
  });
});
