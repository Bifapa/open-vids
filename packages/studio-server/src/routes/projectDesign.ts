import { existsSync, lstatSync } from "node:fs";
import type { Context, Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { VIDEO_EXT } from "@hyperframes/core/media-types";
import {
  VIDEO_PALETTE_LIMITS,
  parseAttachDesignRequest,
  type DesignError,
  type VideoPalette,
} from "@hyperframes/agent-protocol";
import { originMatchesHost } from "../agent/gateway.js";
import { DesignFailure, designStatus, isDesignFailure } from "../design/errors.js";
import { extractExternalProjectDesign, extractProjectDesign } from "../design/extract.js";
import type { DesignLibrary } from "../design/library.js";
import { extractVideoPalette } from "../design/palette.js";
import {
  PROJECT_DESIGN_DIR,
  attachDesign,
  detachDesign,
  projectSnapshotFiles,
  readProjectDesignState,
  updateDesign,
} from "../design/snapshot.js";
import { locateExternalProject } from "../crossProject/service.js";
import { fileResponse } from "../helpers/fileResponse.js";
import { probeMediaMetadata } from "../helpers/mediaMetadata.js";
import { requestSubPath } from "../helpers/requestSubPath.js";
import { pinWithinProject } from "../helpers/safePath.js";
import type { ResolvedProject, StudioApiAdapter } from "../types.js";
import { designFileHeaders } from "./design.js";

const MAX_BODY_BYTES = 16 * 1024;

export interface ProjectDesignRouteOptions {
  /** Media prober for a video's duration (tests). */
  probe?: typeof probeMediaMetadata;
  /** ffmpeg binary override (tests). */
  ffmpegPath?: string;
}

function failure(code: DesignError["code"], message: string): { error: DesignError } {
  return { error: { code, message } };
}

function isFile(path: string): boolean {
  try {
    return lstatSync(path).isFile();
  } catch {
    return false;
  }
}

function sampleCount(raw: string | undefined): number {
  if (raw === undefined || raw === "") return VIDEO_PALETTE_LIMITS.defaultSamples;
  const count = Number(raw);
  if (
    !Number.isInteger(count) ||
    count < VIDEO_PALETTE_LIMITS.minSamples ||
    count > VIDEO_PALETTE_LIMITS.maxSamples
  ) {
    throw new DesignFailure(
      "invalid_request",
      `samples must be a whole number from ${VIDEO_PALETTE_LIMITS.minSamples} to ${VIDEO_PALETTE_LIMITS.maxSamples}`,
    );
  }
  return count;
}

/**
 * The project side of design systems: the project's snapshot (`design/` — state, attach, update, detach), the
 * deterministic extraction of what its compositions use, the snapshot's files for the preview iframe, and the exact
 * dominant colours of a video. Errors are `{ error: DesignError }`.
 */
export function registerProjectDesignRoutes(
  api: Hono,
  adapter: StudioApiAdapter,
  library: DesignLibrary,
  options: ProjectDesignRouteOptions = {},
): void {
  const probe = options.probe ?? probeMediaMetadata;

  /** Resolves the project, runs the action and turns a refusal into its HTTP answer. */
  const route =
    (
      action: (project: ResolvedProject, c: Context) => Promise<Response | object>,
      mutating = false,
    ) =>
    async (c: Context) => {
      if (mutating && !originMatchesHost(c.req.raw)) {
        return c.json(
          failure("invalid_request", "The request Origin does not match its Host."),
          403,
        );
      }
      const project = await adapter.resolveProject(c.req.param("id") ?? "");
      if (!project || !existsSync(project.dir)) {
        return c.json(failure("not_found", "Project not found"), 404);
      }
      try {
        const result = await action(project, c);
        return result instanceof Response ? result : c.json(result);
      } catch (error) {
        if (isDesignFailure(error))
          return c.json({ error: error.error }, designStatus(error.error));
        throw error;
      }
    };

  const tooLarge = bodyLimit({
    maxSize: MAX_BODY_BYTES,
    onError: (c) => c.json(failure("invalid_request", "Request body is too large"), 400),
  });

  api.get(
    "/projects/:id/design",
    route((project) => readProjectDesignState(project.dir, library)),
  );

  api.put(
    "/projects/:id/design",
    tooLarge,
    route(async (project, c) => {
      const body: unknown = await c.req.json().catch(() => undefined);
      const parsed = parseAttachDesignRequest(body);
      if (!parsed.ok) throw new DesignFailure(parsed.error.code, parsed.error.message);
      return attachDesign(project.dir, library, parsed.value.id);
    }, true),
  );

  api.post(
    "/projects/:id/design/update",
    route((project) => updateDesign(project.dir, library), true),
  );

  api.delete(
    "/projects/:id/design",
    route((project) => detachDesign(project.dir, library), true),
  );

  api.get(
    "/projects/:id/design/extract",
    route((project) => extractProjectDesign(project.dir)),
  );

  // Another project of the Projects page (the `externalProjects` capability), addressed by the host's key: its
  // folder never leaves the server, and the open project is not "another" project.
  api.get(
    "/projects/:id/design/extract/external/:key",
    route(async (project, c) => {
      const other = await locateExternalProject(adapter, project, c.req.param("key") ?? "");
      if (!other)
        throw new DesignFailure("not_found", "No such project: it is not one the user has opened");
      return extractExternalProjectDesign(other.root);
    }),
  );

  api.get(
    "/projects/:id/design/files/*",
    route(async (project, c) => {
      const sub = requestSubPath(c.req.url, "projects/:id/design/files");
      if (sub === "" || sub.includes("\0")) {
        throw new DesignFailure("invalid_request", "A file path is required");
      }
      // Only what the snapshot itself installed: other files under design/ are the user's and never leave here.
      if (!projectSnapshotFiles(project.dir).includes(`${PROJECT_DESIGN_DIR}/${sub}`))
        throw new DesignFailure("not_found", `design/${sub} is not part of the project's snapshot`);
      const designDir = pinWithinProject(project.dir, PROJECT_DESIGN_DIR);
      const abs = designDir === null ? null : pinWithinProject(designDir, sub);
      if (abs === null) throw new DesignFailure("invalid_request", "Path is outside design/");
      if (!isFile(abs)) throw new DesignFailure("not_found", `design/${sub} is not in the project`);
      return fileResponse(abs, c.req.header("range"), designFileHeaders(abs));
    }),
  );

  api.get(
    "/projects/:id/design/video-palette",
    route(async (project, c): Promise<VideoPalette> => {
      const video = c.req.query("video") ?? "";
      if (video.trim() === "" || video.includes("\0")) {
        throw new DesignFailure("invalid_request", 'Query parameter "video" is required');
      }
      const samples = sampleCount(c.req.query("samples"));
      const abs = pinWithinProject(project.dir, video);
      if (abs === null) {
        throw new DesignFailure("invalid_request", `"${video}" is outside the project`);
      }
      if (!VIDEO_EXT.test(video)) {
        throw new DesignFailure("invalid_request", `"${video}" is not a video file`);
      }
      if (!isFile(abs)) throw new DesignFailure("not_found", `No video "${video}" in this project`);
      const metadata = await probe(abs);
      const durationSec = metadata.durationSeconds ?? 0;
      const { colors, frames } = await extractVideoPalette(abs, {
        frames: samples,
        durationSec: durationSec > 0 ? durationSec : null,
        signal: c.req.raw.signal,
        ...(options.ffmpegPath !== undefined && { ffmpegPath: options.ffmpegPath }),
      });
      return { video, durationSec, samples: frames, colors };
    }),
  );
}
