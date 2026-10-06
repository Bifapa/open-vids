import type { Context, Hono } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { bodyLimit } from "hono/body-limit";
import {
  isDesignSystemId,
  parseRenameDesignSystemRequest,
  parseSaveDesignSystemRequest,
  type DesignError,
} from "@hyperframes/agent-protocol";
import { originMatchesHost } from "../agent/gateway.js";
import { DesignFailure, designStatus, isDesignFailure } from "../design/errors.js";
import { DesignLibrary } from "../design/library.js";
import type { ResolveProjectFile } from "../design/assets.js";
import { listSystemFiles, readRegular } from "../design/store.js";
import { pinWithinProject } from "../helpers/safePath.js";
import { requestSubPath } from "../helpers/requestSubPath.js";
import type { StudioApiAdapter } from "../types.js";

const MAX_SAVE_BYTES = 2 * 1024 * 1024;
const MAX_RENAME_BYTES = 16 * 1024;

/**
 * Every response of a design file: a system's HTML is rendered in an iframe or opened directly, and what it holds was
 * validated at save but is still not trusted to run anything or load anything but its own files.
 */
export const DESIGN_FILE_HEADERS: Record<string, string> = {
  "Content-Security-Policy":
    "sandbox; default-src 'none'; style-src 'unsafe-inline'; font-src 'self'; img-src 'self' data:",
  "X-Content-Type-Options": "nosniff",
  "Cache-Control": "no-cache",
};

const CONTENT_TYPES: Record<string, string> = {
  html: "text/html; charset=utf-8",
  css: "text/css; charset=utf-8",
  svg: "image/svg+xml",
  woff2: "font/woff2",
  woff: "font/woff",
  ttf: "font/ttf",
  otf: "font/otf",
  png: "image/png",
  jpg: "image/jpeg",
  webp: "image/webp",
};

export function designContentType(path: string): string {
  return CONTENT_TYPES[path.split(".").pop() ?? ""] ?? "application/octet-stream";
}

/**
 * Headers of one design file. The showcase runs in a sandboxed iframe, whose origin is opaque: its `@font-face`
 * requests are CORS requests, so only font files answer with a CORS grant (they hold nothing private; the HTML and
 * CSS stay unreadable to other pages).
 */
export function designFileHeaders(path: string): Record<string, string> {
  const type = designContentType(path);
  return {
    ...DESIGN_FILE_HEADERS,
    "Content-Type": type,
    ...(type.startsWith("font/") && { "Access-Control-Allow-Origin": "*" }),
  };
}

const failure = (error: DesignError) => ({ error });

function jsonError(
  c: Context,
  error: DesignError,
  status: ContentfulStatusCode = designStatus(error),
): Response {
  return c.json(failure(error), status);
}

function bodyTooLarge(maxSize: number) {
  return bodyLimit({
    maxSize,
    onError: (c) =>
      c.json(failure({ code: "invalid_request", message: "Request body is too large" }), 400),
  });
}

/** The version a request names (`?version=n`): undefined for the current one. */
function versionOf(c: Context): number | undefined {
  const raw = c.req.query("version");
  if (raw === undefined) return undefined;
  const version = Number(raw);
  if (!Number.isInteger(version) || version < 1)
    throw new DesignFailure("invalid_request", "version must be a positive integer");
  return version;
}

/**
 * The global design-system library (`/design-systems`): list, read, files of a version, create/save a version,
 * rename, delete. Errors are `{ error: DesignError }`; state-changing routes refuse a foreign Origin. Returns the
 * library so the project routes work on the same one.
 */
export function registerDesignRoutes(
  api: Hono,
  adapter: StudioApiAdapter,
  options: { library?: DesignLibrary } = {},
): DesignLibrary {
  const resolveProjectFile: ResolveProjectFile = async (projectId, path) => {
    const project = await adapter.resolveProject(projectId);
    if (!project) return null;
    const absPath = pinWithinProject(project.dir, path);
    return absPath ? { absPath } : null;
  };
  const library = options.library ?? new DesignLibrary(undefined, { resolveProjectFile });

  const route =
    (action: (c: Context) => Promise<Response | object> | Response | object) =>
    async (c: Context): Promise<Response> => {
      try {
        const result = await action(c);
        return result instanceof Response ? result : c.json(result);
      } catch (error) {
        if (isDesignFailure(error)) return jsonError(c, error.error);
        throw error;
      }
    };

  /** A state-changing request from a page on another origin must not edit the user's library. */
  const refuseForeign = async (c: Context, next: () => Promise<void>) => {
    if (!originMatchesHost(c.req.raw))
      return jsonError(
        c,
        { code: "invalid_request", message: "The request Origin does not match its Host." },
        403,
      );
    await next();
    return undefined;
  };

  api.get(
    "/design-systems",
    route(async () => {
      try {
        await library.heal();
      } catch (error) {
        // A write in progress elsewhere keeps the list readable: it shows what is complete.
        if (!isDesignFailure(error)) throw error;
      }
      return { systems: library.list() };
    }),
  );

  api.get(
    "/design-systems/:id",
    route((c) => library.get(c.req.param("id") ?? "", versionOf(c))),
  );

  api.get(
    "/design-systems/:id/files/*",
    route((c) => {
      const id = c.req.param("id") ?? "";
      if (!isDesignSystemId(id))
        throw new DesignFailure("not_found", `There is no design system "${id}".`);
      let path: string;
      try {
        path = requestSubPath(c.req.url, "design-systems/:id/files");
      } catch {
        throw new DesignFailure("invalid_request", "The file path is malformed.");
      }
      const folder = library.versionDir(id, versionOf(c));
      const bytes = listSystemFiles(folder).includes(path)
        ? readRegular(`${folder}/${path}`)
        : null;
      if (bytes === null) throw new DesignFailure("not_found", `There is no file "${path}".`);
      return new Response(new Uint8Array(bytes), {
        headers: designFileHeaders(path),
      });
    }),
  );

  api.put(
    "/design-systems/:id",
    bodyTooLarge(MAX_SAVE_BYTES),
    refuseForeign,
    route(async (c) => {
      const body: unknown = await c.req.json().catch(() => undefined);
      const parsed = parseSaveDesignSystemRequest(body);
      if (!parsed.ok) throw new DesignFailure(parsed.error.code, parsed.error.message);
      return library.save(c.req.param("id") ?? "", parsed.value);
    }),
  );

  api.patch(
    "/design-systems/:id",
    bodyTooLarge(MAX_RENAME_BYTES),
    refuseForeign,
    route(async (c) => {
      const body: unknown = await c.req.json().catch(() => undefined);
      const parsed = parseRenameDesignSystemRequest(body);
      if (!parsed.ok) throw new DesignFailure(parsed.error.code, parsed.error.message);
      return library.rename(c.req.param("id") ?? "", parsed.value.name);
    }),
  );

  api.delete(
    "/design-systems/:id",
    refuseForeign,
    route(async (c) => {
      await library.delete(c.req.param("id") ?? "");
      return { ok: true };
    }),
  );

  return library;
}
