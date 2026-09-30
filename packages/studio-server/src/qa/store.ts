import { randomBytes } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import {
  isQaReport,
  qaCounts,
  type QaReport,
  type QaReportInput,
  type QaReportSummary,
} from "@hyperframes/agent-protocol";
import { replaceFileAtomically } from "../helpers/atomicFile.js";
import { pinWithinProject, resolveWithinProject } from "../helpers/safePath.js";
import { QaFailure } from "./errors.js";

/**
 * Where a project keeps its QA; outside project history and the preview signature (the watcher, the history and the
 * signature all skip `.hyperframes/` apart from their own named files).
 */
export const QA_DIR = ".hyperframes/qa";
const REPORTS_DIR = `${QA_DIR}/reports`;
const FRAMES_DIR = `${QA_DIR}/frames`;
/** Reports listed at most; older ones stay on disk. */
const LIST_LIMIT = 200;
const ID_PATTERN = /^qa-\d{14}-[0-9a-f]{6}$/;
const FRAMES_STAMP = ".render";

type StoredReport = Omit<QaReport, "current">;

function timestamp(at: number): string {
  return new Date(at).toISOString().replace(/\D/g, "").slice(0, 14);
}

export function newReportId(at: number): string {
  return `qa-${timestamp(at)}-${randomBytes(3).toString("hex")}`;
}

export function isReportId(value: string): boolean {
  return ID_PATTERN.test(value);
}

function reportFile(projectDir: string, id: string): string | null {
  return resolveWithinProject(projectDir, `${REPORTS_DIR}/${id}.json`);
}

/** Writes a pass's report (tmp + rename, so a crash never leaves half a file) and returns it with `current` derived. */
export function writeReport(
  projectDir: string,
  input: QaReportInput,
  now: number,
  fingerprint: string,
): QaReport {
  const id = newReportId(now);
  const stored: StoredReport = {
    ...input,
    id,
    schemaVersion: 1,
    createdAt: now,
    counts: qaCounts(input.issues, input.resolved),
  };
  const file = pinWithinProject(projectDir, `${REPORTS_DIR}/${id}.json`);
  if (!file) throw new QaFailure("failed", "The QA reports folder is outside the project");
  mkdirSync(join(projectDir, REPORTS_DIR), { recursive: true });
  replaceFileAtomically(file, `${JSON.stringify(stored, null, 2)}\n`, 0o644);
  return { ...stored, current: stored.fingerprint === fingerprint };
}

/** A stored report, or null when the file is missing or damaged. */
export function readReport(projectDir: string, id: string, fingerprint: string): QaReport | null {
  if (!isReportId(id)) return null;
  const file = reportFile(projectDir, id);
  if (!file || !existsSync(file)) return null;
  try {
    const raw: unknown = JSON.parse(readFileSync(file, "utf-8"));
    if (typeof raw !== "object" || raw === null) return null;
    const candidate = { ...raw, current: Reflect.get(raw, "fingerprint") === fingerprint };
    return isQaReport(candidate) && candidate.id === id ? candidate : null;
  } catch {
    return null;
  }
}

function summaryOf(report: QaReport): QaReportSummary {
  return {
    id: report.id,
    createdAt: report.createdAt,
    sessionId: report.sessionId,
    turnId: report.turnId,
    pass: report.pass,
    passLimit: report.passLimit,
    composition: report.composition,
    renderPath: report.render?.path ?? null,
    renderError: report.renderError,
    counts: report.counts,
    current: report.current,
  };
}

/** The newest reports first; a damaged or foreign file in the folder is skipped, never an error. */
export function listReports(projectDir: string, fingerprint: string): QaReportSummary[] {
  const dir = resolveWithinProject(projectDir, REPORTS_DIR);
  if (!dir || !existsSync(dir)) return [];
  const ids = readdirSync(dir)
    .filter((name) => name.endsWith(".json") && isReportId(name.slice(0, -5)))
    .map((name) => name.slice(0, -5))
    .sort()
    .reverse();
  const reports: QaReportSummary[] = [];
  for (const id of ids) {
    if (reports.length >= LIST_LIMIT) break;
    const report = readReport(projectDir, id, fingerprint);
    if (report) reports.push(summaryOf(report));
  }
  return reports.sort((a, b) => b.createdAt - a.createdAt || (a.id < b.id ? 1 : -1));
}

/**
 * The frame cache folder of one render (`.hyperframes/qa/frames/<render stem>/`). Frames are keyed by time and width,
 * so a render file rewritten under the same name (every QA pass may render to the same preview file) must not serve
 * the old pictures: the folder remembers which bytes (name, size, mtime) its frames came from and is emptied when the
 * file is not that one any more.
 */
export function framesDirFor(projectDir: string, renderName: string, renderFile: string): string {
  const stem = renderName.replace(/\.[^.]+$/, "");
  const dir = pinWithinProject(projectDir, `${FRAMES_DIR}/${stem}`);
  if (!dir) throw new QaFailure("failed", "The QA frames folder is outside the project");
  const info = statSync(renderFile);
  const stamp = `${renderName}:${info.size}:${info.mtimeMs}`;
  const stampFile = join(dir, FRAMES_STAMP);
  let current: string | null = null;
  try {
    current = readFileSync(stampFile, "utf-8");
  } catch {
    current = null;
  }
  if (current !== stamp) {
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
    writeFileSync(stampFile, stamp);
  }
  return dir;
}
