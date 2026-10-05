import { existsSync, mkdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { dirname } from "node:path";
import { replaceFileAtomically } from "../helpers/atomicFile.js";
import { snapshotBeforeWrite } from "../helpers/backupJournal.js";
import { pinWithinProject } from "../helpers/safePath.js";
import { EditFailure } from "./errors.js";

/** One file a batch writes. `expected` is the content the batch was built from (null: a new file, or none to check). */
export interface PendingWrite {
  path: string;
  content: string;
  expected: string | null;
}

export function conflict(path: string): EditFailure {
  return new EditFailure(
    "conflict",
    `${path} changed while the edits were being applied; read the timeline again`,
  );
}

interface Resolved extends PendingWrite {
  abs: string;
  /** What the file holds right now; null when it does not exist yet. */
  previous: string | null;
  mode: number;
}

/**
 * The batch's single commit point. Every file is resolved, checked against the content the batch was built from and
 * backed up before the first byte is written; a write that still fails (disk full, permissions) puts back the files
 * already replaced, so the batch lands as a whole or not at all. Nothing is recorded as a Studio write, so Studio
 * sees an outside edit (and reloads) and the project history attributes it to whichever window is open.
 */
export function commitWrites(projectDir: string, writes: readonly PendingWrite[]): void {
  const resolved: Resolved[] = writes.map((write) => {
    const abs = pinWithinProject(projectDir, write.path);
    if (!abs) throw new EditFailure("invalid_request", `${write.path} is outside the project`);
    const exists = existsSync(abs);
    const previous = exists ? readFileSync(abs, "utf-8") : null;
    if (write.expected !== null && previous !== write.expected) throw conflict(write.path);
    return { ...write, abs, previous, mode: exists ? statSync(abs).mode : 0o644 };
  });
  for (const file of resolved) {
    if (file.previous === null) continue;
    const backup = snapshotBeforeWrite(projectDir, file.abs);
    if (backup.error) throw new Error(`Backup of ${file.path} failed: ${backup.error}`);
  }
  const written: Resolved[] = [];
  try {
    for (const file of resolved) {
      if (file.previous === null) mkdirSync(dirname(file.abs), { recursive: true });
      replaceFileAtomically(file.abs, file.content, file.mode);
      written.push(file);
    }
  } catch (error) {
    for (const file of written.reverse()) {
      if (file.previous === null) rmSync(file.abs, { force: true });
      else replaceFileAtomically(file.abs, file.previous, file.mode);
    }
    throw error;
  }
}
