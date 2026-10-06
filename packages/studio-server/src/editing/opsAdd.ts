import { randomUUID } from "node:crypto";
import type {
  ClipFit,
  ClipFrame,
  EditOperation,
  EditOperationResult,
} from "@hyperframes/agent-protocol";
import {
  buildTimelineAssetId,
  buildTimelineAssetInsertHtml,
  fitTimelineAssetGeometry,
  getTimelineAssetKind,
  insertTimelineAssetIntoSource,
  resolveTimelineAssetSrc,
} from "@hyperframes/core/editing/timeline-asset";
import {
  DEFAULT_IMAGE_SECONDS,
  MEDIA_OVERRUN_TOLERANCE,
  TEXT_SIZE_RATIO,
  boundsFor,
  canvasOf,
  commit,
  fmt,
  loadModel,
  nextZIndex,
  pickedRange,
  round3,
  usedIds,
  checkFades,
  type Batch,
  type EditEnv,
} from "./batch.js";
import { EditFailure } from "./errors.js";
import {
  provenanceAttributes,
  resolveProjectRelative,
  serializeModel,
  stampProvenance,
  type CompositionModel,
} from "./timeline.js";
import { resolveVoiceLine, voiceClipAttributes, withVoiceoverGroup } from "./voiceLine.js";

/**
 * An explicit frame wins; an explicit fit fills the canvas. Otherwise footage (video) fills the frame, scaled to fit,
 * as a Studio drop does — a 720p recording in a 1080p composition must not play as a centred postage stamp — and a
 * picture keeps its size, centred (a logo stays a logo).
 */
export function clipGeometry(
  op: { frame?: ClipFrame; fit?: ClipFit },
  facts: { width: number | null; height: number | null },
  canvas: { width: number; height: number },
  kind: string,
): { left: number; top: number; width: number; height: number } {
  if (op.frame) {
    return {
      left: Math.round(op.frame.x),
      top: Math.round(op.frame.y),
      width: Math.round(op.frame.width),
      height: Math.round(op.frame.height),
    };
  }
  if (op.fit !== undefined || kind === "video")
    return { left: 0, top: 0, width: canvas.width, height: canvas.height };
  const natural = facts.width && facts.height ? { width: facts.width, height: facts.height } : null;
  return fitTimelineAssetGeometry(natural, canvas);
}

