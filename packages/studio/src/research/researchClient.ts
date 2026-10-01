import {
  isAssetSearchPolicy,
  isExportLicenseCheck,
  isProjectSourcesView,
  isRecord,
  readErrorParams,
  type AddTrustedSourceRequest,
  type AssetSearchMode,
  type AssetSearchPolicy,
  type CodedMessageParams,
  type ExportLicenseCheck,
  type ProjectSourcesView,
  type UpdateTrustedSourceRequest,
} from "@hyperframes/agent-protocol";
import { describeServerError } from "../agent/agentErrors";
import { t } from "../i18n";
import { buildProjectApiPath } from "../utils/projectRouting";

/** A failed research request; `message` is Studio's wording for the server's `code`, or the server's `message`. */
export class ResearchApiError extends Error {
  readonly status: number;
  readonly code: string | null;
  readonly params: CodedMessageParams | undefined;

  constructor(
    message: string,
    status = 0,
    code: string | null = null,
    params?: CodedMessageParams,
  ) {
    super(message);
    this.name = "ResearchApiError";
    this.status = status;
    this.code = code;
    this.params = params;
  }
}

/**
 * The research service as Studio sees it: the project's Sources/Licenses view, the export license check and the
 * global Asset Search policy. Studio never searches or imports: that is the Research agent's work.
 */
export interface ResearchClient {
  sources(projectId: string): Promise<ProjectSourcesView>;
  /** What exporting `composition` (the server's default composition when null) would ship. */
  exportCheck(projectId: string, composition: string | null): Promise<ExportLicenseCheck>;
  policy(): Promise<AssetSearchPolicy>;
  setMode(mode: AssetSearchMode): Promise<AssetSearchPolicy>;
  /** Whether agents may read the pages the user links in chat (the policy's `websites.readLinkedPages`). */
  setReadLinkedPages(readLinkedPages: boolean): Promise<AssetSearchPolicy>;
  addSource(request: AddTrustedSourceRequest): Promise<AssetSearchPolicy>;
  updateSource(id: string, patch: UpdateTrustedSourceRequest): Promise<AssetSearchPolicy>;
  removeSource(id: string): Promise<AssetSearchPolicy>;
  restoreSources(): Promise<AssetSearchPolicy>;
}

/** The server's `{ error: { code, message, params } }`, translated when Studio has `errors.<code>`. */
function errorFrom(
  body: unknown,
): { message: string; code: string; params?: CodedMessageParams } | null {
  if (!isRecord(body) || !isRecord(body.error)) return null;
  const { code, message } = body.error;
  if (typeof message !== "string" || !message) return null;
  const key = typeof code === "string" ? code : "";
  const params = readErrorParams(body.error.params);
  return {
    message: describeServerError(key, message, params),
    code: key,
    ...(params && { params }),
  };
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
    throw new ResearchApiError(
      error instanceof Error ? error.message : t("research.error.unreachable"),
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
    const failure = errorFrom(body);
    if (failure) {
      throw new ResearchApiError(failure.message, response.status, failure.code, failure.params);
    }
    throw new ResearchApiError(
      t("research.error.http", { status: response.status }),
      response.status,
    );
  }
  if (!guard(body)) throw new ResearchApiError(t("research.error.badResponse"));
  return body;
}

function json(method: string, body?: unknown): RequestInit {
  return body === undefined
    ? { method }
    : { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) };
}

const POLICY_URL = "/api/research/policy";
const SOURCES_URL = "/api/research/sources";

export function createResearchClient(fetchImpl?: typeof fetch): ResearchClient {
  const doFetch = fetchImpl ?? ((input, init) => globalThis.fetch(input, init));
  const policyRequest = (url: string, init?: RequestInit) =>
    request(doFetch, url, isAssetSearchPolicy, init);
  return {
    sources: (projectId) =>
      request(doFetch, buildProjectApiPath(projectId, "/research/sources"), isProjectSourcesView),
    exportCheck: (projectId, composition) => {
      const query = composition ? `?composition=${encodeURIComponent(composition)}` : "";
      return request(
        doFetch,
        buildProjectApiPath(projectId, `/research/export-check${query}`),
        isExportLicenseCheck,
      );
    },
    policy: () => policyRequest(POLICY_URL),
    setMode: (mode) => policyRequest(POLICY_URL, json("PUT", { mode })),
    setReadLinkedPages: (readLinkedPages) =>
      policyRequest(POLICY_URL, json("PUT", { websites: { readLinkedPages } })),
    addSource: (body) => policyRequest(SOURCES_URL, json("POST", body)),
    updateSource: (id, patch) =>
      policyRequest(`${SOURCES_URL}/${encodeURIComponent(id)}`, json("PATCH", patch)),
    removeSource: (id) => policyRequest(`${SOURCES_URL}/${encodeURIComponent(id)}`, json("DELETE")),
    restoreSources: () => policyRequest(`${SOURCES_URL}/restore`, json("POST")),
  };
}
