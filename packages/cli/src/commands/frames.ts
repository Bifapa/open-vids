import { defineCommand } from "citty";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import type { Example } from "./_examples.js";
import { c } from "../ui/colors.js";
import { failCommand } from "../utils/commandResult.js";
import { normalizeErrorMessage } from "../utils/errorMessage.js";
import { resolveProject } from "../utils/project.js";
import { ensureBrowser } from "../browser/manager.js";
import { studioEditBodyScripts } from "../utils/studioFrameScripts.js";
import { resolveLocalBrowserGpuMode } from "../browser/gpuPolicy.js";
import { captureSnapshots } from "./snapshot.js";

export const examples: Example[] = [
  [
    "JPEG frames of the preview at three moments",
    "hyperframes frames --at 1,4.5,9 --out ./frames --json",
  ],
];

const MAX_TIMES = 12;
const JPEG_QUALITY = 72;

function parseTimes(value: unknown): number[] | null {
  if (typeof value !== "string" || value.trim() === "") return null;
  const times = value.split(",").map((part) => Number(part.trim()));
  if (times.length > MAX_TIMES || times.some((time) => !Number.isFinite(time) || time < 0)) {
    return null;
  }
  return times;
}

export default defineCommand({
  meta: {
    name: "frames",
    description:
      "Capture downscaled JPEG frames of a composition at given seconds, the way the preview shows them (no video render). Machine-readable with --json.",
  },
  args: {
    dir: { type: "positional", description: "Project directory", required: false },
    at: { type: "string", description: "Comma-separated seconds, at most 12", required: true },
    out: {
      type: "string",
      description:
        "Directory the JPEGs are written to (created if missing; existing files are kept, frame-NN-at-Ts.jpg of the same name are replaced)",
      required: true,
    },
    composition: {
      type: "string",
      description: "Project-relative composition to capture (default: index.html)",
    },
    width: { type: "string", description: "Output width in pixels (default 640)", default: "640" },
    timeout: {
      type: "string",
      description: "Ms to wait for the runtime to initialize (default: 15000)",
      default: "15000",
    },
    json: { type: "boolean", description: "Print one JSON result", default: false },
  },
  async run({ args }) {
    const json = args.json;
    const fail = (code: string, message: string): never => {
      if (json) console.log(JSON.stringify({ ok: false, code, error: message }));
      else console.error(`${c.error("✗")} ${message}`);
      return failCommand(1, message);
    };

    const times = parseTimes(args.at);
    if (!times) return fail("invalid_request", `--at must list 1 to ${MAX_TIMES} seconds`);
    const width = Number(args.width);
    if (!Number.isInteger(width) || width < 16 || width > 4096) {
      return fail("invalid_request", "--width must be an integer from 16 to 4096");
    }
    const timeout = Number(args.timeout);
    if (!Number.isFinite(timeout) || timeout < 1000) {
      return fail("invalid_request", "--timeout must be at least 1000 ms");
    }

    const project = resolveProject(args.dir);
    const outputDir = resolve(args.out);
    mkdirSync(outputDir, { recursive: true });
    const frames: Array<{
      requested: number;
      time: number;
      file: string;
      width: number;
      height: number;
    }> = [];
    let duration = 0;
    try {
      await ensureBrowser();
    } catch (error) {
      return fail("unavailable", `Chrome is not available: ${normalizeErrorMessage(error)}`);
    }
    try {
      await captureSnapshots(project.dir, {
        at: times,
        outputDir,
        timeout,
        includeEnd: false,
        clampToDuration: true,
        image: { width, quality: JPEG_QUALITY },
        ...(args.composition ? { entryFile: args.composition } : {}),
        // The directory is the caller's: nothing in it is deleted, only the frame files written here are replaced.
        cleanOutput: false,
        bodyScripts: (html) => studioEditBodyScripts(project.dir, html, args.composition),
        browserGpuMode: resolveLocalBrowserGpuMode(undefined),
        onFrame: (frame) => {
          duration = frame.duration;
          frames.push({
            requested: times[frame.index] ?? frame.time,
            time: frame.time,
            file: frame.path,
            width: frame.width,
            height: frame.height,
          });
        },
      });
    } catch (error) {
      return fail("capture_failed", normalizeErrorMessage(error));
    }
    if (frames.length === 0) {
      return fail(
        "capture_failed",
        "The composition has no readable length, so no frame was captured",
      );
    }
    const result = { ok: true, duration, frames };
    if (json) console.log(JSON.stringify(result));
    else for (const frame of frames) console.log(`${frame.time}s  ${frame.file}`);
  },
});
