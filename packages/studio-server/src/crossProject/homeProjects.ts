import { readFileSync, statSync } from "node:fs";
import { isAbsolute } from "node:path";
import { isExternalProjectList, isRecord } from "@hyperframes/agent-protocol";
import type { ExternalProject, ExternalProjectLocation, StudioApiAdapter } from "../types.js";

type ExternalProjects = NonNullable<StudioApiAdapter["externalProjects"]>;

/** How long one request to the home server may take: it answers from memory on the same machine. */
const TIMEOUT_MS = 2_000;
/** The home server's answers are small; anything bigger is not it. */
const MAX_BODY_CHARS = 1024 * 1024;
const MAX_PROJECTS = 500;
const MAX_KEY_CHARS = 64;
const MAX_NAME_CHARS = 200;
const LOOPBACK_HOSTS: Record<string, true> = { "127.0.0.1": true, "[::1]": true, localhost: true };

interface HomeLink {
  origin: string;
  secret: string;
}

export interface HomeProjectsOptions {
  /** The HTTP client (tests inject a fake); default: the global `fetch`. */
  fetch?: typeof fetch;
  timeoutMs?: number;
}

/** The origin of a plain-http loopback URL, else null: the secret is only ever sent to this machine. */
function loopbackOrigin(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  const local = url.protocol === "http:" && LOOPBACK_HOSTS[url.hostname] === true;
  return local && url.username === "" && url.password === "" ? url.origin : null;
}

function linkOf(url: unknown, secret: unknown): HomeLink | null {
  const origin = loopbackOrigin(url);
  return origin !== null && typeof secret === "string" && secret !== "" ? { origin, secret } : null;
}

/** The link the dev shell wrote: `{ "url", "secret" }`, a new one on every launch of the app. */
function linkFromFile(file: string): HomeLink | null {
  try {
    const raw: unknown = JSON.parse(readFileSync(file, "utf-8"));
    return isRecord(raw) ? linkOf(raw.url, raw.secret) : null;
  } catch {
    return null;
  }
}

function isDirectory(path: string): boolean {
  try {
    return isAbsolute(path) && statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/**
 * The `externalProjects` capability served by the desktop shell's home server, over loopback and with the shell's
 * per-launch secret (`x-openvids-secret`). The sidecar gets `OPENVIDS_HOME_URL` and `OPENVIDS_HOME_SECRET`; the dev
 * server, started before the app, gets `OPENVIDS_HOME_FILE` instead — a JSON file the shell writes once its home
 * server is up, read again on every call. Null when the host offers none of them (or the URL is not loopback http),
 * so a plain `hyperframes preview` has no project list. A home server that cannot be reached or answers something
 * else is an empty list / an unknown project, never an error.
 */
export function createHomeExternalProjects(
  env: Record<string, string | undefined>,
  options: HomeProjectsOptions = {},
): ExternalProjects | null {
  const http = options.fetch ?? fetch;
  const timeoutMs = options.timeoutMs ?? TIMEOUT_MS;
  let link: () => HomeLink | null;
  if (env.OPENVIDS_HOME_URL !== undefined || env.OPENVIDS_HOME_SECRET !== undefined) {
    const fixed = linkOf(env.OPENVIDS_HOME_URL, env.OPENVIDS_HOME_SECRET);
    if (!fixed) return null;
    link = () => fixed;
  } else if (env.OPENVIDS_HOME_FILE) {
    const file = env.OPENVIDS_HOME_FILE;
    link = () => linkFromFile(file);
  } else {
    return null;
  }

  /** The parsed JSON body of `path` and its status; null when the home server is unreachable or answers nonsense. */
  const get = async (path: string): Promise<{ status: number; body: unknown } | null> => {
    const home = link();
    if (!home) return null;
    try {
      const response = await http(`${home.origin}${path}`, {
        headers: { "x-openvids-secret": home.secret },
        redirect: "error",
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!response.ok) return { status: response.status, body: null };
      const text = await response.text();
      if (text.length > MAX_BODY_CHARS) return null;
      const body: unknown = JSON.parse(text);
      return { status: response.status, body };
    } catch {
      return null;
    }
  };

  return {
    async list(): Promise<ExternalProject[]> {
      const answer = await get("/internal/projects");
      if (!answer || !isExternalProjectList(answer.body)) return [];
      return answer.body.projects
        .filter((entry) => entry.key.length > 0 && entry.key.length <= MAX_KEY_CHARS)
        .slice(0, MAX_PROJECTS)
        .map((entry) => ({
          key: entry.key,
          name: entry.name.slice(0, MAX_NAME_CHARS),
          ...(entry.openedAt !== undefined && { openedAt: entry.openedAt }),
        }));
    },

    async resolve(key: string): Promise<ExternalProjectLocation | null> {
      if (key.length === 0 || key.length > MAX_KEY_CHARS) return null;
      const answer = await get(`/internal/projects/${encodeURIComponent(key)}`);
      const body = answer?.body;
      if (
        !isRecord(body) ||
        body.key !== key ||
        typeof body.name !== "string" ||
        typeof body.dir !== "string" ||
        !isDirectory(body.dir)
      ) {
        return null;
      }
      return { key, name: body.name.slice(0, MAX_NAME_CHARS), dir: body.dir };
    },
  };
}
