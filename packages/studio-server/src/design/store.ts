import { randomUUID } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import {
  isDesignSystemSummary,
  isRecord,
  type DesignSystemMeta,
} from "@hyperframes/agent-protocol";
import { replaceFileAtomically } from "../helpers/atomicFile.js";
import { FONT_FILE_PATH } from "./css.js";
import { LOGO_FILE_PATH } from "./manifest.js";

/** `versions/<n>/version.json`: written last into a version, so a version folder that exists is complete. */
interface VersionRecord {
  schema: "openvids.design-version/1";
  meta: DesignSystemMeta;
}

/** One file of a version to write: bytes, or `null` to carry the same path over from the previous version. */
export interface StagedFile {
  path: string;
  data: string | Uint8Array | null;
}

const GENERATED_FILES = ["system.html", "tokens.css", "thumbnail.svg"];
const STAGING = ".staging-";

export function isDesignMeta(value: unknown, id?: string): value is DesignSystemMeta {
  return (
    isRecord(value) &&
    value.schema === "openvids.design-system-meta/1" &&
    isDesignSystemSummary(value) &&
    (id === undefined || value.id === id) &&
    Number.isInteger(value.version) &&
    value.version >= 1 &&
    typeof value.createdAt === "number" &&
    typeof value.updatedAt === "number"
  );
}

/** The bytes of a regular file (never through a link), null when it is absent, a link or anything else. */
export function readRegular(path: string): Buffer | null {
  try {
    if (!lstatSync(path).isFile()) return null;
    return readFileSync(path);
  } catch {
    return null;
  }
}

function readJson(path: string): unknown {
  const bytes = readRegular(path);
  if (bytes === null) return null;
  try {
    return JSON.parse(bytes.toString("utf-8"));
  } catch {
    return null;
  }
}

export function readMetaFile(systemDir: string, id: string): DesignSystemMeta | null {
  const value = readJson(join(systemDir, "meta.json"));
  return isDesignMeta(value, id) ? value : null;
}

export function writeMetaFile(systemDir: string, meta: DesignSystemMeta): void {
  replaceFileAtomically(join(systemDir, "meta.json"), `${JSON.stringify(meta, null, 2)}\n`, 0o644);
}

export function versionDirOf(systemDir: string, version: number): string {
  return join(systemDir, "versions", String(version));
}

export function readVersionMeta(systemDir: string, version: number): DesignSystemMeta | null {
  const value = readJson(join(versionDirOf(systemDir, version), "version.json"));
  return isRecord(value) && isDesignMeta(value.meta) && value.meta.version === version
    ? value.meta
    : null;
}

/** The complete versions of a system, highest first. */
export function versionNumbers(systemDir: string): number[] {
  try {
    return readdirSync(join(systemDir, "versions"), { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && /^[1-9][0-9]{0,8}$/.test(entry.name))
      .map((entry) => Number(entry.name))
      .filter((version) => readVersionMeta(systemDir, version) !== null)
      .sort((a, b) => b - a);
  } catch {
    return [];
  }
}

/** The files of a folder (a version or the top level) that make up a system: generated files, logo, fonts. */
export function listSystemFiles(dir: string): string[] {
  const files: string[] = [];
  try {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isFile()) continue;
      if (GENERATED_FILES.includes(entry.name) || LOGO_FILE_PATH.test(entry.name))
        files.push(entry.name);
    }
    for (const entry of readdirSync(join(dir, "fonts"), { withFileTypes: true })) {
      const path = `fonts/${entry.name}`;
      if (entry.isFile() && FONT_FILE_PATH.test(path)) files.push(path);
    }
  } catch {
    // A system without fonts has no fonts folder.
  }
  return files.sort();
}

