import { existsSync, readFileSync, statSync } from "node:fs";
import { posix } from "node:path";
import type {
  ApplyEditsRequest,
  ApplyEditsResponse,
  EditOperation,
  EditOperationResult,
} from "@hyperframes/agent-protocol";
import { resolveWithinProject } from "../helpers/safePath.js";
import {
  EPS,
  declaredLength,
  loadModel,
  commit,
  setRootDuration,
  type Batch,
  type EditEnv,
} from "./batch.js";
import { AI_EDIT_ATTRIBUTE, aiEditStamp, clipState } from "./clipState.js";
import { commitWrites, conflict, type PendingWrite } from "./commit.js";
import { EditFailure, isEditFailure } from "./errors.js";
import { addClip, addSequence, addText } from "./opsAdd.js";
import { retimeCaptions, applyCaptions } from "./opsCaptions.js";
import { setCanvas, setComposition } from "./opsCanvas.js";
import {
  arrangeTrack,
  moveClip,
  removeClip,
  setClip,
  setLocked,
  setSpeed,
  splitClip,
  trimClip,
} from "./opsClips.js";
import { addComponent, mountComposition, undoInstalls } from "./opsComponent.js";
import { duckAudio, setAudioFx, setColorGrade, setVolumeAutomation } from "./opsEffects.js";
import { captionsFromTranscript } from "./opsTranscript.js";
import { recallApplied, rememberApplied } from "./replay.js";
import { editingVersion, findClip, parseComposition, toSnapshot } from "./timeline.js";
import { overlapWarnings } from "./warnings.js";
import { isUntouchedTemplatePlaceholder } from "./placeholder.js";

export { MEDIA_OVERRUN_TOLERANCE, type EditEnv } from "./batch.js";

async function runOperation(
  env: EditEnv,
  batch: Batch,
  op: EditOperation,
): Promise<EditOperationResult> {
  switch (op.op) {
    case "add_clip":
      return addClip(env, batch, op);
    case "add_sequence":
      return addSequence(env, batch, op);
    case "add_text":
      return addText(env, batch, op, await loadModel(env, batch.html));
    case "add_component":
      return addComponent(env, batch, op);
    case "apply_captions":
      return applyCaptions(env, batch, op);
    case "remove_clip":
      return removeClip(env, batch, op);
    case "move_clip":
      return moveClip(env, batch, op);
    case "trim_clip":
      return trimClip(env, batch, op);
    case "split_clip":
      return splitClip(env, batch, op);
    case "set_clip":
      return setClip(env, batch, op);
    case "arrange_track":
      return arrangeTrack(env, batch, op);
    case "set_composition":
      return setComposition(env, batch, op);
    case "set_canvas":
      return setCanvas(env, batch, op);
    case "set_speed":
      return setSpeed(env, batch, op);
    case "retime_captions":
      return retimeCaptions(env, batch, op);
    case "captions_from_transcript":
      return captionsFromTranscript(env, batch, op);
    case "mount_composition":
      return mountComposition(env, batch, op);
    case "set_color_grade":
      return setColorGrade(env, batch, op);
    case "set_audio_fx":
      return setAudioFx(env, batch, op);
    case "set_volume_automation":
      return setVolumeAutomation(env, batch, op);
    case "duck_audio":
      return duckAudio(env, batch, op);
    case "set_locked":
      return setLocked(env, batch, op);
  }
}

/** An add operation of an agent turn records the turn as its provenance unless it names one itself. */
function withTurn(op: EditOperation, turnId: string | undefined): EditOperation {
  if (turnId === undefined) return op;
  switch (op.op) {
    case "add_clip":
    case "add_sequence":
    case "add_text":
    case "add_component":
    case "mount_composition":
      return op.provenance?.turn ? op : { ...op, provenance: { ...op.provenance, turn: turnId } };
    default:
      return op;
  }
}

async function applyOperation(
  env: EditEnv,
  batch: Batch,
  op: EditOperation,
): Promise<EditOperationResult> {
  const result = await runOperation(env, batch, withTurn(op, env.turnId));
  switch (op.op) {
    case "move_clip":
    case "trim_clip":
    case "set_clip":
    case "split_clip":
    case "set_speed":
    case "set_color_grade":
    case "set_audio_fx":
    case "set_volume_automation":
    case "duck_audio":
      if (result.clipId) batch.touched.add(result.clipId);
      break;
    case "arrange_track":
      for (const ref of op.clips) batch.touched.add(ref);
      break;
    default:
      break;
  }
  return result;
}

/**
 * Without an explicit `set_composition`, the length only grows with the content (a deliberate tail survives a trim; to
 * shorten, say so with `set_composition`). The one length that may shrink is the blank template's own 10 s once its
 * placeholder is gone. Clips an agent turn changed get its `data-ov-ai-edit` stamp over their final state.
 */
async function followContentLength(env: EditEnv, batch: Batch): Promise<void> {
  const model = await loadModel(env, batch.html);
  if (!batch.explicitDuration && model.clips.length > 0) {
    const contentEnd = model.clips.reduce((max, clip) => Math.max(max, clip.end), 0);
    const target = Math.max(contentEnd, declaredLength(batch, model));
    if (Math.abs(target - model.duration) > EPS) setRootDuration(model, target);
  }
  if (env.turnId !== undefined) {
    for (const ref of batch.touched) {
      const clip = findClip(model, ref);
      if (clip)
        clip.element.setAttribute(AI_EDIT_ATTRIBUTE, aiEditStamp(env.turnId, clipState(clip)));
    }
  }
  // Serialising here also stamps stable ids on anything the batch left without one.
  commit(batch, model);
}

