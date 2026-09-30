import {
  isRecord,
  isStoryError,
  isStoryView,
  type PresetInfo,
  type ProjectInventory,
  type SaveStoryRequest,
  type StoryErrorCode,
  type StoryView,
} from "@hyperframes/agent-protocol";
import { buildProjectApiPath } from "../utils/projectRouting";

export type StoryFailureCode = StoryErrorCode | "network" | "bad_response" | "http";

export class StoryApiError extends Error {
  readonly code: StoryFailureCode;
  readonly status: number;

  constructor(code: StoryFailureCode, message: string, status = 0) {
    super(message);
    this.name = "StoryApiError";
    this.code = code;
    this.status = status;
  }

  /** The graph changed on the server since the version the edit was made on. */
  get isConflict(): boolean {
    return this.code === "conflict" || this.status === 409;
  }
}

/** The story service as the store and the inspector see it; `createStoryClient` is the network one. */
export interface StoryClient {
  load(projectId: string): Promise<StoryView>;
  save(projectId: string, request: SaveStoryRequest): Promise<StoryView>;
  /** Project assets (for the inspector's asset pickers). */
  inventory(projectId: string): Promise<ProjectInventory>;
  /** Registry blocks or components (for motion nodes). */
  presets(projectId: string, kind: "block" | "component"): Promise<PresetInfo[]>;
}

function isInventory(value: unknown): value is ProjectInventory {
  return isRecord(value) && Array.isArray(value.assets) && Array.isArray(value.compositions);
}

function isPresetList(value: unknown): value is { presets: PresetInfo[] } {
  return isRecord(value) && Array.isArray(value.presets);
}

async function request<T>(
  fetchImpl: typeof fetch,
  url: string,
  guard: (value: unknown) => value is T,
  init?: RequestInit,
): Promise<T> {
  let response: Response;
  try {
    response = await fetchImpl(url, init);
  } catch (error) {
    throw new StoryApiError(
      "network",
      error instanceof Error ? error.message : "Network request failed",
    );
  }
  const text = await response.text();
  let body: unknown;
  try {
    body = text ? JSON.parse(text) : undefined;
  } catch {
    body = undefined;
  }
  if (!response.ok) {
    const error = isRecord(body) ? body.error : undefined;
    if (isStoryError(error)) throw new StoryApiError(error.code, error.message, response.status);
    throw new StoryApiError("http", `Request failed (${response.status})`, response.status);
  }
  if (!guard(body)) {
    throw new StoryApiError("bad_response", "Unexpected response from the story service");
  }
  return body;
}

export function createStoryClient(fetchImpl?: typeof fetch): StoryClient {
  const doFetch = fetchImpl ?? ((input, init) => globalThis.fetch(input, init));
  return {
    load: (projectId) => request(doFetch, buildProjectApiPath(projectId, "/story"), isStoryView),
    save: (projectId, body) =>
      request(doFetch, buildProjectApiPath(projectId, "/story"), isStoryView, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
    inventory: (projectId) =>
      request(doFetch, buildProjectApiPath(projectId, "/editing/project"), isInventory),
    presets: async (projectId, kind) => {
      const url = buildProjectApiPath(projectId, `/editing/presets?kind=${kind}`);
      return (await request(doFetch, url, isPresetList)).presets;
    },
  };
}

/** A JPEG of `source` at `time`, sized for a card; the server caches the grab. */
export function storyFrameUrl(
  projectId: string,
  source: string,
  time: number,
  width = 320,
): string {
  const query = new URLSearchParams({
    source,
    t: String(Math.round(time * 100) / 100),
    w: String(width),
  });
  return `${buildProjectApiPath(projectId, "/story/frame")}?${query.toString()}`;
}

/** A project file as the preview server serves it (pictures show themselves). */
export function projectFileUrl(projectId: string, path: string): string {
  return buildProjectApiPath(projectId, `/preview/${path}`);
}
