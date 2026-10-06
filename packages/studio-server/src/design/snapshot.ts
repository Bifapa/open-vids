import { randomUUID } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  rmdirSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import {
  isRecord,
  type AttachedDesign,
  type ProjectDesignState,
} from "@hyperframes/agent-protocol";
import { replaceFileAtomically } from "../helpers/atomicFile.js";
import { pinWithinProject } from "../helpers/safePath.js";
import { FONT_FILE_PATH } from "./css.js";
import { DesignFailure } from "./errors.js";
import type { DesignLibrary } from "./library.js";
import { LOGO_FILE_PATH } from "./manifest.js";
import { parseDesignSystemHtml } from "./parse.js";
import { validateDesignSystemHtml } from "./validate.js";

/** The part of the library a project snapshot reads. */
export type SnapshotLibrary = Pick<DesignLibrary, "currentDir" | "snapshotFiles" | "readMeta">;

export const PROJECT_DESIGN_DIR = "design";
const ATTACHED_FILE = "design.json";
const STAGING_PARENT = ".hyperframes";
const STAGING_PREFIX = "design-staging-";
/** Written last into a staging folder: the record of the snapshot being replaced and the one being installed. */
const PREVIOUS_FILE = "previous.json";
const MAX_FILE_BYTES = 8 * 1024 * 1024;
const MAX_TOTAL_BYTES = 64 * 1024 * 1024;

function isAttached(value: unknown): value is AttachedDesign {
  return (
    isRecord(value) &&
    value.schema === "openvids.project-design/1" &&
    typeof value.id === "string" &&
    typeof value.version === "number" &&
    typeof value.name === "string" &&
    typeof value.attachedAt === "number" &&
    (value.createdAt === undefined || typeof value.createdAt === "number") &&
    Array.isArray(value.unknownLicenses) &&
    Array.isArray(value.nonPortableFonts)
  );
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

/**
 * `previous.json` of a staging folder, written after every file and `design.json` are staged: the snapshot files being
 * replaced, and every project-relative file the new snapshot consists of. (Older folders held the first list only.)
 */
interface StagingRecord {
  previous: string[];
  incoming: string[];
}

function readStagingRecord(stagingDir: string): StagingRecord | null {
  const value = readJson(join(stagingDir, PREVIOUS_FILE));
  if (!isRecord(value) || !isStringArray(value.previous) || !isStringArray(value.incoming))
    return null;
  return { previous: value.previous, incoming: value.incoming };
}

/** The bytes `design/design.json` holds: the shell writes the same layout (2-space JSON, trailing newline). */
function attachedJson(attached: AttachedDesign): string {
  return `${JSON.stringify(
    {
      schema: attached.schema,
      id: attached.id,
      version: attached.version,
      name: attached.name,
      attachedAt: attached.attachedAt,
      ...(attached.createdAt !== undefined && { createdAt: attached.createdAt }),
      unknownLicenses: attached.unknownLicenses,
      nonPortableFonts: attached.nonPortableFonts,
    },
    null,
    2,
  )}\n`;
}

function readJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf-8"));
  } catch {
    return undefined;
  }
}

/** Absolute path inside the project for a project-relative one, with links resolved; refuses an escape. */
function insideProject(projectDir: string, relative: string): string {
  const abs = pinWithinProject(projectDir, relative);
  if (abs === null) {
    throw new DesignFailure("invalid_request", `"${relative}" is outside the project`);
  }
  return abs;
}

/** The project's own record of its snapshot (`design/design.json`); null when absent or not one. */
export function readAttachedDesign(projectDir: string): AttachedDesign | null {
  const record = readJson(join(projectDir, PROJECT_DESIGN_DIR, ATTACHED_FILE));
  return isAttached(record) ? record : null;
}

// ── What the snapshot's files are ────────────────────────────────────────────

/**
 * Project-relative files the snapshot in `design/` wrote: `system.html`, `tokens.css`, `design.json`, the fonts its
 * `tokens.css`/manifest name and its logo. Anything else under `design/` belongs to the user.
 */
