// @vitest-environment node
import { describe, expect, it } from "vitest";
import { FrameMeter, detectSilences, percentile, silenceThreshold } from "./levels.js";

const FRAME = 0.05;

/** Frames of `db` repeated `seconds` long: `tone(-20, 1)` is one second of speech-level audio. */
function tone(db: number, seconds: number): number[] {
  return Array.from({ length: Math.round(seconds / FRAME) }, () => db);
}

/** Speech-level audio with a room-tone gap: 2 s speech, `gap` s room tone, 2 s speech, repeated. */
function talk(floorDb: number, speechDb: number, gap: number): number[] {
  return [
    ...tone(speechDb, 2),
    ...tone(floorDb, gap),
    ...tone(speechDb, 2),
    ...tone(floorDb, gap),
    ...tone(speechDb, 2),
  ];
}

describe("percentile", () => {
  it("picks the nearest rank of unsorted values", () => {
    expect(percentile([5, 1, 3, 2, 4], 0)).toBe(1);
    expect(percentile([5, 1, 3, 2, 4], 0.5)).toBe(3);
    expect(percentile([5, 1, 3, 2, 4], 1)).toBe(5);
  });
});

describe("silenceThreshold", () => {
  it("sits a third of the way from the noise floor to the speech level", () => {
    // floor -60 (10th percentile), speech -20 (90th percentile): spread 40 → margin 12
    const frames = [...tone(-60, 2), ...tone(-20, 8)];
    expect(silenceThreshold(frames)).toBe(-48);
  });

  it("follows a loud room tone that a fixed -38 dB threshold would sit below", () => {
    const frames = [...tone(-46, 2), ...tone(-16, 8)];
    const threshold = silenceThreshold(frames);
    expect(threshold).toBeGreaterThan(-38);
    expect(threshold).toBeLessThan(-30);
  });

  it("keeps at least 6 dB and at most 15 dB above the floor", () => {
    expect(silenceThreshold([...tone(-60, 2), ...tone(-52, 8)])).toBe(-54);
    expect(silenceThreshold([...tone(-70, 2), ...tone(-10, 8)])).toBe(-55);
  });

  it("stays within -70 and -25 dBFS", () => {
    expect(silenceThreshold([...tone(-95, 2), ...tone(-30, 8)])).toBe(-70);
    expect(silenceThreshold([...tone(-32, 2), ...tone(-1, 8)])).toBe(-25);
  });

  it("calls a recording without contrast silent only when it is very quiet", () => {
    expect(silenceThreshold(tone(-20, 5))).toBe(-50);
    expect(silenceThreshold(tone(-80, 5))).toBe(-50);
  });

  it("is defined for no frames", () => {
    expect(silenceThreshold([])).toBe(-50);
  });
});

