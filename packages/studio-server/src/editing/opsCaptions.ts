import { existsSync, readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import type { EditOperation, EditOperationResult } from "@hyperframes/agent-protocol";
import {
  buildTimelineAssetId,
  resolveTimelineAssetSrc,
} from "@hyperframes/core/editing/timeline-asset";
import { writeClipTiming } from "@hyperframes/core/composition-contract";
import { ensureHfIds } from "@hyperframes/parsers/hf-ids";
import { resolveWithinProject } from "../helpers/safePath.js";
import {
  declaredLength,
  EPS,
  MEDIA_OVERRUN_TOLERANCE,
  canvasOf,
  captionsZIndex,
  commit,
  fmt,
  loadModel,
  maxTrack,
  nextZIndex,
  round3,
  setStyle,
  styledZIndex,
  usedIds,
  type Batch,
  type EditEnv,
} from "./batch.js";
import {
  buildCaptionsComposition,
  captionSkinPath,
  captionsFileFor,
  cuesToGroups,
  findCaptionsHost,
} from "./captions.js";
import { readStoredDuration, readStoredGroups, withStoredGroups } from "./captionData.js";
import { EditFailure } from "./errors.js";

export async function applyCaptions(
  env: EditEnv,
  batch: Batch,
  op: Extract<EditOperation, { op: "apply_captions" }>,
): Promise<EditOperationResult> {
  const skinsDir = env.adapter.captionSkinsDir?.() ?? null;
  if (!skinsDir) {
    throw new EditFailure("unsupported", "The caption presets are not installed with this Studio");
  }
  const skinFile = captionSkinPath(skinsDir, op.preset);
  if (!skinFile) {
    throw new EditFailure("unknown_preset", `No caption preset "${op.preset}"`);
  }

  const model = await loadModel(env, batch.html);
  const captionsFile = captionsFileFor(env.compositionPath);
  const hostSrc = resolveTimelineAssetSrc(env.compositionPath, captionsFile);
  const found = findCaptionsHost(model.clips, env.compositionPath);
  const existing = found?.host;
  if (existing?.locked) throw new EditFailure("locked", "The captions clip is locked");

  // Captions span the composition: its declared length when set explicitly, else what the other clips add up to.
  const others = model.clips.filter((clip) => clip !== existing);
  const contentEnd = others.reduce((max, clip) => Math.max(max, clip.end), 0);
  const duration =
    batch.explicitDuration || others.length === 0
      ? model.duration
      : Math.max(contentEnd, declaredLength(batch, model), EPS);
  if (duration <= 0) {
    throw new EditFailure("out_of_bounds", "The composition has no length to caption yet");
  }
  const late = op.cues.find((cue) => cue.end > duration + MEDIA_OVERRUN_TOLERANCE);
  if (late) {
    throw new EditFailure(
      "out_of_bounds",
      `Cue "${late.text.slice(0, 40)}" ends at ${fmt(late.end)}s, past the composition end (${fmt(duration)}s)`,
    );
  }
  const groups = cuesToGroups(op.cues);
  if (!Array.isArray(groups)) {
    throw new EditFailure("invalid_request", "Caption cues must not start at the same time");
  }

  const canvas = canvasOf(model);
  // Written with its stable ids already in place: otherwise the host stamps them into the file on the next preview
  // or project open — a second write outside the turn that made the captions, which `Revert this turn` then treats as
  // a later edit and keeps.
  batch.files.set(
    captionsFile,
    ensureHfIds(
      buildCaptionsComposition({
        skin: readFileSync(skinFile, "utf-8"),
        groups,
        duration,
        width: canvas.width,
        height: canvas.height,
      }),
    ),
  );

  if (existing) {
    // A host still mounting the shared captions file is pointed at this composition's own, so it stops playing
    // the main video's cues and re-captioning replaces it instead of stacking a second layer.
    if (found?.legacy) existing.element.setAttribute("data-composition-src", hostSrc);
    writeClipTiming(existing.element, {
      start: 0,
      duration: round3(duration),
      ...(op.track !== undefined && { trackIndex: op.track }),
    });
    // Re-applied captions return on top of whatever was placed since they were made.
    const z = styledZIndex(existing.element);
    if (z === null || z < nextZIndex(model))
      setStyle(existing.element, "z-index", String(captionsZIndex(model)));
    commit(batch, model);
    return { op: op.op, clipId: existing.id, newClipId: null };
  }
  const host = model.document.createElement("div");
  const hfId = `hf-${randomUUID()}`;
  host.id = buildTimelineAssetId("el-captions", usedIds(model));
  host.className = "clip";
  host.setAttribute("data-hf-id", hfId);
  host.setAttribute("data-composition-id", "captions");
  host.setAttribute("data-composition-src", hostSrc);
  host.setAttribute("data-track-kind", "captions");
  host.setAttribute("data-start", "0");
  host.setAttribute("data-duration", fmt(duration));
  host.setAttribute("data-track-index", String(op.track ?? maxTrack(model) + 1));
  host.setAttribute("data-width", String(canvas.width));
  host.setAttribute("data-height", String(canvas.height));
  host.setAttribute(
    "style",
    `position: absolute; left: 0px; top: 0px; width: ${canvas.width}px; height: ${canvas.height}px; z-index: ${captionsZIndex(model)}`,
  );
  model.root.appendChild(host);
  commit(batch, model);
  return { op: op.op, clipId: hfId, newClipId: null };
}

/** A project text file as the batch sees it: an earlier operation's pending write wins over the disk. */
function batchFile(env: EditEnv, batch: Batch, path: string): string | null {
  const pending = batch.files.get(path);
  if (pending !== undefined) return pending;
  const abs = resolveWithinProject(env.project.dir, path);
  return abs && existsSync(abs) ? readFileSync(abs, "utf-8") : null;
}

/**
 * Shifts and/or stretches the cues of the composition's existing captions: a cue starting inside [from, to) moves to
 * `from + (t − from) × scale + shift`. Cue words move with their cue. The result has to keep the cues in order, apart
 * and inside the captions' length, or the operation is refused.
 */
export async function retimeCaptions(
  env: EditEnv,
  batch: Batch,
  op: Extract<EditOperation, { op: "retime_captions" }>,
): Promise<EditOperationResult> {
  const model = await loadModel(env, batch.html);
  const found = findCaptionsHost(model.clips, env.compositionPath);
  const file = found?.host.compositionSrc ?? null;
  if (!found || file === null) {
    throw new EditFailure(
      "unknown_clip",
      "This composition has no captions to retime; write them with apply_captions or captions_from_transcript",
    );
  }
  if (found.host.locked) throw new EditFailure("locked", "The captions clip is locked");
  const current = batchFile(env, batch, file);
  const groups = current === null ? null : readStoredGroups(current);
  if (current === null || groups === null) {
    throw new EditFailure(
      "unsupported",
      `${file} was not written by apply_captions, so its cues cannot be retimed; write the captions again`,
    );
  }
  const from = op.from ?? 0;
  const to = op.to ?? Number.POSITIVE_INFINITY;
  const shift = op.shift ?? 0;
  const scale = op.scale ?? 1;
  const remap = (t: number) => round3(from + (t - from) * scale + shift);
  let moved = 0;
  const next = groups.map((group) => {
    if (group.start < from - EPS || group.start >= to) return group;
    moved += 1;
    return {
      ...group,
      start: remap(group.start),
      end: remap(group.end),
      words: group.words.map((word) => ({
        ...word,
        start: remap(word.start),
        end: remap(word.end),
      })),
    };
  });
  if (moved === 0) {
    throw new EditFailure(
      "out_of_bounds",
      `No caption cue starts between ${fmt(from)}s and ${Number.isFinite(to) ? `${fmt(to)}s` : "the end"}`,
    );
  }
  const length = readStoredDuration(current) ?? model.duration;
  next.forEach((group, index) => {
    const label = `The cue at ${fmt(group.start)}s ("${group.text.slice(0, 30)}")`;
    if (group.start < -EPS) throw new EditFailure("out_of_bounds", `${label} would start before 0`);
    if (group.end <= group.start + EPS) {
      throw new EditFailure("out_of_bounds", `${label} would have no length`);
    }
    if (length > 0 && group.end > length + MEDIA_OVERRUN_TOLERANCE) {
      throw new EditFailure(
        "out_of_bounds",
        `${label} would end at ${fmt(group.end)}s, past the captions' length (${fmt(length)}s)`,
      );
    }
    const following = next[index + 1];
    if (following && following.start < group.end - EPS) {
      throw new EditFailure(
        "out_of_bounds",
        `${label} would overlap the next cue (${fmt(following.start)}s); retime a range that keeps their order and gaps`,
      );
    }
  });
  batch.files.set(file, withStoredGroups(current, next));
  return {
    op: op.op,
    clipId: found.host.id,
    newClipId: null,
    note: `${moved} of ${groups.length} cues retimed`,
  };
}