function throwIfCancelled(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw new EditFailure("aborted", "The edit was cancelled before anything was written");
  }
}

/**
 * Applies a batch to one composition. Operations run in order against an in-memory copy; the first refusal aborts
 * the batch with its index and nothing is written. On success the composition and every other file the batch wrote
 * (captions, installed registry files) reach the disk at one commit point, and the response carries the fresh timeline.
 * A `requestId` the service has applied before answers with the stored result; `dryRun` does everything but the write.
 */
export async function applyEdits(
  env: EditEnv,
  request: ApplyEditsRequest,
  options: { signal?: AbortSignal } = {},
): Promise<ApplyEditsResponse> {
  const path = posix.normalize(env.compositionPath);
  const scoped: EditEnv = {
    ...env,
    compositionPath: path,
    ...(request.turnId !== undefined && { turnId: request.turnId }),
  };
  const { signal } = options;
  const { requestId } = request;
  throwIfCancelled(signal);
  const abs = resolveWithinProject(env.project.dir, path);
  if (!abs || !path.endsWith(".html") || !existsSync(abs) || !statSync(abs).isFile()) {
    throw new EditFailure("unknown_composition", `No composition "${request.composition ?? path}"`);
  }
  const original = readFileSync(abs, "utf-8");
  if (requestId !== undefined && !request.dryRun) {
    // A repeat of a batch that is already in: every file it wrote is exactly as that batch left it. Once anything
    // else has changed one of them, the same id is a new application (the same moves can be wanted again later).
    const stored = recallApplied(env.project.dir, path, requestId);
    if (stored) return { ...stored, replayed: true };
  }
  if (
    request.baseVersion !== undefined &&
    request.baseVersion.replace(/^"|"$/g, "") !== editingVersion(original)
  ) {
    throw new EditFailure(
      "conflict",
      `${path} changed since the timeline was read (version ${request.baseVersion}); read it again`,
    );
  }
  const before = parseComposition(original, path);
  if (!before) {
    throw new EditFailure(
      "unknown_composition",
      `${path} is not a composition (no data-composition-id)`,
    );
  }

  const batch: Batch = {
    html: original,
    explicitDuration: false,
    files: new Map(),
    installed: [],
    fresh: [],
    touched: new Set(),
    warnings: [],
    hadPlaceholder: before.clips.some((clip) => isUntouchedTemplatePlaceholder(clip.element)),
  };
  const results: EditOperationResult[] = [];
  const writes: PendingWrite[] = [];
  try {
    for (const [index, op] of request.operations.entries()) {
      throwIfCancelled(signal);
      if (request.dryRun && op.op === "add_component") {
        // The install writes registry files into the project, which a dry run must never do.
        throw new EditFailure(
          "unsupported",
          "add_component cannot be dry-run: it installs files into the project",
        ).atOperation(index);
      }
      try {
        results.push(await applyOperation(scoped, batch, op));
      } catch (error) {
        throw isEditFailure(error) ? error.atOperation(index) : error;
      }
    }
    await followContentLength(scoped, batch);
    const after = await loadModel(scoped, batch.html);
    const preModel = await loadModel(scoped, original);
    batch.warnings.push(...overlapWarnings(preModel, after));

    for (const [file, content] of batch.files) {
      const existing = resolveWithinProject(env.project.dir, file);
      const previous = existing && existsSync(existing) ? readFileSync(existing, "utf-8") : null;
      if (previous !== content) writes.push({ path: file, content, expected: null });
    }
    if (batch.html !== original) {
      writes.push({ path, content: batch.html, expected: original });
    }

    if (!request.dryRun) {
      // Checked before anything is written: the first write must not land when the batch is refused.
      if (writes.length > 0 && readFileSync(abs, "utf-8") !== original) throw conflict(path);
      throwIfCancelled(signal);
      commitWrites(
        env.project.dir,
        // The composition goes last: Studio reloading it finds the files it mounts already in place.
        [...writes].sort((a, b) => Number(a.path === path) - Number(b.path === path)),
      );
    }
  } catch (error) {
    // A refused batch leaves nothing behind, the registry files its add_component operations installed included.
    undoInstalls(env.project.dir, batch);
    throw error;
  }

  const changedFiles = writes.map((write) => write.path);
  if (batch.html !== original) {
    changedFiles.splice(changedFiles.indexOf(path), 1);
    changedFiles.unshift(path);
  }
  for (const file of batch.installed) if (!changedFiles.includes(file)) changedFiles.push(file);

  const model = await loadModel(scoped, batch.html);
  const response: ApplyEditsResponse = {
    timeline: toSnapshot(model, path, batch.html, (media) =>
      env.facts.peek(env.project.dir, media),
    ),
    results,
    changedFiles,
    ...(batch.warnings.length > 0 && { warnings: batch.warnings }),
    ...(request.dryRun && { dryRun: true as const }),
  };
  if (requestId !== undefined && !request.dryRun) {
    rememberApplied(env.project.dir, path, requestId, response, changedFiles);
  }
  return response;
}
