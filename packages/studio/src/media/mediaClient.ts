/**
 * What the Media workspace reads from the Studio server: the editing inventory (probe facts for every asset) and the
 * long-form analysis service (per-source status, overview, transcript, shots, jobs). Thin, typed, guarded.
 */

import {
  isRecord,
  readErrorParams,
  type AnalysisJob,
  type AnalysisOverview,
  type ProjectInventory,
  type ShotMap,
  type SourceAnalysisStatus,
  type TranscriptView,
} from "@hyperframes/agent-protocol";
import { describeServerError } from "../agent/agentErrors";
import { t } from "../i18n";
import { buildProjectApiPath } from "../utils/projectRouting";

export interface MediaClient {
  inventory(projectId: string): Promise<ProjectInventory>;
  analysisSources(projectId: string): Promise<SourceAnalysisStatus[]>;
  overview(projectId: string, source: string): Promise<AnalysisOverview>;
  transcript(projectId: string, source: string): Promise<TranscriptView>;
  shots(projectId: string, source: string): Promise<ShotMap>;
  startAnalysis(projectId: string, source: string): Promise<AnalysisJob>;
  job(projectId: string, jobId: string): Promise<AnalysisJob>;
}

const isInventory = (value: unknown): value is ProjectInventory =>
  isRecord(value) && Array.isArray(value.assets) && Array.isArray(value.compositions);

const isSourceList = (value: unknown): value is { sources: SourceAnalysisStatus[] } =>
  isRecord(value) && Array.isArray(value.sources);

const isOverview = (value: unknown): value is AnalysisOverview =>
  isRecord(value) && isRecord(value.status) && Array.isArray(value.visionTargets);

const isTranscript = (value: unknown): value is TranscriptView =>
  isRecord(value) && typeof value.source === "string" && Array.isArray(value.sentences);

const isShotMap = (value: unknown): value is ShotMap =>
  isRecord(value) && Array.isArray(value.shots) && Array.isArray(value.problems);

const isJob = (value: unknown): value is AnalysisJob =>
  isRecord(value) && typeof value.id === "string" && typeof value.progress === "number";

function errorMessage(body: unknown, status: number): string {
  if (isRecord(body) && isRecord(body.error) && typeof body.error.message === "string") {
    const code = typeof body.error.code === "string" ? body.error.code : "";
    return describeServerError(code, body.error.message, readErrorParams(body.error.params));
  }
  return t("media.client.requestFailed", { status });
}

async function request<T>(
  url: string,
  guard: (value: unknown) => value is T,
  init?: RequestInit,
): Promise<T> {
  const response = await fetch(url, init);
  const body: unknown = await response.json().catch(() => undefined);
  if (!response.ok) throw new Error(errorMessage(body, response.status));
  if (!guard(body)) throw new Error(t("media.client.unexpectedResponse"));
  return body;
}

const sourceQuery = (source: string) => `source=${encodeURIComponent(source)}`;

export const mediaClient: MediaClient = {
  inventory: (projectId) =>
    request(buildProjectApiPath(projectId, "/editing/project"), isInventory),
  analysisSources: async (projectId) =>
    (await request(buildProjectApiPath(projectId, "/analysis/sources"), isSourceList)).sources,
  overview: (projectId, source) =>
    request(
      buildProjectApiPath(projectId, `/analysis/overview?${sourceQuery(source)}`),
      isOverview,
    ),
  transcript: (projectId, source) =>
    request(
      buildProjectApiPath(projectId, `/analysis/transcript?${sourceQuery(source)}`),
      isTranscript,
    ),
  shots: (projectId, source) =>
    request(
      buildProjectApiPath(projectId, `/analysis/artifact?${sourceQuery(source)}&stage=shots`),
      isShotMap,
    ),
  startAnalysis: (projectId, source) =>
    request(buildProjectApiPath(projectId, "/analysis/jobs"), isJob, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ source }),
    }),
  job: (projectId, jobId) =>
    request(buildProjectApiPath(projectId, `/analysis/jobs/${encodeURIComponent(jobId)}`), isJob),
};
