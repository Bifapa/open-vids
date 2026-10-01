import { existsSync, readdirSync, rmSync, statSync } from "node:fs";
import {
  isRenderPath,
  type QaFinishRequest,
  type QaFinishResponse,
  type QaReport,
} from "@hyperframes/agent-protocol";
import { resolveWithinProject } from "../helpers/safePath.js";
import {
  frameCacheStems,
  readReport,
  removeFrameCache,
  removeReport,
  renderStem,
  reportFileTime,
  reportIdTime,
  reportIds,
} from "./store.js";

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * What a project keeps of its QA (`.hyperframes/qa/`), applied whenever a report is saved and whenever a session
 * ends. Reports are small and cheap; preview renders and frame caches are the heavy part, and go with their session
 * (see `finishSession`) or with the render they belong to.
 */
export const QA_RETENTION = {
  /** The reports of this many most recent sessions are always kept. */
  keepSessions: 20,
  /** Reports of any session that had a report this recent are kept whatever their count. */
  keepMs: 3 * DAY_MS,
  /**
   * At most this many report files are read in one run (the newest). Older ones are not read: a session never has
   * more than a handful of reports, so they are far past `keepSessions`; they go when their id says they are older
   * than `keepMs`.
   */
  maxReportsRead: 2000,
  /** One run stops reading and deleting after this long; what is left is handled by the next run. */
  budgetMs: 2000,
} as const;

/** What the retention policy needs to know about the project and the service. */
export interface RetentionContext {
  projectDir: string;
  /** The project's renders folder (`renders/` of the project, unless the host puts it elsewhere). */
  rendersDir: string;
  now: number;
  /** Sessions that have saved a report and not finished: their reports are never deleted. */
  running: ReadonlySet<string>;
}

interface StoredReports {
  reports: QaReport[];
  /** Report files that could not be read as a report. */
  damaged: string[];
  /** Ids past `maxReportsRead`: not read. */
  unread: string[];
}

function readStoredReports(projectDir: string, deadline: number): StoredReports {
  const stored: StoredReports = { reports: [], damaged: [], unread: [] };
  for (const id of reportIds(projectDir)) {
    if (stored.reports.length + stored.damaged.length >= QA_RETENTION.maxReportsRead) {
      stored.unread.push(id);
      continue;
    }
    if (Date.now() > deadline) break;
    const report = readReport(projectDir, id, "");
    if (report) stored.reports.push(report);
    else stored.damaged.push(id);
  }
  return stored;
}

function renderFile(rendersDir: string, renderPath: string): string | null {
  return isRenderPath(renderPath)
    ? resolveWithinProject(rendersDir, renderPath.slice("renders/".length))
    : null;
}

/** The render each session (other than `except`) ended on so far: the file of its newest report that has one. */
function lastRenderPaths(reports: readonly QaReport[], except: string): Set<string> {
  const newest = new Map<string, QaReport>();
  for (const report of reports) {
    if (report.sessionId === except || !report.render) continue;
    const known = newest.get(report.sessionId);
    const later =
      !known ||
      report.createdAt > known.createdAt ||
      (report.createdAt === known.createdAt && report.id > known.id);
    if (later) newest.set(report.sessionId, report);
  }
  return new Set(
    [...newest.values()].flatMap((report) => (report.render ? [report.render.path] : [])),
  );
}

/**
 * The end of a QA session: deletes the intermediate preview renders QA made for it (recorded in its reports with
 * origin `qa`, plus `request.produced`) except `request.keep`, the render the final report names. A file is never
 * deleted when any report records it as the turn's own render (origin `turn`), nor when it is the render another
 * session currently ends on. Returns the project-relative paths deleted. Frame caches of deleted renders are removed
 * by `pruneFrameCaches`.
 */
