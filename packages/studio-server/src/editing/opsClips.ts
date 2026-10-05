import type { EditOperation, EditOperationResult, RippleScope } from "@hyperframes/agent-protocol";
import { writeClipTiming } from "@hyperframes/core/composition-contract";
import {
  removeElementFromHtml,
  removeElementsFromHtml,
  splitElementInHtml,
} from "../helpers/sourceMutation.js";
import {
  EPS,
  MEDIA_OVERRUN_TOLERANCE,
  applyGsap,
  boundsFor,
  checkFades,
  commit,
  fmt,
  loadModel,
  mediaStartAttr,
  pickedRange,
  requireClip,
  round3,
  setFadeAttribute,
  setStyle,
  type Batch,
  type EditEnv,
  type Gsap,
} from "./batch.js";
import { EditFailure } from "./errors.js";
import { scaleClipTweens, splitClipTweens } from "./gsapSync.js";
import { findClip, parseComposition, type ClipNode, type CompositionModel } from "./timeline.js";

// ── remove / move / trim / split / set / arrange ────────────────────────────

/**
 * Moves the clips after `anchor` by `delta` seconds: those starting at or after `from` on the anchor's track, or on
 * every track with scope "all". A locked clip in the way refuses the whole operation. Returns the tween shifts to
 * apply once the document has been committed.
 */
export function rippleLater(
  model: CompositionModel,
  anchor: ClipNode,
  from: number,
  delta: number,
  scope: RippleScope,
): Gsap[] {
  const later = model.clips.filter(
    (other) =>
      other !== anchor &&
      other.start >= from - EPS &&
      (scope === "all" || other.track === anchor.track),
  );
  const lockedLater = later.find((other) => other.locked);
  if (lockedLater) {
    throw new EditFailure("locked", `Clip "${lockedLater.id}" is locked and cannot ripple`);
  }
  const shifts: Gsap[] = [];
  for (const other of later) {
    writeClipTiming(other.element, { start: round3(other.start + delta) });
    if (other.domId) shifts.push({ domId: other.domId, delta });
  }
  return shifts;
}

export async function removeClip(
  env: EditEnv,
  batch: Batch,
  op: Extract<EditOperation, { op: "remove_clip" }>,
): Promise<EditOperationResult> {
  if (op.clips !== undefined) return removeClips(env, batch, op, op.clips);
  if (op.clip === undefined) throw new EditFailure("invalid_request", "remove_clip needs a clip");
  const model = await loadModel(env, batch.html);
  const clip = requireClip(model, op.clip, env);
  const shifts = op.ripple
    ? rippleLater(model, clip, clip.end, -clip.duration, op.rippleScope ?? "track")
    : [];
  // Ripple edits go in first: the removal below re-parses the document they were written into.
  commit(batch, model);
  batch.html = removeElementFromHtml(batch.html, { hfId: clip.id });
  applyGsap(batch, shifts);
  return { op: op.op, clipId: clip.id, newClipId: null };
}

/**
 * Removes many clips at once. Every clip is resolved (and its lock checked) before anything changes, so one bad id
 * refuses the whole operation. Without ripple the removal is one parse; with ripple each clip closes its own gap in
 * the order given, like the single-clip operation.
 */
async function removeClips(
  env: EditEnv,
  batch: Batch,
  op: Extract<EditOperation, { op: "remove_clip" }>,
  refs: string[],
): Promise<EditOperationResult> {
  const model = await loadModel(env, batch.html);
  const clips = refs.map((ref) => requireClip(model, ref, env));
  const ids = clips.map((clip) => clip.id);
  if (new Set(ids).size !== ids.length) {
    throw new EditFailure("invalid_request", "clips must not name the same clip twice");
  }
  if (op.ripple) {
    for (const id of ids)
      await removeClip(env, batch, {
        op: "remove_clip",
        clip: id,
        ripple: true,
        ...(op.rippleScope !== undefined && { rippleScope: op.rippleScope }),
      });
  } else {
    batch.html = removeElementsFromHtml(
      batch.html,
      ids.map((hfId) => ({ hfId })),
    );
  }
  return { op: op.op, clipId: ids[0] ?? null, newClipId: null, clipIds: ids };
}

export async function moveClip(
  env: EditEnv,
  batch: Batch,
  op: Extract<EditOperation, { op: "move_clip" }>,
): Promise<EditOperationResult> {
  const model = await loadModel(env, batch.html);
  const clip = requireClip(model, op.clip, env);
  const start = op.start === undefined ? null : round3(op.start);
  // A track-only move leaves data-start alone: it may be a reference ("first + 0.5") the resolved number would flatten.
  writeClipTiming(clip.element, {
    ...(start !== null && { start }),
    ...(op.track !== undefined && { trackIndex: op.track }),
  });
  commit(batch, model);
  if (clip.domId && start !== null)
    applyGsap(batch, [{ domId: clip.domId, delta: start - clip.start }]);
  return { op: op.op, clipId: clip.id, newClipId: null };
}