export function projectSnapshotFiles(projectDir: string): string[] {
  const names = new Set<string>(["system.html", "tokens.css", ATTACHED_FILE]);
  const dir = join(projectDir, PROJECT_DESIGN_DIR);
  try {
    const tokens = readFileSync(join(dir, "tokens.css"), "utf-8");
    for (const match of tokens.matchAll(/url\(\s*["']?(fonts\/[^"')\s]+)["']?\s*\)/g)) {
      if (match[1] !== undefined && FONT_FILE_PATH.test(match[1])) names.add(match[1]);
    }
  } catch {
    // No tokens.css: only the files named below.
  }
  try {
    const { manifest } = parseDesignSystemHtml(readFileSync(join(dir, "system.html"), "utf-8"));
    for (const font of manifest.fonts) {
      for (const file of font.files) if (FONT_FILE_PATH.test(file.path)) names.add(file.path);
    }
    if (manifest.logo && LOGO_FILE_PATH.test(manifest.logo.path)) names.add(manifest.logo.path);
  } catch {
    // An unreadable system.html names nothing more.
  }
  // `design.json` goes last: a detach interrupted halfway still shows the snapshot as attached (and broken).
  return [...names]
    .sort((a, b) => Number(a === ATTACHED_FILE) - Number(b === ATTACHED_FILE) || (a < b ? -1 : 1))
    .map((name) => `${PROJECT_DESIGN_DIR}/${name}`);
}

function removeFiles(projectDir: string, files: readonly string[]): void {
  for (const file of files) {
    const abs = pinWithinProject(projectDir, file);
    if (abs === null) continue;
    try {
      if (lstatSync(abs).isFile()) rmSync(abs);
    } catch {
      // Already gone.
    }
  }
  for (const folder of [join(PROJECT_DESIGN_DIR, "fonts"), PROJECT_DESIGN_DIR]) {
    const abs = pinWithinProject(projectDir, folder);
    try {
      if (abs !== null && readdirSync(abs).length === 0) rmdirSync(abs);
    } catch {
      // Not there, or not empty: the user's files stay.
    }
  }
}

// ── Staging and recovery ─────────────────────────────────────────────────────

function stagingDirs(projectDir: string): string[] {
  try {
    return readdirSync(join(projectDir, STAGING_PARENT))
      .filter((name) => name.startsWith(STAGING_PREFIX))
      .map((name) => join(projectDir, STAGING_PARENT, name));
  } catch {
    return [];
  }
}

function ownerAlive(stagingDir: string): boolean {
  const pid = Number(/design-staging-(\d+)-/.exec(stagingDir)?.[1]);
  if (!Number.isInteger(pid) || pid === process.pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error instanceof Error && Reflect.get(error, "code") === "EPERM";
  }
}

function filesUnder(root: string, prefix = ""): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(join(root, prefix), { withFileTypes: true })) {
    const rel = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) found.push(...filesUnder(root, rel));
    else if (entry.isFile()) found.push(rel);
  }
  return found;
}

/** The order the files go live in: `design.json` last, so the record never runs ahead of the files it describes. */
function swapOrder(relative: string): number {
  if (relative === ATTACHED_FILE) return 3;
  if (relative === "system.html") return 2;
  if (relative === "tokens.css") return 1;
  return 0;
}

/**
 * Moves a fully staged snapshot into `design/` (file by file, `design.json` last), then drops what it replaces. The
 * set of files to keep comes from the staging record, not from what is left in the folder, so a swap that was
 * interrupted after some renames and is finished later never removes a file it had already installed. A folder
 * without a record (the shell's, or an older one) falls back to the files still in it.
 */
function applyStaged(projectDir: string, stagingDir: string): void {
  const record = readStagingRecord(stagingDir);
  const legacy = readJson(join(stagingDir, PREVIOUS_FILE));
  // A `.tmp` is a write the crash cut short (the record's), never part of the snapshot.
  const staged = filesUnder(stagingDir).filter(
    (file) => file !== PREVIOUS_FILE && !file.endsWith(".tmp"),
  );
  const incoming = new Set(
    record ? record.incoming : staged.map((file) => `${PROJECT_DESIGN_DIR}/${file}`),
  );
  const previous = record ? record.previous : isStringArray(legacy) ? legacy : [];
  for (const file of staged.sort((a, b) => swapOrder(a) - swapOrder(b) || (a < b ? -1 : 1))) {
    const target = insideProject(projectDir, `${PROJECT_DESIGN_DIR}/${file}`);
    mkdirSync(dirname(target), { recursive: true });
    renameSync(join(stagingDir, file), target);
  }
  removeFiles(
    projectDir,
    previous.filter((file) => !incoming.has(file) && file.startsWith(`${PROJECT_DESIGN_DIR}/`)),
  );
  rmSync(stagingDir, { recursive: true, force: true });
}

