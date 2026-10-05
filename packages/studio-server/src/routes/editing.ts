import { statSync } from "node:fs";
import type { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import {
  ASSET_RANGES_PATH,
  ASSET_RANGE_MIN_SECONDS,
  PRESET_KINDS,
  parseApplyEditsRequest,
  isRecord,
  parseSetAssetRangeRequest,
  type AssetRange,
  type AssetRangesView,
  type EditError,
  type PresetKind,
  type SetAssetRangeRequest,
} from "@hyperframes/agent-protocol";
import { effectiveRange, readAssetRanges, writeAssetRanges } from "../editing/assetRanges.js";
import { EditFailure, isEditFailure } from "../editing/errors.js";
import { MAIN_COMPOSITION, readInventory } from "../editing/inventory.js";
import { MediaFacts, type MediaProber } from "../editing/mediaFacts.js";
import { applyEdits, MEDIA_OVERRUN_TOLERANCE } from "../editing/operations.js";
import type { AnalysisService } from "../analysis/service.js";
import { MAX_PRESETS, pagePresets } from "../editing/presets.js";
import { cancelRunning, trackRunning } from "../editing/replay.js";
import { serializedEdits } from "../editing/queue.js";
import { normalizeCompositionPath, probeProjectFile, readTimeline } from "../editing/service.js";
import { resolveProjectRelative } from "../editing/timeline.js";
import { resolveWithinProject } from "../helpers/safePath.js";
import type { ResolvedProject, StudioApiAdapter } from "../types.js";

const MAX_BODY_BYTES = 2 * 1024 * 1024;
const USER_RANGE_LABEL = "Picked asset fragment";
const USER_RANGE_KEY = "asset-ranges";
const USER_RANGE_IDLE_MS = 4_000;

const seconds = (value: number) => String(Math.round(value * 1000) / 1000);

function statusOf(error: EditError): 400 | 404 | 409 {
  if (error.code === "conflict") return 409;
  if (error.code === "unknown_asset" && error.opIndex === undefined) return 404;
  return 400;
}

function presetKindOf(value: string | undefined): PresetKind | null | undefined {
  if (value === undefined || value === "") return undefined;
  return PRESET_KINDS.find((kind) => kind === value) ?? null;
}

/** Whether the project holds a regular file at this project-relative path right now. */
function fileInProject(projectDir: string, path: string): boolean {
  const abs = resolveWithinProject(projectDir, path);
  if (!abs) return false;
  try {
    return statSync(abs).isFile();
  } catch {
    return false;
  }
}

function sameRanges(
  a: ReadonlyMap<string, AssetRange>,
  b: ReadonlyMap<string, AssetRange>,
): boolean {
  if (a.size !== b.size) return false;
  for (const [path, range] of a) {
    const other = b.get(path);
    if (!other || other.start !== range.start || other.end !== range.end) return false;
  }
  return true;
}

/**
 * The picks as they apply to the files as they are now: entries of gone files or of files that are no longer video
 * or audio are dropped, a range on a shortened file is clamped to its length.
 */
async function rangesView(project: ResolvedProject, facts: MediaFacts): Promise<AssetRangesView> {
  const stored = readAssetRanges(project.dir);
  const paths = [...stored.keys()].sort();
  const probed = await facts.readMany(project.dir, paths);
  const ranges: Record<string, AssetRange> = {};
  for (const path of paths) {
    const asset = probed.get(path);
    if (!asset || (asset.kind !== "video" && asset.kind !== "audio")) continue;
    const effective = effectiveRange(stored.get(path), asset.duration);
    if (effective) ranges[path] = effective;
  }
  return { ranges };
}

/**
 * The range as it is stored: clamped to the file's length, `null` when it covers the whole file (within the same
 * frame-rounding slack the editing service allows, so "everything usable" is stored as no pick at all).
 */
function checkedRange(path: string, range: AssetRange, duration: number | null): AssetRange | null {
  if (duration === null) {
    throw new EditFailure(
      "unsupported",
      `The length of ${path} could not be read (is ffprobe installed?); a range cannot be checked against it`,
    );
  }
  if (range.start >= duration) {
    throw new EditFailure(
      "out_of_bounds",
      `range.start ${seconds(range.start)}s is at or past the end of ${path} (${seconds(duration)}s)`,
    );
  }
  if (range.end > duration + MEDIA_OVERRUN_TOLERANCE) {
    throw new EditFailure(
      "out_of_bounds",
      `range.end ${seconds(range.end)}s runs past the end of ${path} (${seconds(duration)}s)`,
    );
  }
  const end = Math.min(range.end, duration);
  if (end - range.start < ASSET_RANGE_MIN_SECONDS - 1e-6) {
    throw new EditFailure(
      "out_of_bounds",
      `The range must leave at least ${ASSET_RANGE_MIN_SECONDS}s of ${path}`,
    );
  }
  if (range.start <= MEDIA_OVERRUN_TOLERANCE && end >= duration - MEDIA_OVERRUN_TOLERANCE)
    return null;
  return { start: range.start, end };
}

/**
 * Files the user's pick in project history as "You", the way Story user saves do: the write is already on disk, so
 * the claim sweeps it up; a burst of handle drags merges into one entry while the key is held.
 */
async function claimUserRange(adapter: StudioApiAdapter, project: ResolvedProject): Promise<void> {
  try {
    const history = await adapter.history?.(project);
    await history?.claim({ kind: "person", name: "You" }, USER_RANGE_LABEL, [ASSET_RANGES_PATH], {
      coalesceKey: USER_RANGE_KEY,
      idleMs: USER_RANGE_IDLE_MS,
    });
  } catch {
    // History is best effort: the pick itself already happened.
  }
}

/** Applies one `PUT /editing/ranges` inside the project's edit queue and answers the fresh view. */
async function setAssetRange(
  project: ResolvedProject,
  request: SetAssetRangeRequest,
  adapter: StudioApiAdapter,
  facts: MediaFacts,
): Promise<AssetRangesView> {
  const path = resolveProjectRelative(MAIN_COMPOSITION, request.path);
  const asset = path === null ? null : await facts.read(project.dir, path);
  if (path === null || !asset) {
    throw new EditFailure("unknown_asset", `No file "${request.path}" in this project`);
  }
  if (asset.kind !== "video" && asset.kind !== "audio") {
    throw new EditFailure(
      "unsupported",
      `"${path}" is a ${asset.kind} file; asset ranges pick a fragment of a video or audio file`,
    );
  }
  const stored = readAssetRanges(project.dir);
  const next = new Map(stored);
  for (const known of next.keys()) {
    if (!fileInProject(project.dir, known)) next.delete(known);
  }
  const range = request.range === null ? null : checkedRange(path, request.range, asset.duration);
  if (range === null) next.delete(path);
  else next.set(path, range);
  if (!sameRanges(stored, next)) {
    writeAssetRanges(project.dir, next);
    await claimUserRange(adapter, project);
  }
  return rangesView(project, facts);
}

/**
 * The editing capability layer: what a project holds, its timeline, and edits applied to it as one atomic batch.
 * Agents (through the runtime's editing tools) and any other client speak the `@hyperframes/agent-protocol`
 * editing contract; the files change on disk, so Studio and the project history see them like any outside edit.
 */
export function registerEditingRoutes(
  api: Hono,
  adapter: StudioApiAdapter,
  options: { probe?: MediaProber; analysis?: Pick<AnalysisService, "sourceData"> } = {},
): void {
  const facts = new MediaFacts(options.probe);

  api.get("/projects/:id/editing/project", async (c) => {
    const project = await adapter.resolveProject(c.req.param("id"));
    if (!project) return c.json({ error: "not found" }, 404);
    return c.json(await readInventory(project, adapter, facts));
  });

  api.get("/projects/:id/editing/timeline", async (c) => {
    const project = await adapter.resolveProject(c.req.param("id"));
    if (!project) return c.json({ error: "not found" }, 404);
    try {
      const path = normalizeCompositionPath(c.req.query("composition"));
      return c.json(await readTimeline(project, path, facts));
    } catch (error) {
      if (isEditFailure(error)) return c.json({ error: error.error }, statusOf(error.error));
      throw error;
    }
  });

  api.get("/projects/:id/editing/probe", async (c) => {
    const project = await adapter.resolveProject(c.req.param("id"));
    if (!project) return c.json({ error: "not found" }, 404);
    try {
      return c.json(await probeProjectFile(project, c.req.query("path") ?? "", facts));
    } catch (error) {
      if (isEditFailure(error)) return c.json({ error: error.error }, statusOf(error.error));
      throw error;
    }
  });

  api.get("/projects/:id/editing/presets", async (c) => {
    const project = await adapter.resolveProject(c.req.param("id"));
    if (!project) return c.json({ error: "not found" }, 404);
    const kind = presetKindOf(c.req.query("kind"));
    if (kind === null) {
      const error: EditError = {
        code: "invalid_request",
        message: `kind must be one of ${PRESET_KINDS.join(", ")}`,
      };
      return c.json({ error }, 400);
    }
    const offset = Math.max(0, Number.parseInt(c.req.query("offset") ?? "0", 10) || 0);
    const limit = Math.min(
      MAX_PRESETS,
      Math.max(1, Number.parseInt(c.req.query("limit") ?? String(MAX_PRESETS), 10) || MAX_PRESETS),
    );
    return c.json(
      await pagePresets(adapter, { kind, query: c.req.query("query") }, { offset, limit }),
    );
  });

  api.get("/projects/:id/editing/ranges", async (c) => {
    const project = await adapter.resolveProject(c.req.param("id"));
    if (!project) return c.json({ error: "not found" }, 404);
    return c.json(await rangesView(project, facts));
  });

  api.put("/projects/:id/editing/ranges", async (c) => {
    const project = await adapter.resolveProject(c.req.param("id"));
    if (!project) return c.json({ error: "not found" }, 404);
    const body: unknown = await c.req.json().catch(() => undefined);
    const parsed = parseSetAssetRangeRequest(body);
    if (!parsed.ok) return c.json({ error: parsed.error }, 400);
    try {
      return c.json(
        await serializedEdits(project.dir, () =>
          setAssetRange(project, parsed.value, adapter, facts),
        ),
      );
    } catch (error) {
      if (error instanceof EditFailure)
        return c.json({ error: error.error }, statusOf(error.error));
      throw error;
    }
  });

  api.post(
    "/projects/:id/editing/apply",
    bodyLimit({
      maxSize: MAX_BODY_BYTES,
      onError: (c) =>
        c.json(
          {
            error: {
              code: "invalid_request",
              message: "Request body is too large",
            } satisfies EditError,
          },
          400,
        ),
    }),
    async (c) => {
      const project = await adapter.resolveProject(c.req.param("id"));
      if (!project) return c.json({ error: "not found" }, 404);
      const body: unknown = await c.req.json().catch(() => undefined);
      const parsed = parseApplyEditsRequest(body);
      if (!parsed.ok) return c.json({ error: parsed.error }, 400);
      const request = parsed.value;
      let compositionPath: string;
      try {
        compositionPath = normalizeCompositionPath(request.composition);
      } catch (error) {
        if (error instanceof EditFailure)
          return c.json({ error: error.error }, statusOf(error.error));
        throw error;
      }
      // A client that disconnects, or a cancel request for the id, stops the batch before it writes.
      const tracked =
        request.requestId === undefined
          ? null
          : trackRunning(project.dir, compositionPath, request.requestId);
      const signal = AbortSignal.any(
        tracked ? [tracked.controller.signal, c.req.raw.signal] : [c.req.raw.signal],
      );
      try {
        const response = await serializedEdits(project.dir, () =>
          applyEdits(
            {
              project,
              compositionPath,
              adapter,
              facts,
              ...(options.analysis && { analysis: options.analysis }),
            },
            request,
            { signal },
          ),
        );
        return c.json(response);
      } catch (error) {
        if (error instanceof EditFailure)
          return c.json({ error: error.error }, statusOf(error.error));
        throw error;
      } finally {
        tracked?.done();
      }
    },
  );

  api.post("/projects/:id/editing/cancel", async (c) => {
    const project = await adapter.resolveProject(c.req.param("id"));
    if (!project) return c.json({ error: "not found" }, 404);
    const body: unknown = await c.req.json().catch(() => undefined);
    const requestId = isRecord(body) && typeof body.requestId === "string" ? body.requestId : "";
    return c.json({ cancelled: requestId !== "" && cancelRunning(project.dir, requestId) });
  });
}
