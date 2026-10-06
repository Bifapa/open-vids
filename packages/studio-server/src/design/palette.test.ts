// @vitest-environment node
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { hasFfmpeg, makeClip } from "../analysis/testSupport.js";
import { isDesignFailure } from "./errors.js";
import { extractVideoPalette, quantizePalette } from "./palette.js";

function pixels(parts: Array<[number, number, number, number]>): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part[3], 0);
  const buffer = new Uint8Array(total * 3);
  let at = 0;
  for (const [r, g, b, count] of parts) {
    for (let i = 0; i < count; i++) buffer.set([r, g, b], at++ * 3);
  }
  return buffer;
}

describe("quantizePalette", () => {
  it("returns exact colours with their pixel share, most frequent first", () => {
    expect(
      quantizePalette(
        pixels([
          [255, 0, 0, 600],
          [0, 0, 255, 300],
          [0, 255, 0, 100],
        ]),
      ),
    ).toEqual([
      { value: "#ff0000", share: 0.6 },
      { value: "#0000ff", share: 0.3 },
      { value: "#00ff00", share: 0.1 },
    ]);
  });

  it("merges near-duplicates into one colour and keeps distinct ones apart", () => {
    const palette = quantizePalette(
      pixels([
        [250, 5, 5, 200],
        [255, 0, 0, 600],
        [20, 20, 20, 150],
        [0, 0, 255, 50],
      ]),
    );
    expect(palette.map((color) => color.share)).toEqual([0.8, 0.15, 0.05]);
    expect(palette[0]?.value).toMatch(/^#f[ef]0[0-5]0[0-5]$/);
    expect(palette[1]?.value).toBe("#141414");
  });

  it("is deterministic, ignores dust, and handles an empty buffer", () => {
    const noisy = new Uint8Array(30_000);
    for (let i = 0; i < noisy.length; i++) noisy[i] = (i * 7919) % 251;
    expect(quantizePalette(noisy)).toEqual(quantizePalette(noisy.slice()));
    expect(quantizePalette(noisy).length).toBeLessThanOrEqual(12);
    expect(quantizePalette(new Uint8Array(0))).toEqual([]);
    const dust = quantizePalette(
      pixels([
        [10, 10, 10, 9990],
        [200, 40, 40, 2],
      ]),
    );
    expect(dust).toEqual([{ value: "#0a0a0a", share: 0.9998 }]);
  });
});

describe.skipIf(!hasFfmpeg)("extractVideoPalette", () => {
  let scratch = "";
  let clip = "";
  beforeAll(() => {
    scratch = mkdtempSync(join(tmpdir(), "openvids-palette-"));
    clip = join(scratch, "clip.mp4");
    // red 0–2 s, black 2–4 s, white 4–6 s, colour bars 6–8 s
    makeClip(clip);
  });
  afterAll(() => rmSync(scratch, { recursive: true, force: true }));

  it("samples frames across the file and finds its dominant colours", async () => {
    const first = await extractVideoPalette(clip, { frames: 8, durationSec: 8 });
    expect(first.frames).toBe(8);
    const near = (color: string, target: [number, number, number]) => {
      const channels = [1, 3, 5].map((at) => Number.parseInt(color.slice(at, at + 2), 16));
      return channels.every((channel, i) => Math.abs(channel - (target[i] ?? 0)) < 30);
    };
    const colors = first.colors.map((color) => color.value);
    expect(colors.some((color) => near(color, [255, 0, 0]))).toBe(true);
    expect(colors.some((color) => near(color, [16, 16, 16]))).toBe(true);
    expect(colors.some((color) => near(color, [235, 235, 235]))).toBe(true);
    expect(first.colors.reduce((sum, color) => sum + color.share, 0)).toBeGreaterThan(0.95);
    expect(await extractVideoPalette(clip, { frames: 8, durationSec: 8 })).toEqual(first);
  });

  it("reports a file that is not a video and a missing ffmpeg as design failures", async () => {
    const broken = extractVideoPalette(join(scratch, "nothing.mp4"), { frames: 2, durationSec: 2 });
    await expect(broken).rejects.toSatisfy(isDesignFailure);
    const missing = extractVideoPalette(clip, {
      frames: 2,
      durationSec: 8,
      ffmpegPath: join(scratch, "no-such-ffmpeg"),
    });
    await expect(missing).rejects.toMatchObject({ error: { code: "unavailable" } });
  });
});