/** Finishes or drops what a crashed attach/update left in `.hyperframes/design-staging-*`: a folder is complete when
 * it has its record (or, from the shell or an older version, its `design.json`), and its swap is then completed; any
 * other is thrown away. Folders of another live process are left alone.
 */
function recoverStaging(projectDir: string): void {
  for (const stagingDir of stagingDirs(projectDir)) {
    if (ownerAlive(stagingDir)) continue;
    const complete =
      readStagingRecord(stagingDir) !== null ||
      isAttached(readJson(join(stagingDir, ATTACHED_FILE)));
    if (complete) {
      try {
        applyStaged(projectDir, stagingDir);
        continue;
      } catch {
        // A half-completed swap that cannot finish: the next attach rewrites it.
      }
    }
    rmSync(stagingDir, { recursive: true, force: true });
  }
}

// ── Reading ──────────────────────────────────────────────────────────────────

function snapshotReadable(projectDir: string): boolean {
  const dir = join(projectDir, PROJECT_DESIGN_DIR);
  try {
    const html = readFileSync(join(dir, "system.html"), "utf-8");
    return (
      existsSync(join(dir, "tokens.css")) &&
      validateDesignSystemHtml(html, {
        fileExists: (path) => existsSync(join(dir, path)),
      }).length === 0
    );
  } catch {
    return false;
  }
}

/**
 * Whether the library's entry is another system than the one the snapshot was taken from (the id was deleted and
 * created again: its version numbers started over). Only decided when both sides know their `createdAt`.
 */
function lineageChanged(attached: AttachedDesign, entry: { createdAt: number }): boolean {
  return attached.createdAt !== undefined && attached.createdAt !== entry.createdAt;
}

function stateOf(projectDir: string, library: SnapshotLibrary): ProjectDesignState {
  const attached = readAttachedDesign(projectDir);
  const entry = attached === null ? null : library.readMeta(attached.id);
  return {
    attached,
    library: entry ? { name: entry.name, version: entry.version } : null,
    updateAvailable:
      attached !== null &&
      entry !== null &&
      (entry.version > attached.version || lineageChanged(attached, entry)),
    snapshotOk: attached !== null && snapshotReadable(projectDir),
  };
}

/** The project's design state; finishes an interrupted attach/update first. */
export async function readProjectDesignState(
  projectDir: string,
  library: SnapshotLibrary,
): Promise<ProjectDesignState> {
  recoverStaging(projectDir);
  return stateOf(projectDir, library);
}

// ── Installing ───────────────────────────────────────────────────────────────

const LIBRARY_FILE = (relative: string): boolean =>
  relative === "system.html" ||
  relative === "tokens.css" ||
  LOGO_FILE_PATH.test(relative) ||
  FONT_FILE_PATH.test(relative);