/** Removes what a crash may leave behind: half-written version folders and temp files of atomic writes. */
export function sweepStale(systemDir: string): void {
  const sweep = (dir: string, match: (name: string) => boolean): void => {
    try {
      for (const entry of readdirSync(dir))
        if (match(entry)) rmSync(join(dir, entry), { recursive: true, force: true });
    } catch {
      // Nothing there.
    }
  };
  // A numbered folder without its version.json is not a version (the writer renames a staged folder in complete).
  sweep(
    join(systemDir, "versions"),
    (name) =>
      name.startsWith(STAGING) ||
      (/^[1-9][0-9]{0,8}$/.test(name) && readVersionMeta(systemDir, Number(name)) === null),
  );
  sweep(systemDir, (name) => name.endsWith(".tmp"));
  sweep(join(systemDir, "fonts"), (name) => name.endsWith(".tmp"));
}

/**
 * Writes a version completely under a staging folder, `version.json` last, then renames the folder into
 * `versions/<n>/`: a folder with that name is always whole. Files marked `null` are copied from `previousDir`.
 */
export function writeVersion(
  systemDir: string,
  version: number,
  files: StagedFile[],
  meta: DesignSystemMeta,
  previousDir: string | null,
): void {
  const versions = join(systemDir, "versions");
  const staging = join(versions, `${STAGING}${randomUUID()}`);
  mkdirSync(staging, { recursive: true });
  try {
    for (const file of files) {
      const target = join(staging, file.path);
      if (file.path.includes("/")) mkdirSync(join(target, ".."), { recursive: true });
      const bytes =
        file.data ?? (previousDir === null ? null : readRegular(join(previousDir, file.path)));
      if (bytes === null) throw new Error(`the previous version has no ${file.path} to carry over`);
      writeFileSync(target, bytes, { flag: "wx" });
    }
    const record: VersionRecord = { schema: "openvids.design-version/1", meta };
    writeFileSync(join(staging, "version.json"), `${JSON.stringify(record, null, 2)}\n`, {
      flag: "wx",
    });
    renameSync(staging, versionDirOf(systemDir, version));
  } catch (error) {
    rmSync(staging, { recursive: true, force: true });
    throw error;
  }
}

/**
 * Makes the top level of a system show version `version`: its files are replaced one by one (atomically), files of
 * older versions are removed, and `meta.json` goes last, so a crash in between leaves `meta.json` behind the versions
 * and the next locked write re-runs this. Idempotent.
 */
export function materialise(systemDir: string, version: number): void {
  const source = versionDirOf(systemDir, version);
  const meta = readVersionMeta(systemDir, version);
  if (meta === null) throw new Error(`version ${version} is missing`);
  const files = listSystemFiles(source);
  if (files.some((file) => file.startsWith("fonts/")))
    mkdirSync(join(systemDir, "fonts"), { recursive: true });
  for (const file of files) {
    const bytes = readRegular(join(source, file));
    if (bytes === null) throw new Error(`${file} of version ${version} is unreadable`);
    const current = readRegular(join(systemDir, file));
    if (current !== null && current.equals(bytes)) continue;
    replaceFileAtomically(join(systemDir, file), bytes, 0o644);
  }
  for (const file of listSystemFiles(systemDir))
    if (!files.includes(file)) rmSync(join(systemDir, file), { force: true });
  try {
    if (readdirSync(join(systemDir, "fonts")).length === 0)
      rmSync(join(systemDir, "fonts"), { recursive: true });
  } catch {
    // No fonts folder.
  }
  writeMetaFile(systemDir, meta);
}

/** Re-materialises the top level when it is behind the newest complete version (or has no readable `meta.json`). */
export function recoverSystem(systemDir: string, id: string): void {
  if (!existsSync(systemDir)) return;
  sweepStale(systemDir);
  const newest = versionNumbers(systemDir)[0];
  if (newest === undefined) return;
  const top = readMetaFile(systemDir, id);
  if (top === null || top.version < newest) materialise(systemDir, newest);
}

/** Whether the top level of a system is behind its newest complete version. */
export function isBehind(systemDir: string, id: string): boolean {
  const newest = versionNumbers(systemDir)[0];
  if (newest === undefined) return false;
  const top = readMetaFile(systemDir, id);
  return top === null || top.version < newest;
}