describe("detectSilences", () => {
  it("finds the gaps between speech with their times", () => {
    const { thresholdDb, silences } = detectSilences(talk(-55, -20, 1), FRAME);
    expect(thresholdDb).toBeLessThan(-40);
    expect(thresholdDb).toBeGreaterThan(-55);
    expect(silences).toEqual([
      { start: 2, end: 3 },
      { start: 5, end: 6 },
    ]);
  });

  it("adapts to the noise floor of each recording", () => {
    for (const floor of [-75, -60, -46, -38]) {
      const { silences } = detectSilences(talk(floor, floor + 40, 1.5), FRAME);
      expect(silences).toEqual([
        { start: 2, end: 3.5 },
        { start: 5.5, end: 7 },
      ]);
    }
  });

  it("drops gaps shorter than the minimum silence", () => {
    const frames = talk(-55, -20, 0.3);
    expect(detectSilences(frames, FRAME).silences).toEqual([]);
    expect(detectSilences(frames, FRAME, { minSilence: 0.3 }).silences).toHaveLength(2);
  });

  it("keeps a gap of exactly the minimum length", () => {
    expect(detectSilences(talk(-55, -20, 0.35), FRAME).silences).toHaveLength(2);
  });

  it("bridges up to two loud frames inside a silence", () => {
    const frames = [
      ...tone(-20, 1),
      ...tone(-55, 0.5),
      ...tone(-20, 2 * FRAME),
      ...tone(-55, 0.5),
      ...tone(-20, 1),
    ];
    expect(detectSilences(frames, FRAME).silences).toEqual([{ start: 1, end: 2.1 }]);
  });

  it("splits a silence at three or more loud frames", () => {
    const frames = [
      ...tone(-20, 1),
      ...tone(-55, 0.5),
      ...tone(-20, 3 * FRAME),
      ...tone(-55, 0.5),
      ...tone(-20, 1),
    ];
    expect(detectSilences(frames, FRAME).silences).toEqual([
      { start: 1, end: 1.5 },
      { start: 1.65, end: 2.15 },
    ]);
  });

  it("does not let a spike shorter than the minimum start or extend a silence", () => {
    const frames = [
      ...tone(-20, 1),
      ...tone(-55, 0.2),
      ...tone(-20, FRAME),
      ...tone(-55, 0.2),
      ...tone(-20, 1),
    ];
    // 0.2 + spike + 0.2 bridges into one 0.45 s silence, spike included
    expect(detectSilences(frames, FRAME).silences).toEqual([{ start: 1, end: 1.45 }]);
    const lone = [...tone(-20, 1), ...tone(-55, 0.2), ...tone(-20, 1)];
    expect(detectSilences(lone, FRAME).silences).toEqual([]);
  });

  it("reports a silence at the very start and at the very end", () => {
    const frames = [...tone(-55, 1), ...tone(-20, 2), ...tone(-55, 1)];
    expect(detectSilences(frames, FRAME).silences).toEqual([
      { start: 0, end: 1 },
      { start: 3, end: 4 },
    ]);
  });

  it("reports one silence for an all-silent recording", () => {
    const { silences } = detectSilences(tone(-80, 10), FRAME);
    expect(silences).toEqual([{ start: 0, end: 10 }]);
  });

  it("reports none for a recording that never goes quiet", () => {
    expect(detectSilences(tone(-18, 10), FRAME).silences).toEqual([]);
    const busy = Array.from({ length: 200 }, (_, index) => -25 + (index % 5));
    expect(detectSilences(busy, FRAME).silences).toEqual([]);
  });

  it("reports none for no frames", () => {
    expect(detectSilences([], FRAME).silences).toEqual([]);
  });
});

/** Little-endian s16 bytes of the samples (−1…1). */
function pcm(samples: number[]): Uint8Array {
  const bytes = new Uint8Array(samples.length * 2);
  const view = new DataView(bytes.buffer);
  samples.forEach((sample, index) => view.setInt16(index * 2, Math.round(sample * 32767), true));
  return bytes;
}

describe("FrameMeter", () => {
  const RATE = 100;

  it("reads a full-scale square wave as 0 dBFS and half of it as -6 dBFS", () => {
    const meter = new FrameMeter(RATE, 0.1);
    meter.push(
      pcm([...Array.from({ length: 10 }, () => 1), ...Array.from({ length: 10 }, () => 0.5)]),
    );
    const [loud, half] = meter.finish();
    expect(loud).toBeCloseTo(0, 2);
    expect(half).toBeCloseTo(-6.02, 1);
  });

  it("reads digital silence as -100 dBFS", () => {
    const meter = new FrameMeter(RATE, 0.1);
    meter.push(pcm(Array.from({ length: 10 }, () => 0)));
    expect(meter.finish()).toEqual([-100]);
  });

  it("gives the same levels however the stream is chunked, even between the bytes of a sample", () => {
    const bytes = pcm(
      Array.from({ length: 50 }, (_, index) => Math.sin(index) * (index < 25 ? 0.9 : 0.05)),
    );
    const whole = new FrameMeter(RATE, 0.1);
    whole.push(bytes);
    const chunked = new FrameMeter(RATE, 0.1);
    for (let at = 0; at < bytes.length; at += 7) chunked.push(bytes.subarray(at, at + 7));
    expect(chunked.finish()).toEqual(whole.finish());
    expect(chunked.sampleCount).toBe(50);
  });

  it("counts a final partial frame only when it is at least half a frame", () => {
    const half = new FrameMeter(RATE, 0.1);
    half.push(pcm(Array.from({ length: 15 }, () => 0.5)));
    expect(half.finish()).toHaveLength(2);
    const short = new FrameMeter(RATE, 0.1);
    short.push(pcm(Array.from({ length: 14 }, () => 0.5)));
    expect(short.finish()).toHaveLength(1);
  });
});