export async function addClip(
  env: EditEnv,
  batch: Batch,
  requested: Extract<EditOperation, { op: "add_clip" }>,
): Promise<EditOperationResult> {
  // A voice line is placed from its selected take; the take's range is the clip's default.
  const voice =
    requested.voiceLine === undefined
      ? null
      : resolveVoiceLine(env.project.dir, requested.voiceLine);
  const op = voice
    ? {
        ...requested,
        asset: voice.file,
        mediaStart: requested.mediaStart ?? voice.start,
        duration: requested.duration ?? voice.end - voice.start,
      }
    : requested;
  const assetPath = resolveProjectRelative("index.html", op.asset);
  const kind = assetPath === null ? null : getTimelineAssetKind(assetPath);
  const facts = assetPath === null ? null : await env.facts.read(env.project.dir, assetPath);
  if (assetPath === null || kind === null || !facts) {
    throw new EditFailure(
      "unknown_asset",
      `"${op.asset}" is not a video, image or audio file in this project`,
    );
  }

  const isMedia = kind === "video" || kind === "audio";
  const source = facts.duration;
  const bounds = isMedia ? boundsFor(env, batch, assetPath, source) : null;
  const mediaStart = op.mediaStart ?? bounds?.start ?? 0;
  let duration: number;
  if (isMedia && bounds) {
    if (source !== null && mediaStart >= source) {
      throw new EditFailure(
        "out_of_bounds",
        `mediaStart ${fmt(mediaStart)}s is at or past the end of ${assetPath} (${fmt(source)}s)`,
      );
    }
    if (bounds.picked && mediaStart < bounds.start - MEDIA_OVERRUN_TOLERANCE) {
      throw new EditFailure(
        "out_of_bounds",
        `${pickedRange(assetPath, bounds)}; mediaStart ${fmt(mediaStart)}s is before it`,
      );
    }
    if (op.duration !== undefined) {
      if (bounds.end !== null && mediaStart + op.duration > bounds.end + MEDIA_OVERRUN_TOLERANCE) {
        throw new EditFailure(
          "out_of_bounds",
          bounds.picked
            ? `${pickedRange(assetPath, bounds)}; ${fmt(op.duration)}s from ${fmt(mediaStart)}s runs past ${fmt(bounds.end)}s`
            : `${fmt(op.duration)}s from ${fmt(mediaStart)}s runs past the end of ${assetPath} (${fmt(bounds.end)}s)`,
        );
      }
      duration = op.duration;
    } else if (bounds.end !== null) {
      // With a pick this is the fragment's remaining length; without one, the whole file's.
      duration = bounds.end - mediaStart;
      if (duration <= 0) {
        throw new EditFailure(
          "out_of_bounds",
          bounds.picked
            ? `${pickedRange(assetPath, bounds)}; mediaStart ${fmt(mediaStart)}s is at or past ${fmt(bounds.end)}s`
            : `mediaStart ${fmt(mediaStart)}s is at or past the end of ${assetPath} (${fmt(bounds.end)}s)`,
        );
      }
    } else {
      throw new EditFailure(
        "unsupported",
        `The length of ${assetPath} could not be read (is ffprobe installed?); pass duration`,
      );
    }
  } else {
    duration = op.duration ?? DEFAULT_IMAGE_SECONDS;
  }

  checkFades(
    { kind },
    duration,
    {
      fadeIn: op.fadeIn ?? 0,
      fadeOut: op.fadeOut ?? 0,
    },
    op,
  );

  if (op.frame !== undefined && kind === "audio") {
    throw new EditFailure("unsupported", "frame applies to video and images, not audio");
  }
  const model = await loadModel(env, batch.html);
  const geometry = clipGeometry(op, facts, canvasOf(model), kind);
  const hfId = `hf-${randomUUID()}`;
  const markup = buildTimelineAssetInsertHtml({
    id: buildTimelineAssetId(assetPath, usedIds(model)),
    hfId,
    assetPath: resolveTimelineAssetSrc(env.compositionPath, assetPath),
    kind,
    start: round3(op.start),
    duration: round3(duration),
    track: op.track,
    zIndex: nextZIndex(model),
    geometry,
    hasAudio: facts.hasAudio === true,
    fit: op.fit,
    mediaStart: isMedia && mediaStart > 0 ? round3(mediaStart) : undefined,
    volume: isMedia ? op.volume : undefined,
    muted: isMedia ? op.muted : undefined,
    fadeIn: op.fadeIn,
    fadeOut: op.fadeOut,
    attributes: {
      ...provenanceAttributes(op.provenance),
      ...(voice !== null && voiceClipAttributes(voice.lineId)),
    },
  });
  const inserted = insertTimelineAssetIntoSource(serializeModel(model), markup);
  batch.html = voice === null ? inserted : withVoiceoverGroup(inserted);
  return { op: op.op, clipId: hfId, newClipId: null };
}

/**
 * Places several ranges of one video/audio source back to back: one insertion for the whole sequence, so a 1000-range
 * cut costs one parse and one serialise like a single `add_clip`. The composition is not parsed per clip.
 */
