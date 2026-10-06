import {
  isDesignError,
  isDesignSystemSummary,
  isProjectDesignState,
  isRecord,
  type DesignErrorCode,
  type DesignSystemSummary,
  type ProjectDesignState,
} from "@hyperframes/agent-protocol";
import { t } from "../i18n";
import { buildProjectApiPath } from "../utils/projectRouting";

export type DesignFailureCode = DesignErrorCode | "network" | "bad_response" | "http" | "aborted";

export class DesignApiError extends Error {
  readonly code: DesignFailureCode;
  readonly status: number;
  /** `invalid_system`: every problem the server found (English, as the server wrote it). */
  readonly issues: string[];

  constructor(code: DesignFailureCode, message: string, status = 0, issues: string[] = []) {
    super(message);
    this.name = "DesignApiError";
    this.code = code;
    this.status = status;
    this.issues = issues;
  }
}

/** The design service as the store sees it; `createDesignClient` is the network one. */
export interface DesignClient {
  /** The user's library, newest updated first. */
  listLibrary(signal?: AbortSignal): Promise<DesignSystemSummary[]>;
  getProject(projectId: string, signal?: AbortSignal): Promise<ProjectDesignState>;
  /** Attaches (or switches to) a library system: its files are copied into the project's `design/`. */
  attach(projectId: string, id: string): Promise<ProjectDesignState>;
  /** Moves the attached snapshot to the library's current version. */
  update(projectId: string): Promise<ProjectDesignState>;
  detach(projectId: string): Promise<ProjectDesignState>;
  /** The project's own `design/tokens.css` (the snapshot, not the library's current version). */
  snapshotTokens(projectId: string, signal?: AbortSignal): Promise<string>;
}

const LIBRARY_PATH = "/api/design-systems";

function isLibraryList(value: unknown): value is { systems: DesignSystemSummary[] } {
  return (
    isRecord(value) && Array.isArray(value.systems) && value.systems.every(isDesignSystemSummary)
  );
}

/** A state whose attached record has what the UI reads; the protocol's guard only checks that it is an object. */
function isProjectState(value: unknown): value is ProjectDesignState {
  if (!isProjectDesignState(value)) return false;
  const { attached } = value;
  return (
    attached === null ||
    (typeof attached.id === "string" &&
      typeof attached.name === "string" &&
      typeof attached.version === "number" &&
      Array.isArray(attached.unknownLicenses) &&
      Array.isArray(attached.nonPortableFonts))
  );
}

function describeCode(code: DesignFailureCode): string {
  switch (code) {
    case "invalid_request":
      return t("studio.design.error.invalid_request");
    case "invalid_system":
      return t("studio.design.error.invalid_system");
    case "not_found":
      return t("studio.design.error.not_found");
    case "conflict":
      return t("studio.design.error.conflict");
    case "busy":
      return t("studio.design.error.busy");
    case "asset_unavailable":
      return t("studio.design.error.asset_unavailable");
    case "unavailable":
      return t("studio.design.error.unavailable");
    case "network":
      return t("studio.design.error.network");
    case "bad_response":
      return t("studio.design.error.bad_response");
    case "http":
    case "aborted":
      return t("studio.design.error.http");
  }
}

async function send(
  fetchImpl: typeof fetch,
  url: string,
  init: RequestInit | undefined,
): Promise<Response> {
  try {
    return await fetchImpl(url, init);
  } catch (error) {
    if (init?.signal?.aborted) throw new DesignApiError("aborted", "aborted");
    throw new DesignApiError(
      "network",
      error instanceof Error ? error.message : describeCode("network"),
    );
  }
}

async function failure(response: Response): Promise<DesignApiError> {
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    body = undefined;
  }
  const error = isRecord(body) ? body.error : undefined;
  if (isDesignError(error)) {
    return new DesignApiError(error.code, describeCode(error.code), response.status, error.issues);
  }
  return new DesignApiError(
    "http",
    t("studio.design.error.status", { status: response.status }),
    response.status,
  );
}

async function requestJson<T>(
  fetchImpl: typeof fetch,
  url: string,
  guard: (value: unknown) => value is T,
  init?: RequestInit,
): Promise<T> {
  const response = await send(fetchImpl, url, init);
  if (!response.ok) throw await failure(response);
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    if (init?.signal?.aborted) throw new DesignApiError("aborted", "aborted");
    throw new DesignApiError("bad_response", describeCode("bad_response"));
  }
  if (!guard(body)) throw new DesignApiError("bad_response", describeCode("bad_response"));
  return body;
}

export function createDesignClient(fetchImpl?: typeof fetch): DesignClient {
  const doFetch = fetchImpl ?? ((input, init) => globalThis.fetch(input, init));
  const jsonInit = (method: string, body?: unknown): RequestInit => ({
    method,
    ...(body !== undefined && {
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  });
  return {
    listLibrary: async (signal) =>
      (await requestJson(doFetch, LIBRARY_PATH, isLibraryList, { signal })).systems,
    getProject: (projectId, signal) =>
      requestJson(doFetch, buildProjectApiPath(projectId, "/design"), isProjectState, { signal }),
    attach: (projectId, id) =>
      requestJson(
        doFetch,
        buildProjectApiPath(projectId, "/design"),
        isProjectState,
        jsonInit("PUT", { id }),
      ),
    update: (projectId) =>
      requestJson(
        doFetch,
        buildProjectApiPath(projectId, "/design/update"),
        isProjectState,
        jsonInit("POST"),
      ),
    detach: (projectId) =>
      requestJson(
        doFetch,
        buildProjectApiPath(projectId, "/design"),
        isProjectState,
        jsonInit("DELETE"),
      ),
    snapshotTokens: async (projectId, signal) => {
      const response = await send(
        doFetch,
        buildProjectApiPath(projectId, "/design/files/tokens.css"),
        { signal },
      );
      if (!response.ok) throw await failure(response);
      return response.text();
    },
  };
}

/** What a preview shows: the project's own snapshot, or a library system's current (or given) version. */
export type DesignPreviewTarget =
  | { kind: "project"; projectId: string }
  | { kind: "library"; id: string; version?: number };

/** The URL of the `system.html` showcase; the server sends it with a script-less sandbox CSP, the iframe adds its own. */
export function designPreviewUrl(target: DesignPreviewTarget): string {
  if (target.kind === "project") {
    return buildProjectApiPath(target.projectId, "/design/files/system.html");
  }
  const path = `${LIBRARY_PATH}/${encodeURIComponent(target.id)}/files/system.html`;
  return target.version === undefined ? path : `${path}?version=${target.version}`;
}
