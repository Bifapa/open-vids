// @vitest-environment node
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findFfBinary } from "@hyperframes/parsers/ff-binaries";
import sharp from "sharp";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { isResearchFailure } from "./errors.js";
import { planNormalization, systemToolkit, type MediaInspection } from "./normalize.js";

let dir = "";
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "openvids-normalize-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const signal = new AbortController().signal;
const ffmpeg = findFfBinary("ffmpeg");
const ffprobe = findFfBinary("ffprobe");

const inspection = (extra: Partial<MediaInspection>): MediaInspection => ({
  kind: "video",
  container: "mov,mp4,m4a,3gp,3g2,mj2",
  videoCodec: "h264",
  audioCodec: "aac",
  pixelFormat: "yuv420p",
  width: 1920,
  height: 1080,
  duration: 10,
  ...extra,
});

function refusal(action: () => unknown): string {
  try {
    action();
  } catch (error) {
    if (isResearchFailure(error)) return error.error.code;
    throw error;
  }
  throw new Error("expected a refusal");
}

describe("planNormalization", () => {
  it("keeps what the editor plays and converts the rest", () => {
    expect(planNormalization(inspection({}), "video", "mp4")).toEqual({
      action: "keep",
      kind: "video",
      extension: "mp4",
    });
    expect(planNormalization(inspection({}), "video", "mov")).toMatchObject({
      action: "keep",
      extension: "mov",
    });
    // 10-bit H.264 and other codecs are not editor-ready.
    expect(
      planNormalization(inspection({ pixelFormat: "yuv420p10le" }), "video", "mp4"),
    ).toMatchObject({ action: "convert", extension: "mp4" });
    expect(
      planNormalization(
        inspection({ container: "matroska,webm", videoCodec: "vp9" }),
        "video",
        "webm",
      ),
    ).toMatchObject({
      action: "convert",
      label: "VP9/MATROSKA → H.264/AAC MP4",
    });
    expect(
      planNormalization(inspection({ kind: "picture", container: "jpeg" }), "picture", "jpeg"),
    ).toEqual({ action: "keep", kind: "picture", extension: "jpg" });
    expect(
      planNormalization(inspection({ kind: "picture", container: "svg" }), "picture", "svg"),
    ).toMatchObject({ action: "convert", extension: "png" });
    expect(
      planNormalization(
        inspection({ kind: "audio", container: "flac", audioCodec: "flac" }),
        "audio",
        "flac",
      ),
    ).toMatchObject({ action: "convert", extension: "m4a" });
    expect(
      planNormalization(
        inspection({ kind: "audio", container: "wav", audioCodec: "pcm_s16le" }),
        "audio",
        "wav",
      ),
    ).toMatchObject({ action: "keep", extension: "wav" });
  });

  it("refuses a file of another kind, a file with nothing playable in it and a video over twenty minutes", () => {
    expect(refusal(() => planNormalization(inspection({ kind: "picture" }), "video", "jpg"))).toBe(
      "not_media",
    );
    expect(refusal(() => planNormalization(inspection({ kind: null }), "video", "bin"))).toBe(
      "not_media",
    );
    expect(
      refusal(() => planNormalization(inspection({ duration: 21 * 60 }), "video", "mp4")),
    ).toBe("too_large");
  });
});

describe("the real tools", () => {
  it("recognizes a picture, converts a TIFF to PNG and refuses a file that is not media", async () => {
    const tiff = join(dir, "scan.tif");
    await sharp({ create: { width: 64, height: 48, channels: 3, background: "#3366cc" } })
      .tiff()
      .toFile(tiff);
    const found = await systemToolkit.inspect(tiff, signal);
    expect(found).toMatchObject({ kind: "picture", container: "tiff", width: 64, height: 48 });
    const plan = planNormalization(found, "picture", "tif");
    expect(plan).toMatchObject({ action: "convert", extension: "png" });
    const png = join(dir, "scan.png");
    await systemToolkit.convert(tiff, png, "picture", signal);
    expect(await systemToolkit.inspect(png, signal)).toMatchObject({
      kind: "picture",
      container: "png",
      width: 64,
    });

    const text = join(dir, "page.bin");
    writeFileSync(text, "<html>not media</html>");
    const outcome = await systemToolkit.inspect(text, signal).then(
      (result) => result.kind,
      (error: unknown) => (isResearchFailure(error) ? error.error.code : "other"),
    );
    expect(outcome === null || outcome === "not_media").toBe(true);
  });

  it.skipIf(!ffmpeg || !ffprobe)(
    "converts a VP9 WebM with audio into an H.264/AAC MP4 the editor can use, and an Ogg into M4A",
    async () => {
      const webm = join(dir, "clip.webm");
      execFileSync(ffmpeg ?? "ffmpeg", [
        "-v",
        "error",
        "-y",
        "-f",
        "lavfi",
        "-i",
        "testsrc=size=640x360:rate=24:duration=1",
        "-f",
        "lavfi",
        "-i",
        "sine=frequency=440:duration=1",
        "-c:v",
        "libvpx-vp9",
        "-c:a",
        "libopus",
        "-shortest",
        webm,
      ]);
      const original = await systemToolkit.inspect(webm, signal);
      expect(original).toMatchObject({ kind: "video", videoCodec: "vp9" });
      const plan = planNormalization(original, "video", "webm");
      expect(plan.action).toBe("convert");
      const mp4 = join(dir, "clip.mp4");
      await systemToolkit.convert(webm, mp4, "video", signal);
      const converted = await systemToolkit.inspect(mp4, signal);
      expect(converted).toMatchObject({
        kind: "video",
        videoCodec: "h264",
        audioCodec: "aac",
        pixelFormat: "yuv420p",
      });
      expect(planNormalization(converted, "video", "mp4").action).toBe("keep");

      const ogg = join(dir, "tone.ogg");
      execFileSync(ffmpeg ?? "ffmpeg", [
        "-v",
        "error",
        "-y",
        "-f",
        "lavfi",
        "-i",
        "sine=frequency=330:duration=1",
        "-c:a",
        "libvorbis",
        ogg,
      ]);
      const audio = await systemToolkit.inspect(ogg, signal);
      expect(audio.kind).toBe("audio");
      const m4a = join(dir, "tone.m4a");
      await systemToolkit.convert(ogg, m4a, "audio", signal);
      expect(
        planNormalization(await systemToolkit.inspect(m4a, signal), "audio", "m4a"),
      ).toMatchObject({ action: "keep", extension: "m4a" });
    },
  );
});
