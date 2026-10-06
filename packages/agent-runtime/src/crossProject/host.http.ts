import {
  isImportFromProjectResult,
  isProjectManifest,
  type ImportFromProjectRequest,
  type ImportFromProjectResult,
  type ProjectManifest,
  type ProjectPart,
} from "@hyperframes/agent-protocol";
import type { ProjectScope } from "../checkpointHost.js";
import { invalidResponse, StudioTransport } from "../research/transport.js";
import type { CrossProjectHost } from "./host.js";

/** How long each call may take before the runtime stops waiting (a copy may be a few large videos). */
export const CROSS_PROJECT_TIMEOUTS_MS = {
  read: 30_000,
  importFiles: 10 * 60_000,
} as const;

export interface HttpCrossProjectHostOptions {
  /** Overrides {@link CROSS_PROJECT_TIMEOUTS_MS}. */
  timeoutsMs?: Partial<Record<keyof typeof CROSS_PROJECT_TIMEOUTS_MS, number>>;
  /** Overrides the shared write settle bound (`WRITE_SETTLE_MS`). */
  settleMs?: number;
}

/** Studio's cross-project HTTP API for one project. */
export class HttpCrossProjectHost implements CrossProjectHost {
  private readonly base: string;
  private readonly timeoutsMs: Record<keyof typeof CROSS_PROJECT_TIMEOUTS_MS, number>;
  private readonly transport: StudioTransport;

  constructor(scope: ProjectScope, options: HttpCrossProjectHostOptions = {}) {
    this.base = `${scope.studioOrigin}/api/projects/${encodeURIComponent(scope.projectId)}/cross-project`;
    this.timeoutsMs = { ...CROSS_PROJECT_TIMEOUTS_MS, ...options.timeoutsMs };
    this.transport = new StudioTransport({
      service: "cross-project",
      ...(options.settleMs !== undefined && { settleMs: options.settleMs }),
    });
  }

  async manifest(
    key: string,
    parts: readonly ProjectPart[],
    signal: AbortSignal,
  ): Promise<ProjectManifest> {
    const payload = await this.transport.request(
      "GET",
      `${this.base}/projects/${encodeURIComponent(key)}/manifest?parts=${parts.join(",")}`,
      { signal, timeoutMs: this.timeoutsMs.read, onTimeout: "Studio did not answer in time." },
    );
    if (!isProjectManifest(payload)) throw invalidResponse("project manifest");
    return payload;
  }

  async importFiles(
    request: ImportFromProjectRequest,
    signal: AbortSignal,
  ): Promise<ImportFromProjectResult> {
    const payload = await this.transport.write(request, {
      url: `${this.base}/import`,
      cancelUrl: (requestId) => `${this.base}/requests/${encodeURIComponent(requestId)}/cancel`,
      label: "project import",
      signal,
      timeoutMs: this.timeoutsMs.importFiles,
      onTimeout:
        "The copy did not finish in time and was cancelled; inspect_project shows whether the files reached the project.",
    });
    if (!isImportFromProjectResult(payload)) throw invalidResponse("project import result");
    return payload;
  }
}