export async function trimClip(
  env: EditEnv,
  batch: Batch,
  op: Extract<EditOperation, { op: "trim_clip" }>,
): Promise<EditOperationResult> {
  const model = await loadModel(env, batch.html);
  const clip = requireClip(model, op.clip, env);
  const start = round3(op.start ?? clip.start);
  const end = round3(op.end ?? clip.end);
  if (end - start <= EPS) {
    throw new EditFailure(
      "out_of_bounds",
      `The trimmed clip would end (${fmt(end)}s) at or before its start (${fmt(start)}s)`,
    );
  }
  const isMedia = clip.kind === "video" || clip.kind === "audio";
  const source =
    clip.src === null ? null : (env.facts.peek(env.project.dir, clip.src)?.duration ?? null);
  const bounds = isMedia && clip.src !== null ? boundsFor(env, batch, clip.src, source) : null;
  const oldMediaStart = clip.mediaStart ?? 0;
  const headDelta = start - clip.start;
  let mediaStart = oldMediaStart;
  if (isMedia && Math.abs(headDelta) > EPS) {
    // Trimming the head moves the in-point by the same amount of source time; earlier than the source's start is impossible.
    const shifted = oldMediaStart + headDelta * clip.playbackRate;
    // A clip the user placed outside the pick may not reach further out than it already does, but a trim inside is fine.
    const earliest = bounds === null ? 0 : Math.min(bounds.start, oldMediaStart);
    if (shifted < earliest - EPS) {
      throw new EditFailure(
        "out_of_bounds",
        bounds?.picked && shifted < bounds.start - EPS
          ? `${pickedRange(clip.src ?? "", bounds)}; the new in-point ${fmt(shifted)}s would be before ${fmt(earliest)}s`
          : `Cannot start ${fmt(-headDelta)}s earlier: only ${fmt(oldMediaStart / clip.playbackRate)}s of media precede this clip's in-point`,
      );
    }
    if (source !== null && shifted >= source) {
      throw new EditFailure("out_of_bounds", "The new start is past the end of the media");
    }
    mediaStart = Math.max(0, shifted);
  }
  if (isMedia && bounds?.picked && bounds.end !== null) {
    // The clip keeps whatever of the pick (or of the file) it already uses; a trim may not widen that window.
    // Checked before the source's own end so a refusal names the pick when the pick is the tighter bound.
    const mediaEnd = mediaStart + (end - start) * clip.playbackRate;
    const allowedEnd = Math.max(bounds.end, oldMediaStart + clip.duration * clip.playbackRate);
    if (mediaEnd > allowedEnd + MEDIA_OVERRUN_TOLERANCE) {
      throw new EditFailure(
        "out_of_bounds",
        `${pickedRange(clip.src ?? "", bounds)}; the clip would run to ${fmt(mediaEnd)}s of the source (allowed ${fmt(allowedEnd)}s)`,
      );
    }
  }
  if (isMedia && source !== null) {
    const latestEnd = start + (source - mediaStart) / clip.playbackRate;
    if (end > latestEnd + MEDIA_OVERRUN_TOLERANCE) {
      throw new EditFailure(
        "out_of_bounds",
        `The clip cannot run to ${fmt(end)}s: its media ends at ${fmt(latestEnd)}s`,
      );
    }
  }
  const duration = round3(end - start);
  writeClipTiming(clip.element, { start, duration });
  if (isMedia && Math.abs(headDelta) > EPS) {
    clip.element.setAttribute(mediaStartAttr(clip.element), fmt(mediaStart));
  }
  commit(batch, model);
  if (clip.domId) {
    batch.html = scaleClipTweens(
      batch.html,
      clip.domId,
      { start: clip.start, duration: clip.duration },
      { start, duration },
    );
  }
  return { op: op.op, clipId: clip.id, newClipId: null };
}

