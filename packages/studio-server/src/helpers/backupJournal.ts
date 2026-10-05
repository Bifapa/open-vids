import { createHash } from "node:crypto";
import {
  constants,
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  statSync,
  unlinkSync,
} from "node:fs";
import { Buffer } from "node:buffer";
import { basename, join, relative } from "node:path";
import { isSafePath } from "./safePath.js";

const DEFAULT_KEEP_PER_FILE = 10;

export interface BackupJournalResult {
  backupPath: string | null;
  error?: string;
}

/** The longest readable part of a backup name, in UTF-8 bytes; the whole name stays far inside a 255-byte limit. */
const READABLE_KEY_BYTES = 96;

/**
 * Names a backup after its project-relative path without growing with it: a readable cut of the file's own name,
 * then a hash of the whole path (which is what tells two files apart). Long or Cyrillic paths stay saveable.
 */
function backupKeyForPath(path: string): string {
  let readable = "";
  for (const char of basename(path).replace(/[^\p{L}\p{N}._ -]/gu, "_")) {
    if (Buffer.byteLength(readable + char) > READABLE_KEY_BYTES) break;
    readable += char;
  }
  const digest = createHash("sha256").update(path, "utf-8").digest("hex").slice(0, 32);
  return readable ? `${readable}-${digest}` : digest;
}

/** How backups were named before: the whole path in base64, which only fits short paths. */
function legacyBackupKeyForPath(path: string): string {
  return Buffer.from(path, "utf-8").toString("base64url");
}

function timestampPrefix(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

export function backupPathForResponse(
  projectDir: string,
  backupPath: string | null,
): string | null {
  if (!backupPath) return null;
  const rel = relative(projectDir, backupPath);
  if (!rel || rel.startsWith("..")) return null;
  return rel.split("\\").join("/");
}

export function snapshotBeforeWrite(
  projectDir: string,
  absPath: string,
  options: { keepPerFile?: number } = {},
): BackupJournalResult {
  if (!isSafePath(projectDir, absPath)) return { backupPath: null };

  try {
    const info = statSync(absPath);
    if (info.isDirectory()) return { backupPath: null };

    const relativePath = relative(projectDir, absPath);
    const backupDir = join(projectDir, ".hyperframes", "backup");
    mkdirSync(backupDir, { recursive: true });

    const backupKey = backupKeyForPath(relativePath);
    const backupPath = nextBackupPath(backupDir, backupKey);
    // Copied by the file system, not read whole into memory: a backup of a large file must not need its size in RAM.
    copyFileSync(absPath, backupPath, constants.COPYFILE_FICLONE | constants.COPYFILE_EXCL);
    pruneBackups(
      backupDir,
      [backupKey, legacyBackupKeyForPath(relativePath)],
      options.keepPerFile ?? DEFAULT_KEEP_PER_FILE,
    );
    return { backupPath };
  } catch (error) {
    if (
      error &&
      typeof error === "object" &&
      "code" in error &&
      (error.code === "ENOENT" || error.code === "EISDIR")
    ) {
      return { backupPath: null };
    }
    return { backupPath: null, error: error instanceof Error ? error.message : String(error) };
  }
}

function nextBackupPath(backupDir: string, backupKey: string): string {
  const base = `${timestampPrefix()}-${backupKey}`;
  let candidate = join(backupDir, base);
  for (let counter = 2; existsSync(candidate); counter += 1) {
    candidate = join(backupDir, `${base}-${counter}`);
  }
  return candidate;
}

function pruneBackups(backupDir: string, backupKeys: string[], keepPerFile: number): void {
  const keep = Math.max(1, Math.floor(keepPerFile));
  const matches = readdirSync(backupDir)
    .filter((name) => {
      const counterless = name.replace(/-\d+$/, "");
      return backupKeys.some((key) => name.endsWith(`-${key}`) || counterless.endsWith(`-${key}`));
    })
    .map((name) => join(backupDir, name))
    .sort((a, b) => {
      return b.localeCompare(a);
    });

  for (const file of matches.slice(keep)) {
    try {
      unlinkSync(file);
    } catch {
      // Backup pruning is best-effort and must not block the user's write.
    }
  }
}
