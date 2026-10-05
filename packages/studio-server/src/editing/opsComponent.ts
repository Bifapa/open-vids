import { existsSync, readFileSync, readdirSync, rmSync, rmdirSync, statSync } from "node:fs";
import type {
  ClipProvenance,
  EditOperation,
  EditOperationResult,
} from "@hyperframes/agent-protocol";
import { writeClipTiming } from "@hyperframes/core/composition-contract";
import { replaceFileAtomically } from "../helpers/atomicFile.js";
import {
  CompositionInsertionError,
  insertCompositionIntoSource,
} from "../helpers/compositionInsertion.js";
import { isInHiddenOrVendorDir, resolveWithinProject, walkDir } from "../helpers/safePath.js";
import { commit, loadModel, round3, setRootDuration, type Batch, type EditEnv } from "./batch.js";
import { EditFailure } from "./errors.js";
import { resolveProjectRelative, stampProvenance } from "./timeline.js";

/** The files an install updates besides the item's own: the project config and the install record. */
const INSTALL_BOOKKEEPING = ["hyperframes.json", "hyperframes.lock.json"];

export function readBookkeeping(projectDir: string): Map<string, string | null> {
  const contents = new Map<string, string | null>();
  for (const file of INSTALL_BOOKKEEPING) {
    const abs = resolveWithinProject(projectDir, file);
    contents.set(file, abs && existsSync(abs) ? readFileSync(abs, "utf-8") : null);
  }
  return contents;
}

/** Removes the folders left empty by taking a file away, innermost first, stopping at the project root. */
function pruneEmptyParents(projectDir: string, file: string): void {
  const segments = file.split("/").slice(0, -1);
  while (segments.length > 0) {
    const abs = resolveWithinProject(projectDir, segments.join("/"));
    if (!abs || !existsSync(abs)) {
      segments.pop();
      continue;
    }
    if (readdirSync(abs).length > 0) return;
    rmdirSync(abs);
    segments.pop();
  }
}

/** Takes back what the batch's installs put in the project: new files and the folders they made are removed, the config and record restored. */
export function undoInstalls(projectDir: string, batch: Batch): void {
  for (const file of batch.fresh) {
    const abs = resolveWithinProject(projectDir, file);
    if (abs) rmSync(abs, { force: true });
  }
  // A folder is only taken once empty, so one that held anything before the install stays.
  for (const file of batch.fresh) pruneEmptyParents(projectDir, file);
  for (const [file, content] of batch.bookkeeping ?? []) {
    const abs = resolveWithinProject(projectDir, file);
    if (!abs) continue;
    if (content === null) rmSync(abs, { force: true });
    else if (!existsSync(abs) || readFileSync(abs, "utf-8") !== content) {
      replaceFileAtomically(abs, content, existsSync(abs) ? statSync(abs).mode : 0o644);
    }
  }
}