export async function splitClip(
  env: EditEnv,
  batch: Batch,
  op: Extract<EditOperation, { op: "split_clip" }>,
): Promise<EditOperationResult> {
  const model = await loadModel(env, batch.html);
  const clip = requireClip(model, op.clip, env);
  if (op.at <= clip.start + EPS || op.at >= clip.end - EPS) {
    throw new EditFailure(
      "out_of_bounds",
      `Cannot split at ${fmt(op.at)}s: clip "${op.clip}" spans ${fmt(clip.start)}s to ${fmt(clip.end)}s`,
    );
  }
  const split = splitElementInHtml(
    batch.html,
    { hfId: clip.id },
    op.at,
    `${clip.domId ?? clip.kind}-split`,
    {
      start: clip.start,
      duration: clip.duration,
      track: clip.track,
      playbackStart: clip.mediaStart ?? 0,
      playbackRate: clip.playbackRate,
      stampPlaybackStart: clip.kind === "composition",
    },
  );
  if (!split.matched || !split.newId) {
    throw new EditFailure(
      "out_of_bounds",
      `Clip "${op.clip}" could not be split at ${fmt(op.at)}s`,
    );
  }
  batch.html = split.html;
  batch.touched.add(split.newId);
  if (clip.domId) {
    batch.html = splitClipTweens(batch.html, {
      originalId: clip.domId,
      newId: split.newId,
      splitTime: op.at,
      elementStart: clip.start,
      elementDuration: clip.duration,
    });
  }
  const after = parseComposition(batch.html, env.compositionPath);
  const second = after?.clips.find((candidate) => candidate.domId === split.newId);
  return { op: op.op, clipId: clip.id, newClipId: second?.id ?? null };
}

export async function setClip(
  env: EditEnv,
  batch: Batch,
  op: Extract<EditOperation, { op: "set_clip" }>,
): Promise<EditOperationResult> {
  const model = await loadModel(env, batch.html);
  const clip = requireClip(model, op.clip, env);
  const { element } = clip;
  const isMedia = clip.kind === "video" || clip.kind === "audio";
  if ((op.volume !== undefined || op.muted !== undefined) && !isMedia) {
    throw new EditFailure(
      "unsupported",
      `volume and muted apply to video and audio, not ${clip.kind}`,
    );
  }
  if (op.fit !== undefined && clip.kind !== "video" && clip.kind !== "image") {
    throw new EditFailure("unsupported", `fit applies to video and images, not ${clip.kind}`);
  }
  if (op.frame !== undefined && clip.kind === "audio") {
    throw new EditFailure("unsupported", "frame applies to visual clips, not audio");
  }
  const currentFade = (name: string) => Number.parseFloat(element.getAttribute(name) ?? "") || 0;
  const fades = {
    fadeIn: op.fadeIn ?? currentFade("data-fade-in"),
    fadeOut: op.fadeOut ?? currentFade("data-fade-out"),
  };
  checkFades(clip, clip.duration, fades, op);
  if (op.fadeIn !== undefined) setFadeAttribute(element, "data-fade-in", op.fadeIn);
  if (op.fadeOut !== undefined) setFadeAttribute(element, "data-fade-out", op.fadeOut);
  if (op.volume !== undefined) element.setAttribute("data-volume", String(op.volume));
  if (op.muted === true) {
    element.setAttribute("muted", "");
    // muted and data-has-audio="true" are mutually exclusive (lint: video_has_audio_but_muted).
    element.removeAttribute("data-has-audio");
  } else if (op.muted === false) {
    element.removeAttribute("muted");
    const hasAudio = clip.src === null ? null : env.facts.peek(env.project.dir, clip.src)?.hasAudio;
    if (clip.kind === "video" && hasAudio !== false) element.setAttribute("data-has-audio", "true");
  }
  if (op.fit !== undefined) setStyle(element, "object-fit", op.fit);
  if (op.zIndex !== undefined) setStyle(element, "z-index", String(op.zIndex));
  if (op.opacity !== undefined) {
    if (clip.kind === "audio") {
      throw new EditFailure("unsupported", "opacity applies to visual clips, not audio");
    }
    setStyle(element, "opacity", op.opacity >= 1 ? null : String(round3(op.opacity)));
  }
  if (op.frame !== undefined) {
    setStyle(element, "position", "absolute");
    setStyle(element, "left", `${Math.round(op.frame.x)}px`);
    setStyle(element, "top", `${Math.round(op.frame.y)}px`);
    setStyle(element, "width", `${Math.round(op.frame.width)}px`);
    setStyle(element, "height", `${Math.round(op.frame.height)}px`);
  }
  commit(batch, model);
  return { op: op.op, clipId: clip.id, newClipId: null };
}

export async function arrangeTrack(
  env: EditEnv,
  batch: Batch,
  op: Extract<EditOperation, { op: "arrange_track" }>,
): Promise<EditOperationResult> {
  const model = await loadModel(env, batch.html);
  const clips = op.clips.map((ref) => requireClip(model, ref, env));
  if (new Set(clips).size !== clips.length) {
    throw new EditFailure("invalid_request", "clips must not name the same clip twice");
  }
  let cursor = op.start ?? 0;
  const shifts: Gsap[] = [];
  for (const clip of clips) {
    const start = round3(cursor);
    writeClipTiming(clip.element, { start, trackIndex: op.track });
    if (clip.domId) shifts.push({ domId: clip.domId, delta: start - clip.start });
    cursor += clip.duration + (op.gap ?? 0);
  }
  commit(batch, model);
  applyGsap(batch, shifts);
  return { op: op.op, clipId: clips[0]?.id ?? null, newClipId: null };
}

