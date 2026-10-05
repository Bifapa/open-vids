import { statSync } from "node:fs";
import type { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import {
  COMPOSITION_FRAME_LIMITS,
  parseCompositionFramesRequest,
  type CompositionFrame,
  type CompositionFramesResponse,
  type EditError,
} from "@hyperframes/agent-protocol";
import { isEditFailure } from "../editing/errors.js";
import { normalizeCompositionPath } from "../editing/service.js";
import { createProjectSignature } from "../helpers/projectSignature.js";
import { resolveWithinProject } from "../helpers/safePath.js";
import type { ResolvedProject, StudioApiAdapter } from "../types.js";

const MAX_BODY_BYTES = 4 * 1024;
/** A capture starts Chrome and seeks it; past this the request is given up (the child is killed with the signal). */
const CAPTURE_TIMEOUT_MS = 120_000;
/** Cached JPEGs are kept in memory only, so a restart or an edit never serves a stale picture. */
const CACHE_MAX_BYTES = 32 * 1024 * 1024;

interface CachedFrame {
  duration: number;
  capturedAt: number;
  width: number;
  height: number;
  data: string;
}

/** Least-recently-used frames, bounded by their base64 size. */
class FrameCache {
  private readonly entries = new Map<string, CachedFrame>();
  private bytes = 0;

  get(key: string): CachedFrame | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry;
  }

  set(key: string, entry: CachedFrame): void {
    const previous = this.entries.get(key);
    if (previous) this.bytes -= previous.data.length;
    this.entries.delete(key);
    this.entries.set(key, entry);
    this.bytes += entry.data.length;
    for (const [oldest, value] of this.entries) {
      if (this.bytes <= CACHE_MAX_BYTES || this.entries.size <= 1) break;
      this.entries.delete(oldest);
      this.bytes -= value.data.length;
    }
  }
}

/** One browser at a time: captures of any project queue behind each other instead of starting a Chrome apiece. */
let queueTail: Promise<unknown> = Promise.resolve();

function exclusive<T>(signal: AbortSignal, task: () => Promise<T>): Promise<T> {
  const run = queueTail.then(() => {
    signal.throwIfAborted();
    return task();
  });
  queueTail = run.catch(() => undefined);
  return run;
}

function fail(code: EditError["code"], message: string): { error: EditError } {
  return { error: { code, message } };
}

function compositionFile(project: ResolvedProject, path: string): boolean {
  const abs = resolveWithinProject(project.dir, path);
  if (!abs || !path.endsWith(".html")) return false;
  try {
    return statSync(abs).isFile();
  } catch {
    return false;
  }
}

/**
 * `POST /projects/:id/editing/frames`: JPEG frames of a composition at given seconds, without rendering a video. The
 * adapter captures (a CLI child with its own headless Chrome, never this process); a frame is cached per (project
 * content, composition, time, width), so asking again after a change that did not touch the project costs nothing and
 * any edit shows up. Aborting the request (the caller went away) stops the capture.
 */
export function registerCompositionFrameRoutes(api: Hono, adapter: StudioApiAdapter): void {
  const cache = new FrameCache();

  api.post(
    "/projects/:id/editing/frames",
    bodyLimit({
      maxSize: MAX_BODY_BYTES,
      onError: (c) => c.json(fail("invalid_request", "Request body is too large"), 400),
    }),
    async (c) => {
      const project = await adapter.resolveProject(c.req.param("id"));
      if (!project) return c.json({ error: "not found" }, 404);
      const parsed = parseCompositionFramesRequest(await c.req.json().catch(() => undefined));
      if (!parsed.ok) return c.json({ error: parsed.error }, 400);
      const request = parsed.value;

      let composition: string;
      try {
        composition = normalizeCompositionPath(request.composition);
      } catch (error) {
        if (isEditFailure(error)) return c.json({ error: error.error }, 400);
        throw error;
      }
      if (!compositionFile(project, composition)) {
        return c.json(fail("unknown_composition", `No composition "${composition}"`), 400);
      }
      const capture = adapter.captureFrames;
      if (!capture) {
        return c.json(fail("unsupported", "This Studio cannot capture composition frames"), 400);
      }

      const width = request.width ?? COMPOSITION_FRAME_LIMITS.defaultWidth;
      // Read from the files on every request (not the host's cached signature) so an edit that just landed shows.
      const fingerprint = createProjectSignature(project.dir);
      const keyOf = (time: number) =>
        `${project.dir}\0${fingerprint}\0${composition}\0${width}\0${time}`;
      const found = new Map<number, CachedFrame>();
      for (const time of request.times) {
        const hit = cache.get(keyOf(time));
        if (hit) found.set(time, hit);
      }
      const hits = new Set(found.keys());
      const missing = request.times.filter((time) => !hits.has(time));

      const requestSignal = c.req.raw.signal;
      // Started inside the exclusive task: time spent queued behind another capture is not this capture's time.
      let timeout: AbortSignal | undefined;
      if (missing.length > 0) {
        try {
          const captured = await exclusive(requestSignal, () => {
            timeout = AbortSignal.timeout(CAPTURE_TIMEOUT_MS);
            return capture({
              project,
              composition,
              times: missing,
              width,
              signal: AbortSignal.any([requestSignal, timeout]),
            });
          });
          if ("unavailable" in captured) {
            return c.json(fail("unsupported", captured.unavailable), 400);
          }
          // A write that landed while the capture ran makes the picture belong to a newer project than `fingerprint`:
          // it is still returned, but cached under no key (a revert restores the old signature and would serve it).
          const unchanged = createProjectSignature(project.dir) === fingerprint;
          for (const frame of captured.frames) {
            const entry: CachedFrame = {
              duration: captured.duration,
              capturedAt: frame.capturedAt,
              width: frame.width,
              height: frame.height,
              data: Buffer.from(frame.data).toString("base64"),
            };
            found.set(frame.time, entry);
            if (unchanged) cache.set(keyOf(frame.time), entry);
          }
        } catch (error) {
          if (requestSignal.aborted) return c.json({ error: "aborted" }, 400);
          const reason = error instanceof Error ? error.message : String(error);
          return c.json(
            {
              error: timeout?.aborted
                ? `Capturing frames took longer than ${CAPTURE_TIMEOUT_MS / 1000} s and was stopped`
                : `Capturing frames failed: ${reason}`,
            },
            500,
          );
        }
      }

      const frames: CompositionFrame[] = [];
      let duration = 0;
      for (const time of request.times) {
        const entry = found.get(time);
        if (!entry) return c.json({ error: `The capture returned no frame for ${time}s` }, 500);
        duration = entry.duration;
        frames.push({
          time,
          capturedAt: entry.capturedAt,
          mimeType: "image/jpeg",
          data: entry.data,
          width: entry.width,
          height: entry.height,
          cached: hits.has(time),
        });
      }
      const response: CompositionFramesResponse = { composition, duration, frames };
      return c.json(response);
    },
  );
}