export function deleteIntermediateRenders(
  context: RetentionContext,
  sessionId: string,
  request: QaFinishRequest,
): string[] {
  const { reports } = readStoredReports(context.projectDir, Date.now() + QA_RETENTION.budgetMs);
  const candidates = new Set(request.produced ?? []);
  const protectedPaths = lastRenderPaths(reports, sessionId);
  if (request.keep) protectedPaths.add(request.keep);
  for (const report of reports) {
    if (!report.render) continue;
    if (report.render.origin === "turn") protectedPaths.add(report.render.path);
    else if (report.sessionId === sessionId) candidates.add(report.render.path);
  }
  const removed: string[] = [];
  for (const path of candidates) {
    if (protectedPaths.has(path)) continue;
    const file = renderFile(context.rendersDir, path);
    if (!file || !existsSync(file) || !statSync(file).isFile()) continue;
    rmSync(file, { force: true });
    // The render job's sidecar (`<job id>.meta.json`) goes with its video.
    rmSync(file.replace(/\.[^.]+$/, ".meta.json"), { force: true });
    removed.push(path);
  }
  return removed;
}

/** Deletes the frame cache of every render that is not in the renders folder any more. */
export function pruneFrameCaches(context: RetentionContext): void {
  const stems = existsSync(context.rendersDir)
    ? new Set(readdirSync(context.rendersDir).map(renderStem))
    : new Set<string>();
  const deadline = Date.now() + QA_RETENTION.budgetMs;
  for (const stem of frameCacheStems(context.projectDir)) {
    if (Date.now() > deadline) return;
    if (!stems.has(stem)) removeFrameCache(context.projectDir, stem);
  }
}

/**
 * Global retention of reports: keeps the reports of the `keepSessions` most recent sessions, of every session with a
 * report younger than `keepMs`, and of every running session; deletes the rest, including report files too damaged to
 * read once they are older than `keepMs`. Never touches a render. Returns how many reports were deleted.
 */
export function pruneReports(context: RetentionContext): number {
  const deadline = Date.now() + QA_RETENTION.budgetMs;
  const { reports, damaged, unread } = readStoredReports(context.projectDir, deadline);
  const oldest = context.now - QA_RETENTION.keepMs;

  const sessions = new Map<string, { newest: number; ids: string[] }>();
  for (const report of reports) {
    const session = sessions.get(report.sessionId) ?? { newest: 0, ids: [] };
    session.newest = Math.max(session.newest, report.createdAt);
    session.ids.push(report.id);
    sessions.set(report.sessionId, session);
  }
  const doomed: string[] = [];
  [...sessions.entries()]
    .sort(([aId, a], [bId, b]) => b.newest - a.newest || (aId < bId ? 1 : -1))
    .forEach(([sessionId, session], rank) => {
      const kept =
        rank < QA_RETENTION.keepSessions ||
        session.newest >= oldest ||
        context.running.has(sessionId);
      if (!kept) doomed.push(...session.ids);
    });
  for (const id of damaged) {
    const written = reportFileTime(context.projectDir, id);
    if (written !== null && written < oldest) doomed.push(id);
  }
  for (const id of unread) if (reportIdTime(id) < oldest) doomed.push(id);

  let removed = 0;
  for (const id of doomed) {
    if (Date.now() > deadline) break;
    removeReport(context.projectDir, id);
    removed += 1;
  }
  return removed;
}

/** Ends a session: its intermediate renders, then the retention of reports and frame caches. Best-effort per step. */
export function finishSession(
  context: RetentionContext,
  sessionId: string,
  request: QaFinishRequest,
): QaFinishResponse {
  let removedRenders: string[] = [];
  try {
    removedRenders = deleteIntermediateRenders(context, sessionId, request);
  } catch {
    // The reports stay readable either way; the next retention run tries again for frames and reports.
  }
  return { removedRenders, removedReports: enforceRetention(context) };
}

/** Report retention and frame cache pruning; a step that fails leaves the other one to run. */
export function enforceRetention(context: RetentionContext): number {
  let removedReports = 0;
  try {
    removedReports = pruneReports(context);
  } catch {
    // retention is best-effort: a report folder it cannot read is left as it is
  }
  try {
    pruneFrameCaches(context);
  } catch {
    // the frame caches are rebuilt on demand
  }
  return removedReports;
}