export async function addSequence(
  env: EditEnv,
  batch: Batch,
  op: Extract<EditOperation, { op: "add_sequence" }>,
): Promise<EditOperationResult> {
  const assetPath = resolveProjectRelative("index.html", op.asset);
  const kind = assetPath === null ? null : getTimelineAssetKind(assetPath);
  const facts = assetPath === null ? null : await env.facts.read(env.project.dir, assetPath);
  if (assetPath === null || kind === null || !facts) {
    throw new EditFailure(
      "unknown_asset",
      `"${op.asset}" is not a video or audio file in this project`,
    );
  }
  if (kind === "image") {
    throw new EditFailure(
      "unsupported",
      `add_sequence cuts video or audio sources, not images ("${op.asset}")`,
    );
  }
  if (op.frame !== undefined && kind === "audio") {
    throw new EditFailure("unsupported", "frame applies to video and images, not audio");
  }
  const source = facts.duration;
  const bounds = boundsFor(env, batch, assetPath, source);
  for (const [index, range] of op.ranges.entries()) {
    if (range.from < bounds.start - MEDIA_OVERRUN_TOLERANCE) {
      throw new EditFailure(
        "out_of_bounds",
        `${pickedRange(assetPath, bounds)}; ranges[${index}] (${fmt(range.from)}–${fmt(range.to)}s) starts before it`,
      );
    }
    if (
      bounds.end !== null &&
      (range.from >= bounds.end || range.to > bounds.end + MEDIA_OVERRUN_TOLERANCE)
    ) {
      throw new EditFailure(
        "out_of_bounds",
        bounds.picked
          ? `${pickedRange(assetPath, bounds)}; ranges[${index}] (${fmt(range.from)}–${fmt(range.to)}s) is outside it`
          : `ranges[${index}] (${fmt(range.from)}–${fmt(range.to)}s) is past the end of ${assetPath} (${fmt(bounds.end)}s)`,
      );
    }
  }

  const model = await loadModel(env, batch.html);
  const geometry = clipGeometry(op, facts, canvasOf(model), kind);
  const zIndex = nextZIndex(model);
  const src = resolveTimelineAssetSrc(env.compositionPath, assetPath);
  const taken = new Set(usedIds(model));
  const hfIds: string[] = [];
  const markup: string[] = [];
  let cursor = op.start ?? 0;
  for (const range of op.ranges) {
    const duration = round3(range.to - range.from);
    // The ramps of one clip must fit inside it, so a very short range gets shorter ramps.
    const edge = Math.min(op.edgeFade ?? 0, duration / 2);
    const id = buildTimelineAssetId(assetPath, taken);
    taken.add(id);
    const hfId = `hf-${randomUUID()}`;
    hfIds.push(hfId);
    markup.push(
      buildTimelineAssetInsertHtml({
        id,
        hfId,
        assetPath: src,
        kind,
        start: round3(cursor),
        duration,
        track: op.track,
        zIndex,
        geometry,
        hasAudio: facts.hasAudio === true,
        fit: op.fit,
        mediaStart: range.from > 0 ? round3(range.from) : undefined,
        volume: op.volume,
        muted: op.muted,
        fadeIn: edge > 0 ? round3(edge) : undefined,
        fadeOut: edge > 0 ? round3(edge) : undefined,
        attributes: provenanceAttributes(op.provenance),
      }),
    );
    cursor += duration;
  }
  batch.html = insertTimelineAssetIntoSource(serializeModel(model), markup.join("\n"));
  return { op: op.op, clipId: hfIds[0] ?? null, newClipId: null, clipIds: hfIds };
}

export function addText(
  env: EditEnv,
  batch: Batch,
  op: Extract<EditOperation, { op: "add_text" }>,
  model: CompositionModel,
): EditOperationResult {
  const canvas = canvasOf(model);
  const fontSize = Math.round(canvas.height * TEXT_SIZE_RATIO[op.size ?? "medium"]);
  const margin = Math.round(canvas.height * 0.08);
  const placement = op.placement ?? "bottom";
  const position =
    placement === "top"
      ? `top: ${margin}px`
      : placement === "bottom"
        ? `bottom: ${margin}px`
        : `top: 0px; height: ${canvas.height}px; display: flex; align-items: center; justify-content: center`;
  const element = model.document.createElement("div");
  const hfId = `hf-${randomUUID()}`;
  element.id = buildTimelineAssetId("text", usedIds(model));
  element.className = "clip";
  element.setAttribute("data-hf-id", hfId);
  element.setAttribute("data-start", fmt(op.start));
  element.setAttribute("data-duration", fmt(op.duration));
  element.setAttribute("data-track-index", String(op.track));
  element.setAttribute(
    "style",
    [
      "position: absolute",
      "left: 0px",
      `width: ${canvas.width}px`,
      position,
      "box-sizing: border-box",
      "padding: 0 5%",
      "text-align: center",
      `color: ${op.color ?? "#ffffff"}`,
      `font-size: ${fontSize}px`,
      "font-weight: 700",
      "line-height: 1.2",
      "font-family: Helvetica, Arial, sans-serif",
      "text-shadow: 0 2px 8px rgba(0, 0, 0, 0.6)",
      `z-index: ${nextZIndex(model)}`,
    ].join("; "),
  );
  element.textContent = op.text;
  stampProvenance(element, op.provenance);
  model.root.appendChild(element);
  commit(batch, model);
  return { op: op.op, clipId: hfId, newClipId: null };
}