// ── speed / lock ────────────────────────────────────────────────────────────

/**
 * Sets a video/audio clip's playback rate the way Studio's speed control does (`data-playback-rate`). Unless the
 * caller keeps the length, the clip keeps playing the same stretch of source, so its timeline length scales and the
 * tweens on it follow; later clips can ripple by the difference.
 */
export async function setSpeed(
  env: EditEnv,
  batch: Batch,
  op: Extract<EditOperation, { op: "set_speed" }>,
): Promise<EditOperationResult> {
  const model = await loadModel(env, batch.html);
  const clip = requireClip(model, op.clip, env);
  if (clip.kind !== "video" && clip.kind !== "audio") {
    throw new EditFailure("unsupported", `Speed applies to video and audio, not ${clip.kind}`);
  }
  const rate = round3(op.rate);
  const duration = op.keepDuration
    ? clip.duration
    : round3((clip.duration * clip.playbackRate) / rate);
  if (duration <= EPS) {
    throw new EditFailure(
      "out_of_bounds",
      `At ${fmt(rate)}× the clip would be shorter than a frame`,
    );
  }
  if (op.keepDuration && clip.src !== null) {
    const source = env.facts.peek(env.project.dir, clip.src)?.duration ?? null;
    const bounds = boundsFor(env, batch, clip.src, source);
    const mediaEnd = (clip.mediaStart ?? 0) + duration * rate;
    if (bounds.end !== null && mediaEnd > bounds.end + MEDIA_OVERRUN_TOLERANCE) {
      throw new EditFailure(
        "out_of_bounds",
        bounds.picked
          ? `${pickedRange(clip.src, bounds)}; at ${fmt(rate)}× the clip would play to ${fmt(mediaEnd)}s of the source`
          : `At ${fmt(rate)}× the clip would play to ${fmt(mediaEnd)}s of ${clip.src}, which ends at ${fmt(bounds.end)}s`,
      );
    }
  }
  if (rate === 1) clip.element.removeAttribute("data-playback-rate");
  else clip.element.setAttribute("data-playback-rate", fmt(rate));
  writeClipTiming(clip.element, { duration });
  const delta = round3(duration - clip.duration);
  const shifts =
    op.ripple && Math.abs(delta) > EPS
      ? rippleLater(model, clip, clip.end, delta, op.rippleScope ?? "track")
      : [];
  commit(batch, model);
  if (clip.domId && Math.abs(delta) > EPS) {
    batch.html = scaleClipTweens(
      batch.html,
      clip.domId,
      { start: clip.start, duration: clip.duration },
      { start: clip.start, duration },
    );
  }
  applyGsap(batch, shifts);
  return {
    op: op.op,
    clipId: clip.id,
    newClipId: null,
    note: `${fmt(rate)}× → ${fmt(duration)} s on the timeline${Math.abs(delta) > EPS ? ` (${delta > 0 ? "+" : ""}${fmt(delta)} s)` : ""}`,
  };
}

/** What marks a lock the agent set itself; any other value (Studio's empty one) is the user's lock. */
const AI_LOCK = "ai";

/**
 * Locks clips (any further edit of them is refused) or unlocks clips the agent locked. A lock the user set stays: the
 * agent cannot lift it.
 */
export async function setLocked(
  env: EditEnv,
  batch: Batch,
  op: Extract<EditOperation, { op: "set_locked" }>,
): Promise<EditOperationResult> {
  const model = await loadModel(env, batch.html);
  const ids: string[] = [];
  for (const ref of op.clips) {
    const clip = findClip(model, ref);
    if (!clip) throw new EditFailure("unknown_clip", `No clip "${ref}" in ${env.compositionPath}`);
    if (op.locked) {
      if (!clip.locked) clip.element.setAttribute("data-timeline-locked", AI_LOCK);
    } else if (clip.locked) {
      if (clip.element.getAttribute("data-timeline-locked") !== AI_LOCK) {
        throw new EditFailure(
          "locked",
          `Clip "${ref}" was locked by the user; only the user can unlock it`,
        );
      }
      clip.element.removeAttribute("data-timeline-locked");
    }
    ids.push(clip.id);
  }
  commit(batch, model);
  return { op: op.op, clipId: ids[0] ?? null, newClipId: null, clipIds: ids };
}
