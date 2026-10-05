import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  QA_LIMITS,
  findAcceptedQaIssue,
  isRecord,
  parseQaAcceptedIssue,
  type QaAcceptedIssue,
  type QaIssue,
  type QaReport,
} from "@hyperframes/agent-protocol";
import { replaceFileAtomically } from "../helpers/atomicFile.js";
import { pinWithinProject, resolveWithinProject } from "../helpers/safePath.js";
import { QaFailure } from "./errors.js";
import { QA_DIR } from "./store.js";

/** Per-project list of issues the user marked intentional. Retention never touches it. */
const ACCEPTED_FILE = `${QA_DIR}/accepted.json`;
const RENDERS_PREFIX = "renders/";

/**
 * The accepted issues, oldest first. A missing, damaged or foreign file reads as empty (it is the user's list, not
 * something QA may fail on); entries that do not parse are dropped.
 */
export function readAccepted(projectDir: string): QaAcceptedIssue[] {
  const file = resolveWithinProject(projectDir, ACCEPTED_FILE);
  if (!file || !existsSync(file)) return [];
  try {
    const raw: unknown = JSON.parse(readFileSync(file, "utf-8"));
    if (!isRecord(raw) || raw.schemaVersion !== 1 || !Array.isArray(raw.items)) return [];
    const items: QaAcceptedIssue[] = [];
    for (const item of raw.items) {
      const parsed = parseQaAcceptedIssue(item);
      if (parsed.ok) items.push(parsed.value);
    }
    return items;
  } catch {
    return [];
  }
}

export function writeAccepted(projectDir: string, items: readonly QaAcceptedIssue[]): void {
  const file = pinWithinProject(projectDir, ACCEPTED_FILE);
  if (!file) throw new QaFailure("failed", "The QA folder is outside the project");
  mkdirSync(join(projectDir, QA_DIR), { recursive: true });
  replaceFileAtomically(file, `${JSON.stringify({ schemaVersion: 1, items }, null, 2)}\n`, 0o644);
}

/**
 * Marks `issue` (of a report on `composition`) intentional. Marking what is already marked returns the existing
 * entry; past the list's limit the oldest entries go.
 */
export function addAccepted(
  projectDir: string,
  composition: string,
  issue: QaIssue,
  now: number,
): QaAcceptedIssue {
  const items = readAccepted(projectDir);
  const existing = findAcceptedQaIssue(issue, composition, items);
  if (existing) return existing;
  const entry: QaAcceptedIssue = {
    id: `acc-${randomBytes(4).toString("hex")}`,
    composition,
    kind: issue.kind,
    check: issue.check,
    subject: issue.subject,
    start: issue.start,
    end: issue.end,
    message: issue.message,
    acceptedAt: now,
  };
  writeAccepted(projectDir, [...items, entry].slice(-QA_LIMITS.accepted));
  return entry;
}

/** Removes one entry; the list after it, or null when there was no such entry. */
export function removeAccepted(projectDir: string, id: string): QaAcceptedIssue[] | null {
  const items = readAccepted(projectDir);
  const kept = items.filter((entry) => entry.id !== id);
  if (kept.length === items.length) return null;
  writeAccepted(projectDir, kept);
  return kept;
}

/** What a read of a report derives from the project: the accepted list and the renders folder. */
export interface ReadContext {
  accepted: readonly QaAcceptedIssue[];
  rendersDir: string;
}

function renderExists(rendersDir: string, renderPath: string): boolean {
  if (!renderPath.startsWith(RENDERS_PREFIX)) return false;
  const file = resolveWithinProject(rendersDir, renderPath.slice(RENDERS_PREFIX.length));
  try {
    return file !== null && statSync(file).isFile();
  } catch {
    return false;
  }
}

/** The report with `acceptedIssueIds` and `renderAvailable` filled in (they are never stored). */
export function withDerivedFields(report: QaReport, context: ReadContext): QaReport {
  return {
    ...report,
    acceptedIssueIds: report.issues
      .filter((issue) => findAcceptedQaIssue(issue, report.composition, context.accepted))
      .map((issue) => issue.id),
    renderAvailable: report.render ? renderExists(context.rendersDir, report.render.path) : false,
  };
}