/** Restyles installed components to sit over the video, as Studio's Catalog does after installing one. */
function makeComponentBackgroundTransparent(projectDir: string, file: string): void {
  const abs = resolveWithinProject(projectDir, file);
  if (!abs || !existsSync(abs)) return;
  const content = readFileSync(abs, "utf-8");
  const transparent = content.replace(
    /background:\s*(?:#(?:0a0a0a|000000|000|0a0805)|rgba?\([^)]*\))\s*;/g,
    "background: transparent;",
  );
  if (transparent !== content) replaceFileAtomically(abs, transparent, statSync(abs).mode);
}

export async function addComponent(
  env: EditEnv,
  batch: Batch,
  op: Extract<EditOperation, { op: "add_component" }>,
): Promise<EditOperationResult> {
  const { listRegistryCatalog, installRegistryBlock } = env.adapter;
  if (!listRegistryCatalog || !installRegistryBlock) {
    throw new EditFailure("unsupported", "This Studio server has no registry to install from");
  }
  const catalog = await listRegistryCatalog();
  const item = catalog.find(
    (candidate) =>
      candidate.name === op.name &&
      (candidate.type === "hyperframes:block" || candidate.type === "hyperframes:component"),
  );
  if (!item) {
    throw new EditFailure("unknown_preset", `No block or component "${op.name}" in the registry`);
  }
  // What the install adds is taken back if the batch is refused, so the project keeps what it had.
  const existing = new Set(walkDir(env.project.dir));
  batch.bookkeeping ??= readBookkeeping(env.project.dir);
  let installed;
  try {
    installed = await installRegistryBlock({ project: env.project, blockName: item.name });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new EditFailure("unsupported", `Installing "${item.name}" failed: ${message}`);
  }
  batch.installed.push(...installed.written);
  for (const path of installed.written) {
    if (!existing.has(path) && !isInHiddenOrVendorDir(path)) batch.fresh.push(path);
  }
  const file = installed.primary ?? installed.written.find((path) => path.endsWith(".html"));
  if (!file?.endsWith(".html")) {
    throw new EditFailure("unsupported", `"${item.name}" installs no composition file to mount`);
  }
  // A file the install kept because the user changed it since is theirs: it is mounted as it is, never restyled.
  if (item.type === "hyperframes:component" && installed.written.includes(file)) {
    makeComponentBackgroundTransparent(env.project.dir, file);
  }

  return mountFile(env, batch, file, `"${item.name}"`, op.op, op);
}

interface MountOptions {
  start: number;
  track: number;
  duration?: number;
  provenance?: Partial<ClipProvenance>;
}

/**
 * Mounts a composition file as a clip of the batch's composition with Studio's drop helper: unique host id, a free
 * track near the wanted one, the file's own size and length unless the caller sets a length.
 */
async function mountFile(
  env: EditEnv,
  batch: Batch,
  file: string,
  label: string,
  opName: "add_component" | "mount_composition",
  options: MountOptions,
): Promise<EditOperationResult> {
  // The mount helper needs a positive parent length; the batch's final length rule settles the real one.
  const before = await loadModel(env, batch.html);
  if (before.duration <= 0) {
    setRootDuration(before, options.start + (options.duration ?? 1));
    commit(batch, before);
  }
  let inserted;
  try {
    inserted = insertCompositionIntoSource({
      projectDir: env.project.dir,
      targetPath: env.compositionPath,
      sourcePath: file,
      parentSource: batch.html,
      start: options.start,
      desiredTrack: options.track,
    });
  } catch (error) {
    if (!(error instanceof CompositionInsertionError)) throw error;
    throw new EditFailure(
      "unsupported",
      `${label} cannot be mounted as a clip: ${error.message}. It is a snippet, not a standalone composition`,
    );
  }
  batch.html = inserted.html;

  const model = await loadModel(env, batch.html);
  const host = model.clips.find((clip) => clip.domId === inserted.hostId);
  if (!host) throw new Error(`Mounted host "${inserted.hostId}" is missing from the composition`);
  if (options.duration !== undefined) {
    writeClipTiming(host.element, { duration: round3(options.duration) });
  }
  stampProvenance(host.element, options.provenance);
  commit(batch, model);
  return { op: opName, clipId: host.id, newClipId: null };
}

/** Mounts a composition file that is already in the project as a clip (a Studio drop of the file). */
export async function mountComposition(
  env: EditEnv,
  batch: Batch,
  op: Extract<EditOperation, { op: "mount_composition" }>,
): Promise<EditOperationResult> {
  const path = resolveProjectRelative(env.compositionPath, op.composition);
  const abs = path === null ? null : resolveWithinProject(env.project.dir, path);
  if (
    path === null ||
    abs === null ||
    !path.endsWith(".html") ||
    !existsSync(abs) ||
    !statSync(abs).isFile()
  ) {
    throw new EditFailure(
      "unknown_composition",
      `"${op.composition}" is not a composition (.html) file in this project`,
    );
  }
  if (path === env.compositionPath) {
    throw new EditFailure("invalid_request", "A composition cannot be mounted into itself");
  }
  return mountFile(env, batch, path, `"${op.composition}"`, op.op, op);
}
