import type { Context } from "hono";
import { createHash, timingSafeEqual } from "node:crypto";
import { realpath, stat } from "node:fs/promises";
import { isAbsolute } from "node:path";
import type { AgentErrorCode, ChatEvent, ProjectEvent } from "@hyperframes/agent-protocol";
import {
  AGENT_HEADERS,
  AGENT_RUNTIME_PREFIX,
  SSE_EVENTS,
  decodeScopeHeader,
  encodeSseMessage,
  isOAuthLoginId,
  isProviderId,
} from "@hyperframes/agent-protocol";
import type { ProjectScope } from "./checkpointHost.js";
import { RuntimeError, errorMessage } from "./errors.js";

const LOOPBACK_HOSTS: Record<string, true> = { localhost: true, "::1": true, "[::1]": true };

/** Routes that never touch a project: Home calls them before any project is open (token only). */
export function isGlobalRoute(path: string): boolean {
  if (!path.startsWith(`${AGENT_RUNTIME_PREFIX}/`)) return false;
  const rest = path.slice(AGENT_RUNTIME_PREFIX.length + 1);
  return (
    rest === "health" ||
    rest === "models" ||
    rest === "project-title" ||
    rest === "providers" ||
    rest === "providers/refresh" ||
    /^providers\/[^/]+\/models$/.test(rest) ||
    /^providers\/[^/]+\/api-key$/.test(rest) ||
    /^providers\/[^/]+\/oauth\/(?:login|logout)$/.test(rest) ||
    /^oauth\/logins\/[^/]+(?:\/(?:input|cancel))?$/.test(rest) ||
    rest === "settings" ||
    rest === "settings/jev/api-key" ||
    rest === "settings/jev/test"
  );
}

export function providerParam(context: Context): string {
  const provider = context.req.param("provider");
  if (!provider || !isProviderId(provider))
    throw new RuntimeError("invalid_request", "Provider id is not valid", 400);
  return provider;
}

export function loginParam(context: Context): string {
  const loginId = context.req.param("loginId");
  if (!loginId || !isOAuthLoginId(loginId))
    throw new RuntimeError("login_not_found", "This sign-in was not found", 404);
  return loginId;
}

export async function resolveScope(headers: Headers): Promise<ProjectScope> {
  const projectId = decodeScopeHeader(headers.get(AGENT_HEADERS.projectId))?.trim();
  const projectDir = decodeScopeHeader(headers.get(AGENT_HEADERS.projectDir));
  const studioOrigin = headers.get(AGENT_HEADERS.studioOrigin);
  if (!projectId || !projectDir || !studioOrigin)
    throw new RuntimeError("invalid_request", "Project scope headers are required", 400);
  if (!isAbsolute(projectDir))
    throw new RuntimeError("invalid_request", "Project directory must be absolute", 400);
  let canonicalDir: string;
  try {
    canonicalDir = await realpath(projectDir);
    const info = await stat(canonicalDir);
    if (!info.isDirectory()) throw new Error("not a directory");
  } catch {
    throw new RuntimeError(
      "invalid_request",
      "Project directory must exist and be a directory",
      400,
    );
  }
  let parsedOrigin: URL;
  try {
    parsedOrigin = new URL(studioOrigin);
  } catch {
    throw new RuntimeError(
      "invalid_request",
      "Studio origin must be an http(s) loopback origin",
      400,
    );
  }
  const hostname = parsedOrigin.hostname.toLowerCase();
  if (
    (parsedOrigin.protocol !== "http:" && parsedOrigin.protocol !== "https:") ||
    (!Object.hasOwn(LOOPBACK_HOSTS, hostname) && !isIpv4Loopback(hostname)) ||
    parsedOrigin.username ||
    parsedOrigin.password ||
    parsedOrigin.pathname !== "/" ||
    parsedOrigin.search ||
    parsedOrigin.hash ||
    (studioOrigin !== parsedOrigin.origin && studioOrigin !== `${parsedOrigin.origin}/`)
  ) {
    throw new RuntimeError(
      "invalid_request",
      "Studio origin must be an http(s) loopback origin",
      400,
    );
  }
  return { projectId, projectDir: canonicalDir, studioOrigin: parsedOrigin.origin };
}

function isIpv4Loopback(hostname: string): boolean {
  const parts = hostname.split(".");
  if (parts.length !== 4 || parts[0] !== "127") return false;
  return parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255);
}

export function authorized(header: string | undefined, token: string): boolean {
  const candidate = header?.startsWith("Bearer ") ? header.slice(7) : "";
  const expectedHash = createHash("sha256").update(token).digest();
  const candidateHash = createHash("sha256").update(candidate).digest();
  return (
    timingSafeEqual(expectedHash, candidateHash) &&
    candidate.length > 0 &&
    header?.startsWith("Bearer ") === true
  );
}

export function parseSequence(value: string): number {
  if (!/^(0|[1-9]\d*)$/.test(value))
    throw new RuntimeError("invalid_request", "Event sequence must be a non-negative integer", 400);
  const result = Number(value);
  if (!Number.isSafeInteger(result))
    throw new RuntimeError("invalid_request", "Event sequence is out of range", 400);
  return result;
}

export async function readBody(context: Context): Promise<unknown> {
  let body: string;
  try {
    body = await context.req.raw.text();
  } catch {
    throw new RuntimeError("invalid_request", "Request body must be valid JSON", 400);
  }
  if (!body.trim()) return undefined;
  try {
    const parsed: unknown = JSON.parse(body);
    return parsed;
  } catch {
    throw new RuntimeError("invalid_request", "Request body must be valid JSON", 400);
  }
}

export function chatFrame(event: ChatEvent): string {
  return encodeSseMessage({
    id: String(event.seq),
    event: SSE_EVENTS.chat,
    data: JSON.stringify(event),
  });
}

export function projectFrame(event: ProjectEvent): string {
  return encodeSseMessage({ event: SSE_EVENTS.project, data: JSON.stringify(event) });
}

export function sseHeaders(): HeadersInit {
  return {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
  };
}

export function sendError(context: Context, error: unknown): Response {
  const runtimeError =
    error instanceof RuntimeError
      ? error
      : new RuntimeError("internal", errorMessage(error, "Internal runtime error"), 500);
  const errorBody = {
    error: {
      code: runtimeError.code satisfies AgentErrorCode,
      message: runtimeError.message,
      ...(runtimeError.details && { details: runtimeError.details }),
    },
  };
  if (runtimeError.status === 400) return context.json(errorBody, 400);
  if (runtimeError.status === 401) return context.json(errorBody, 401);
  if (runtimeError.status === 404) return context.json(errorBody, 404);
  if (runtimeError.status === 409) return context.json(errorBody, 409);
  if (runtimeError.status === 502) return context.json(errorBody, 502);
  if (runtimeError.status === 503) return context.json(errorBody, 503);
  return context.json(errorBody, 500);
}