/** Copies the library's current version into a staging folder, validating before and after; returns the folder. */
function stageFrom(
  projectDir: string,
  library: SnapshotLibrary,
  id: string,
): { stagingDir: string; attached: AttachedDesign } {
  const meta = library.readMeta(id);
  if (!meta) throw new DesignFailure("not_found", `No design system "${id}" in the library`);
  const { version, files } = library.snapshotFiles(id);
  const source = library.currentDir(id);
  for (const file of files) {
    if (!LIBRARY_FILE(file)) {
      throw new DesignFailure("invalid_system", `"${id}" lists an unexpected file: ${file}`);
    }
  }
  const htmlText = readSource(source, "system.html");
  const issues = validateDesignSystemHtml(htmlText, {
    expectedVersion: version,
    fileExists: (path) => files.includes(path),
  });
  if (issues.length > 0) {
    throw new DesignFailure("invalid_system", `"${id}" is not a valid design system`, issues);
  }
  if (!files.includes("tokens.css")) {
    throw new DesignFailure("invalid_system", `"${id}" has no tokens.css`);
  }
  if (readAttachedDesign(projectDir) === null) {
    // Without a snapshot of ours, a file with a snapshot's name is the user's: never overwrite it.
    const taken = [...files, ATTACHED_FILE].find((file) =>
      existsSync(insideProject(projectDir, `${PROJECT_DESIGN_DIR}/${file}`)),
    );
    if (taken !== undefined) {
      throw new DesignFailure(
        "conflict",
        `design/${taken} already exists and is not a design snapshot`,
      );
    }
  }

  const stagingDir = insideProject(
    projectDir,
    `${STAGING_PARENT}/${STAGING_PREFIX}${process.pid}-${randomUUID().slice(0, 8)}`,
  );
  try {
    let total = 0;
    for (const file of files) {
      const bytes = file === "system.html" ? Buffer.from(htmlText) : readBytes(source, file);
      total += bytes.length;
      if (total > MAX_TOTAL_BYTES) {
        throw new DesignFailure("invalid_system", `"${id}" is larger than the snapshot limit`);
      }
      const target = join(stagingDir, file);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, bytes);
    }
    const copied = readFileSync(join(stagingDir, "system.html"), "utf-8");
    const afterIssues = validateDesignSystemHtml(copied, {
      expectedVersion: version,
      fileExists: (path) => existsSync(join(stagingDir, path)),
    });
    if (afterIssues.length > 0 || copied !== htmlText) {
      throw new DesignFailure(
        "invalid_system",
        "The copied snapshot did not validate",
        afterIssues,
      );
    }
    const attached: AttachedDesign = {
      schema: "openvids.project-design/1",
      id,
      version,
      name: meta.name,
      attachedAt: Date.now(),
      createdAt: meta.createdAt,
      unknownLicenses: meta.unknownLicenses,
      nonPortableFonts: meta.nonPortableFonts,
    };
    replaceFileAtomically(join(stagingDir, ATTACHED_FILE), attachedJson(attached), 0o644);
    // The record goes last: a staging folder that has it is complete, whatever has been moved out of it since.
    const record: StagingRecord = {
      previous: projectSnapshotFiles(projectDir),
      incoming: [...files, ATTACHED_FILE].map((file) => `${PROJECT_DESIGN_DIR}/${file}`),
    };
    replaceFileAtomically(join(stagingDir, PREVIOUS_FILE), JSON.stringify(record), 0o644);
    return { stagingDir, attached };
  } catch (error) {
    rmSync(stagingDir, { recursive: true, force: true });
    throw error;
  }
}

function readBytes(root: string, relative: string): Buffer {
  const path = join(root, relative);
  const info = lstatSync(path);
  if (!info.isFile() || info.size > MAX_FILE_BYTES) {
    throw new DesignFailure("invalid_system", `${relative} is not a regular file of at most 8 MB`);
  }
  return readFileSync(path);
}

function readSource(root: string, relative: string): string {
  return readBytes(root, relative).toString("utf-8");
}

function install(projectDir: string, library: SnapshotLibrary, id: string): void {
  const { stagingDir } = stageFrom(projectDir, library, id);
  applyStaged(projectDir, stagingDir);
}

/**
 * Attaches (or switches to) a library system: copies its current version into the project's `design/` through a
 * staging folder (`design.json` last). Writes only inside `design/`; never a composition. Each call runs without
 * yielding, so two changes to one project never interleave.
 */
export async function attachDesign(
  projectDir: string,
  library: SnapshotLibrary,
  id: string,
): Promise<ProjectDesignState> {
  recoverStaging(projectDir);
  install(projectDir, library, id);
  return stateOf(projectDir, library);
}

/** Brings the snapshot to the library's current version; refused (`conflict`) when it is already current and intact. */
export async function updateDesign(
  projectDir: string,
  library: SnapshotLibrary,
): Promise<ProjectDesignState> {
  recoverStaging(projectDir);
  const attached = readAttachedDesign(projectDir);
  if (attached === null) {
    throw new DesignFailure("not_found", "No design system is attached to this project");
  }
  const entry = library.readMeta(attached.id);
  if (!entry) {
    throw new DesignFailure(
      "not_found",
      `The design system "${attached.name}" is no longer in the library`,
    );
  }
  if (
    entry.version <= attached.version &&
    !lineageChanged(attached, entry) &&
    snapshotReadable(projectDir)
  ) {
    throw new DesignFailure("conflict", "The project already has the library's latest version");
  }
  install(projectDir, library, attached.id);
  return stateOf(projectDir, library);
}

/** Removes exactly the files the snapshot wrote (and `design/` when that leaves it empty); nothing without a snapshot. */
export async function detachDesign(
  projectDir: string,
  library: SnapshotLibrary,
): Promise<ProjectDesignState> {
  recoverStaging(projectDir);
  if (readAttachedDesign(projectDir) !== null) {
    removeFiles(projectDir, projectSnapshotFiles(projectDir));
  }
  return stateOf(projectDir, library);
}
