/**
 * The Studio server's frame capability (`captureFrames`), implemented by running this CLI's own `frames` command as a
 * child process: headless Chrome seeks the composition and screenshots it at the requested seconds, video frames
 * included (the same path as `snapshot`). Kept out of the server process like the layout check (see `cliChild.ts`);
 * aborting the request kills the CLI and the browser it started. The JPEGs go through a private temp folder that is
 * removed afterwards.
 */

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import type {
  CapturedFrame,
  CompositionCapture,
  ResolvedProject,
} from "@hyperframes/studio-server";
import { failureMessage, runCli, type CliChildDeps } from "./cliChild.js";

function field(value: unknown, key: string): unknown {
  return typeof value === "object" && value !== null ? Reflect.get(value, key) : undefined;
}

function finite(value: unknown, what: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`frames: bad ${what}`);
  return value;
}

export async function captureFramesViaCli(
  opts: {
    project: Pick<ResolvedProject, "dir">;
    composition: string;
    times: number[];
    width: number;
    signal: AbortSignal;
  },
  deps: CliChildDeps = {},
): Promise<CompositionCapture | { unavailable: string }> {
  const dir = mkdtempSync(join(tmpdir(), "openvids-frames-"));
  try {
    const run = await runCli(
      [
        "frames",
        opts.project.dir,
        "--at",
        opts.times.join(","),
        "--out",
        dir,
        "--width",
        String(opts.width),
        "--composition",
        opts.composition,
        "--json",
      ],
      { signal: opts.signal },
      deps,
    );
    const report = run.json;
    if (report?.ok === false && typeof report.error === "string") {
      // Only a Chrome that cannot be found or downloaded is "unavailable"; a failed capture is a failure to report.
      if (report.code === "unavailable") return { unavailable: report.error };
      throw new Error(report.error);
    }
    if (run.code !== 0 || report?.ok !== true) throw new Error(failureMessage("frames", run));

    const entries = report.frames;
    if (!Array.isArray(entries)) throw new Error("frames: bad frame list");
    const root = resolve(dir);
    const frames = entries.map((entry): CapturedFrame => {
      const file = resolve(String(field(entry, "file")));
      if (!file.startsWith(`${root}${sep}`))
        throw new Error("frames: a frame file escapes its folder");
      return {
        time: finite(field(entry, "requested"), "requested time"),
        capturedAt: finite(field(entry, "time"), "captured time"),
        width: finite(field(entry, "width"), "frame width"),
        height: finite(field(entry, "height"), "frame height"),
        data: readFileSync(file),
      };
    });
    return { duration: finite(report.duration, "duration"), frames };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
