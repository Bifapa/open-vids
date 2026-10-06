import {
  isExternalProjectList,
  isProjectPartsSummary,
  type ExternalProjectEntry,
  type ProjectPartsSummary,
} from "@hyperframes/agent-protocol";
import { buildProjectApiPath } from "../utils/projectRouting";

/**
 * The other projects as the composer's `#` popup reads them from the Studio server (`…/cross-project/…`). Studio
 * only lists and counts: the agents read the manifest and copy files. Every call rejects on a network failure, a
 * non-2xx answer (`404` for a project the shell no longer knows) or a body of the wrong shape; the popup treats
 * any of them as "nothing to offer".
 */
export interface CrossProjectClient {
  /** The projects other than `projectId`, most recently opened first. */
  projects(projectId: string, signal?: AbortSignal): Promise<ExternalProjectEntry[]>;
  /** How many files (and chapters) each part of project `key` holds. */
  summary(projectId: string, key: string, signal?: AbortSignal): Promise<ProjectPartsSummary>;
}

async function readJson<T>(
  fetchImpl: typeof fetch,
  url: string,
  guard: (value: unknown) => value is T,
  signal: AbortSignal | undefined,
): Promise<T> {
  const response = await fetchImpl(url, { signal });
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
  const body: unknown = await response.json();
  if (!guard(body)) throw new Error(`${url}: unexpected answer`);
  return body;
}

export function createCrossProjectClient(fetchImpl?: typeof fetch): CrossProjectClient {
  const doFetch = fetchImpl ?? ((input, init) => globalThis.fetch(input, init));
  return {
    async projects(projectId, signal) {
      const list = await readJson(
        doFetch,
        buildProjectApiPath(projectId, "/cross-project/projects"),
        isExternalProjectList,
        signal,
      );
      return list.projects;
    },
    async summary(projectId, key, signal) {
      return readJson(
        doFetch,
        buildProjectApiPath(
          projectId,
          `/cross-project/projects/${encodeURIComponent(key)}/summary`,
        ),
        isProjectPartsSummary,
        signal,
      );
    },
  };
}

export const studioCrossProjectClient: CrossProjectClient = createCrossProjectClient();
