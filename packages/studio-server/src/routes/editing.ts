import type { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import {
  PRESET_KINDS,
  parseApplyEditsRequest,
  type EditError,
  type PresetKind,
} from "@hyperframes/agent-protocol";
import { EditFailure, isEditFailure } from "../editing/errors.js";
import { readInventory } from "../editing/inventory.js";
import { MediaFacts, type MediaProber } from "../editing/mediaFacts.js";
import { applyEdits } from "../editing/operations.js";
import { listPresets } from "../editing/presets.js";
import { normalizeCompositionPath, probeProjectFile, readTimeline } from "../editing/service.js";
import type { StudioApiAdapter } from "../types.js";

const MAX_BODY_BYTES = 2 * 1024 * 1024;

/** Batches on one project run one at a time: each is a read-modify-write of the same composition file. */
const queues = new Map<string, Promise<unknown>>();

function serialized<T>(key: string, task: () => Promise<T>): Promise<T> {
  const run = (queues.get(key) ?? Promise.resolve()).then(task, task);
  const settled = run.catch(() => undefined);
  queues.set(key, settled);
  void settled.then(() => {
    if (queues.get(key) === settled) queues.delete(key);
  });
  return run;
}

function statusOf(error: EditError): 400 | 404 | 409 {
  if (error.code === "conflict") return 409;
  if (error.code === "unknown_asset" && error.opIndex === undefined) return 404;
  return 400;
}

function presetKindOf(value: string | undefined): PresetKind | null | undefined {
  if (value === undefined || value === "") return undefined;
  return PRESET_KINDS.find((kind) => kind === value) ?? null;
}

/**
 * The editing capability layer: what a project holds, its timeline, and edits applied to it as one atomic batch.
 * Agents (through the runtime's editing tools) and any other client speak the `@hyperframes/agent-protocol`
 * editing contract; the files change on disk, so Studio and the project history see them like any outside edit.
 */
export function registerEditingRoutes(
  api: Hono,
  adapter: StudioApiAdapter,
  options: { probe?: MediaProber } = {},
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
    return c.json({ presets: await listPresets(adapter, { kind, query: c.req.query("query") }) });
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
      try {
        const request = parsed.value;
        const compositionPath = normalizeCompositionPath(request.composition);
        const response = await serialized(project.dir, () =>
          applyEdits({ project, compositionPath, adapter, facts }, request),
        );
        return c.json(response);
      } catch (error) {
        if (error instanceof EditFailure)
          return c.json({ error: error.error }, statusOf(error.error));
        throw error;
      }
    },
  );
}
