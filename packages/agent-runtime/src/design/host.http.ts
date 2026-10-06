import {
  isDesignError,
  isDesignSystemDetail,
  isDesignSystemSummary,
  isProjectDesignExtraction,
  isProjectDesignState,
  isRecord,
  isSaveDesignSystemResult,
  isVideoPalette,
  type AttachDesignRequest,
  type DesignSystemDetail,
  type DesignSystemSummary,
  type ProjectDesignExtraction,
  type ProjectDesignState,
  type SaveDesignSystemRequest,
  type SaveDesignSystemResult,
  type VideoPalette,
} from "@hyperframes/agent-protocol";
import type { ProjectScope } from "../checkpointHost.js";
import { DesignToolError, type DesignHost, type DesignSnapshot } from "./host.js";
import { parseManifestHtml, parseRootTokens } from "./snapshot.js";

/**
 * A save that reached the service is atomic there and is awaited to its end (the turn's checkpoint must not close under
 * it, so a write ignores the turn's abort signal); it may download font files, so the ceiling is generous. A palette
 * decodes several frames of a video.
 */
const SAVE_TIMEOUT_MS = 180_000;
const PALETTE_TIMEOUT_MS = 120_000;

type Method = "GET" | "PUT";

interface RequestOptions {
  body?: unknown;
  signal: AbortSignal;
}

/** Studio's design HTTP API (`/api/design-systems/*` and `/api/projects/:id/design/*`) for one project. */
export class HttpDesignHost implements DesignHost {
  private readonly library: string;
  private readonly project: string;

  constructor(scope: ProjectScope) {
    this.library = `${scope.studioOrigin}/api/design-systems`;
    this.project = `${scope.studioOrigin}/api/projects/${encodeURIComponent(scope.projectId)}/design`;
  }

  async list(signal: AbortSignal): Promise<DesignSystemSummary[]> {
    const payload = await this.json("GET", this.library, { signal });
    if (!isRecord(payload) || !Array.isArray(payload.systems)) throw invalidResponse("list");
    const systems: DesignSystemSummary[] = [];
    for (const system of payload.systems) {
      if (!isDesignSystemSummary(system)) throw invalidResponse("system summary");
      systems.push(system);
    }
    return systems;
  }

  async get(
    id: string,
    version: number | undefined,
    signal: AbortSignal,
  ): Promise<DesignSystemDetail> {
    const query = version === undefined ? "" : `?${new URLSearchParams({ version: `${version}` })}`;
    const payload = await this.json("GET", `${this.library}/${encodeURIComponent(id)}${query}`, {
      signal,
    });
    if (!isDesignSystemDetail(payload)) throw invalidResponse("design system");
    return payload;
  }

  async save(
    id: string,
    request: SaveDesignSystemRequest,
    signal: AbortSignal,
  ): Promise<SaveDesignSystemResult> {
    if (signal.aborted) throw aborted();
    const payload = await this.json("PUT", `${this.library}/${encodeURIComponent(id)}`, {
      body: request,
      signal: AbortSignal.timeout(SAVE_TIMEOUT_MS),
    });
    if (!isSaveDesignSystemResult(payload)) throw invalidResponse("save result");
    return payload;
  }

  async extract(signal: AbortSignal): Promise<ProjectDesignExtraction> {
    const payload = await this.json("GET", `${this.project}/extract`, { signal });
    if (!isProjectDesignExtraction(payload)) throw invalidResponse("extraction");
    return payload;
  }

  async videoPalette(
    video: string,
    samples: number | undefined,
    signal: AbortSignal,
  ): Promise<VideoPalette> {
    const query = new URLSearchParams({
      video,
      ...(samples !== undefined && { samples: `${samples}` }),
    });
    const payload = await this.json("GET", `${this.project}/video-palette?${query}`, {
      signal: AbortSignal.any([signal, AbortSignal.timeout(PALETTE_TIMEOUT_MS)]),
    });
    if (!isVideoPalette(payload)) throw invalidResponse("video palette");
    return payload;
  }

  async projectState(signal: AbortSignal): Promise<ProjectDesignState> {
    const payload = await this.json("GET", this.project, { signal });
    if (!isProjectDesignState(payload)) throw invalidResponse("project design state");
    return payload;
  }

  async snapshot(signal: AbortSignal): Promise<DesignSnapshot> {
    const state = await this.projectState(signal);
    if (!state.attached || !state.snapshotOk) return { state, tokens: null, manifest: null };
    const [css, html] = await Promise.all([
      this.text(`${this.project}/files/tokens.css`, signal),
      this.text(`${this.project}/files/system.html`, signal),
    ]);
    return {
      state,
      tokens: css === null ? null : parseRootTokens(css),
      manifest: html === null ? null : parseManifestHtml(html),
    };
  }

  async attach(id: string, signal: AbortSignal): Promise<ProjectDesignState> {
    if (signal.aborted) throw aborted();
    const body: AttachDesignRequest = { id };
    const payload = await this.json("PUT", this.project, {
      body,
      signal: AbortSignal.timeout(SAVE_TIMEOUT_MS),
    });
    if (!isProjectDesignState(payload)) throw invalidResponse("project design state");
    return payload;
  }

  async externalProject(projectKey: string, signal: AbortSignal): Promise<ProjectDesignExtraction> {
    const payload = await this.json(
      "GET",
      `${this.project}/extract/external/${encodeURIComponent(projectKey)}`,
      { signal },
    );
    if (!isProjectDesignExtraction(payload)) throw invalidResponse("extraction");
    return payload;
  }

  /** A text file of the project's `design/` folder; null when it cannot be read (the prompt then says less). */
  private async text(url: string, signal: AbortSignal): Promise<string | null> {
    try {
      const response = await fetch(url, { signal });
      return response.ok ? await response.text() : null;
    } catch {
      return null;
    }
  }

  private async json(method: Method, url: string, options: RequestOptions): Promise<unknown> {
    const { body, signal } = options;
    let response: Response;
    try {
      response = await fetch(url, {
        method,
        signal,
        ...(body !== undefined && {
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        }),
      });
    } catch (error) {
      throw transportError(error, signal);
    }
    const payload: unknown = await response.json().catch(() => null);
    if (response.ok) return payload;
    const failure = isRecord(payload) ? payload.error : undefined;
    if (isDesignError(failure))
      throw new DesignToolError(
        failure.code,
        failure.message,
        Array.isArray(failure.issues)
          ? failure.issues.filter((issue): issue is string => typeof issue === "string")
          : [],
      );
    throw new DesignToolError(
      "unavailable",
      typeof failure === "string"
        ? failure
        : `Studio's design service failed the request (${response.status}).`,
    );
  }
}

function aborted(): DesignToolError {
  return new DesignToolError("aborted", "The operation was cancelled.");
}

function invalidResponse(what: string): DesignToolError {
  return new DesignToolError("unavailable", `Studio returned an invalid ${what}.`);
}

function transportError(error: unknown, signal: AbortSignal): DesignToolError {
  if (signal.aborted) {
    if (signal.reason instanceof Error && signal.reason.name === "TimeoutError") {
      return new DesignToolError(
        "unavailable",
        "Studio's design service did not answer in time; read the library to see whether the request took effect.",
      );
    }
    return aborted();
  }
  const reason = error instanceof Error ? error.message : String(error);
  return new DesignToolError("unavailable", `Studio's design service is not reachable: ${reason}`);
}
