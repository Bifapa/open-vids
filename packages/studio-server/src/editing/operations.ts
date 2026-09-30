import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { dirname, posix } from "node:path";
import type {
  ApplyEditsRequest,
  ApplyEditsResponse,
  ClipFit,
  ClipFrame,
  EditOperation,
  EditOperationResult,
  TextSize,
} from "@hyperframes/agent-protocol";
import {
  buildTimelineAssetId,
  buildTimelineAssetInsertHtml,
  fitTimelineAssetGeometry,
  getTimelineAssetKind,
  insertTimelineAssetIntoSource,
  resolveTimelineAssetSrc,
} from "@hyperframes/core/editing/timeline-asset";
import { writeClipTiming } from "@hyperframes/core/composition-contract";
import type { ResolvedProject, StudioApiAdapter } from "../types.js";
import { replaceFileAtomically } from "../helpers/atomicFile.js";
import { snapshotBeforeWrite } from "../helpers/backupJournal.js";
import {
  CompositionInsertionError,
  insertCompositionIntoSource,
} from "../helpers/compositionInsertion.js";
import { pinWithinProject, resolveWithinProject } from "../helpers/safePath.js";
import {
  removeElementFromHtml,
  removeElementsFromHtml,
  splitElementInHtml,
} from "../helpers/sourceMutation.js";
import { patchStyleAttrString } from "../helpers/sourceStyleMutation.js";
import {
  CAPTIONS_FILE,
  buildCaptionsComposition,
  captionSkinPath,
  cuesToGroups,
} from "./captions.js";
import { EditFailure, isEditFailure } from "./errors.js";
import { scaleClipTweens, shiftClipTweens, splitClipTweens } from "./gsapSync.js";
import type { MediaFacts } from "./mediaFacts.js";
import {
  clipMediaPaths,
  findClip,
  editingVersion,
  parseComposition,
  resolveClipDurations,
  resolveProjectRelative,
  serializeModel,
  toSnapshot,
  type ClipNode,
  type CompositionModel,
} from "./timeline.js";

const EPS = 0.001;
/** How far a clip may run past the end of its media before the edit is refused (frame-rounding slack). */
const MEDIA_OVERRUN_TOLERANCE = 0.05;
/** What Studio gives a freshly dropped image (DEFAULT_TIMELINE_ASSET_DURATION.image). */
const DEFAULT_IMAGE_SECONDS = 3;
const DEFAULT_CANVAS = { width: 1920, height: 1080 };
const TEXT_SIZE_RATIO: Record<TextSize, number> = { small: 0.04, medium: 0.07, large: 0.11 };

const round3 = (value: number) => Math.round(value * 1000) / 1000;
const fmt = (value: number) => String(round3(value));

export interface EditEnv {
  project: ResolvedProject;
  /** Project-relative path of the composition being edited. */
  compositionPath: string;
  adapter: Pick<
    StudioApiAdapter,
    "listRegistryCatalog" | "installRegistryBlock" | "captionSkinsDir"
  >;
  facts: MediaFacts;
}

/** The state a batch builds up in memory; nothing reaches disk until every operation has succeeded. */
interface Batch {
  html: string;
  /** `set_composition` ran: the length is what the caller said, not what the content adds up to. */
  explicitDuration: boolean;
  /** Other project files the batch writes, keyed by project-relative path. */
  files: Map<string, string>;
  /** Files the registry install wrote (already on disk). */
  installed: string[];
}

interface Gsap {
  domId: string;
  delta: number;
}

async function loadModel(env: EditEnv, html: string): Promise<CompositionModel> {
  const model = parseComposition(html, env.compositionPath);
  if (!model) {
    throw new EditFailure("unknown_composition", `${env.compositionPath} has no composition root`);
  }
  await env.facts.readMany(env.project.dir, clipMediaPaths(model));
  resolveClipDurations(model, (path) => env.facts.peek(env.project.dir, path));
  return model;
}

const commit = (batch: Batch, model: CompositionModel) => {
  batch.html = serializeModel(model);
};

function requireClip(model: CompositionModel, ref: string, env: EditEnv): ClipNode {
  const clip = findClip(model, ref);
  if (!clip) {
    const known = model.clips.map((candidate) => candidate.id).slice(0, 12);
    throw new EditFailure(
      "unknown_clip",
      `No clip "${ref}" in ${env.compositionPath}${known.length ? `; clips: ${known.join(", ")}` : ""}`,
    );
  }
  if (clip.locked) throw new EditFailure("locked", `Clip "${ref}" is locked`);
  return clip;
}

function canvasOf(model: CompositionModel) {
  return {
    width: model.width > 0 ? model.width : DEFAULT_CANVAS.width,
    height: model.height > 0 ? model.height : DEFAULT_CANVAS.height,
  };
}

function usedIds(model: CompositionModel): string[] {
  return [...model.document.querySelectorAll("[id]")].map((element) => element.id);
}

/** Studio's stacking rule: a new clip sits above every styled element already in the composition. */
function nextZIndex(model: CompositionModel): number {
  let max = 0;
  for (const element of model.root.querySelectorAll("[style]")) {
    const match = /(?:^|;)\s*z-index\s*:\s*(-?\d+)/i.exec(element.getAttribute("style") ?? "");
    if (match?.[1]) max = Math.max(max, Number.parseInt(match[1], 10));
  }
  return max + 1;
}

function maxTrack(model: CompositionModel): number {
  return model.clips.reduce((max, clip) => Math.max(max, clip.track), -1);
}

function setStyle(element: Element, property: string, value: string | null): void {
  element.setAttribute(
    "style",
    patchStyleAttrString(element.getAttribute("style") ?? "", property, value),
  );
}

function setRootDuration(model: CompositionModel, seconds: number): void {
  const holder = model.durationHolder;
  const name =
    !holder.hasAttribute("data-duration") && holder.hasAttribute("data-composition-duration")
      ? "data-composition-duration"
      : "data-duration";
  holder.setAttribute(name, fmt(seconds));
}

/** The media in-point attribute the clip already uses (`data-playback-start` wins, as it does when read). */
function mediaStartAttr(element: Element): string {
  return element.hasAttribute("data-playback-start") ? "data-playback-start" : "data-media-start";
}

/**
 * Clip-edge fades belong to video and audio, and must fit inside the clip: each within its length, and both together
 * (the ramps would otherwise cross).
 */
function checkFades(
  clip: { kind: string },
  duration: number,
  fades: { fadeIn: number; fadeOut: number },
  requested: { fadeIn?: number; fadeOut?: number },
): void {
  if (
    (requested.fadeIn !== undefined || requested.fadeOut !== undefined) &&
    clip.kind !== "video" &&
    clip.kind !== "audio"
  ) {
    throw new EditFailure(
      "unsupported",
      `fadeIn and fadeOut apply to video and audio, not ${clip.kind}`,
    );
  }
  if (fades.fadeIn > duration + EPS || fades.fadeOut > duration + EPS) {
    throw new EditFailure(
      "out_of_bounds",
      `A fade longer than the clip (${fmt(duration)}s) is not possible`,
    );
  }
  if (fades.fadeIn + fades.fadeOut > duration + EPS) {
    throw new EditFailure(
      "out_of_bounds",
      `fadeIn ${fmt(fades.fadeIn)}s + fadeOut ${fmt(fades.fadeOut)}s exceed the clip length (${fmt(duration)}s)`,
    );
  }
}

function setFadeAttribute(element: Element, name: string, seconds: number): void {
  if (seconds > 0) element.setAttribute(name, fmt(seconds));
  else element.removeAttribute(name);
}

function applyGsap(batch: Batch, shifts: readonly Gsap[]): void {
  for (const { domId, delta } of shifts) batch.html = shiftClipTweens(batch.html, domId, delta);
}

// ── add ──────────────────────────────────────────────────────────────────────

/** An explicit frame wins; an explicit fit fills the canvas; otherwise the asset keeps its size, centred. */
function clipGeometry(
  op: { frame?: ClipFrame; fit?: ClipFit },
  facts: { width: number | null; height: number | null },
  canvas: { width: number; height: number },
): { left: number; top: number; width: number; height: number } {
  if (op.frame) {
    return {
      left: Math.round(op.frame.x),
      top: Math.round(op.frame.y),
      width: Math.round(op.frame.width),
      height: Math.round(op.frame.height),
    };
  }
  if (op.fit !== undefined) return { left: 0, top: 0, width: canvas.width, height: canvas.height };
  const natural = facts.width && facts.height ? { width: facts.width, height: facts.height } : null;
  return fitTimelineAssetGeometry(natural, canvas);
}

async function addClip(
  env: EditEnv,
  batch: Batch,
  op: Extract<EditOperation, { op: "add_clip" }>,
): Promise<EditOperationResult> {
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
  const mediaStart = op.mediaStart ?? 0;
  const source = facts.duration;
  let duration: number;
  if (isMedia) {
    if (source !== null && mediaStart >= source) {
      throw new EditFailure(
        "out_of_bounds",
        `mediaStart ${fmt(mediaStart)}s is at or past the end of ${assetPath} (${fmt(source)}s)`,
      );
    }
    if (op.duration !== undefined) {
      if (source !== null && mediaStart + op.duration > source + MEDIA_OVERRUN_TOLERANCE) {
        throw new EditFailure(
          "out_of_bounds",
          `${fmt(op.duration)}s from ${fmt(mediaStart)}s runs past the end of ${assetPath} (${fmt(source)}s)`,
        );
      }
      duration = op.duration;
    } else if (source !== null) {
      duration = source - mediaStart;
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
  const geometry = clipGeometry(op, facts, canvasOf(model));
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
  });
  batch.html = insertTimelineAssetIntoSource(serializeModel(model), markup);
  return { op: op.op, clipId: hfId, newClipId: null };
}

/**
 * Places several ranges of one video/audio source back to back: one insertion for the whole sequence, so a 1000-range
 * cut costs one parse and one serialise like a single `add_clip`. The composition is not parsed per clip.
 */
async function addSequence(
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
  if (source !== null) {
    for (const [index, range] of op.ranges.entries()) {
      if (range.from >= source || range.to > source + MEDIA_OVERRUN_TOLERANCE) {
        throw new EditFailure(
          "out_of_bounds",
          `ranges[${index}] (${fmt(range.from)}–${fmt(range.to)}s) is past the end of ${assetPath} (${fmt(source)}s)`,
        );
      }
    }
  }

  const model = await loadModel(env, batch.html);
  const geometry = clipGeometry(op, facts, canvasOf(model));
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
      }),
    );
    cursor += duration;
  }
  batch.html = insertTimelineAssetIntoSource(serializeModel(model), markup.join("\n"));
  return { op: op.op, clipId: hfIds[0] ?? null, newClipId: null, clipIds: hfIds };
}

function addText(
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
  model.root.appendChild(element);
  commit(batch, model);
  return { op: op.op, clipId: hfId, newClipId: null };
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

async function addComponent(
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
  let installed;
  try {
    installed = await installRegistryBlock({ project: env.project, blockName: item.name });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new EditFailure("unsupported", `Installing "${item.name}" failed: ${message}`);
  }
  batch.installed.push(...installed.written);
  const file = installed.primary ?? installed.written.find((path) => path.endsWith(".html"));
  if (!file?.endsWith(".html")) {
    throw new EditFailure("unsupported", `"${item.name}" installs no composition file to mount`);
  }
  if (item.type === "hyperframes:component") {
    makeComponentBackgroundTransparent(env.project.dir, file);
  }

  // The mount helper needs a positive parent length; the batch's final length rule settles the real one.
  const before = await loadModel(env, batch.html);
  if (before.duration <= 0) {
    setRootDuration(before, op.start + (op.duration ?? 1));
    commit(batch, before);
  }
  let inserted;
  try {
    inserted = insertCompositionIntoSource({
      projectDir: env.project.dir,
      targetPath: env.compositionPath,
      sourcePath: file,
      parentSource: batch.html,
      start: op.start,
      desiredTrack: op.track,
    });
  } catch (error) {
    if (!(error instanceof CompositionInsertionError)) throw error;
    throw new EditFailure(
      "unsupported",
      `"${item.name}" cannot be mounted as a clip: ${error.message}. It is a snippet, not a standalone composition`,
    );
  }
  batch.html = inserted.html;

  const model = await loadModel(env, batch.html);
  const host = model.clips.find((clip) => clip.domId === inserted.hostId);
  if (!host) throw new Error(`Mounted host "${inserted.hostId}" is missing from the composition`);
  if (op.duration !== undefined) {
    writeClipTiming(host.element, { duration: round3(op.duration) });
    commit(batch, model);
  }
  return { op: op.op, clipId: host.id, newClipId: null };
}

async function applyCaptions(
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
  const hostSrc = resolveTimelineAssetSrc(env.compositionPath, CAPTIONS_FILE);
  const existing = model.clips.find((clip) => clip.compositionSrc === CAPTIONS_FILE);
  if (existing?.locked) throw new EditFailure("locked", "The captions clip is locked");

  // Captions span the composition: its declared length when set explicitly, else what the other clips add up to.
  const others = model.clips.filter((clip) => clip !== existing);
  const contentEnd = others.reduce((max, clip) => Math.max(max, clip.end), 0);
  const duration =
    batch.explicitDuration || others.length === 0 ? model.duration : Math.max(contentEnd, EPS);
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
  batch.files.set(
    CAPTIONS_FILE,
    buildCaptionsComposition({
      skin: readFileSync(skinFile, "utf-8"),
      groups,
      duration,
      width: canvas.width,
      height: canvas.height,
    }),
  );

  if (existing) {
    writeClipTiming(existing.element, {
      start: 0,
      duration: round3(duration),
      ...(op.track !== undefined && { trackIndex: op.track }),
    });
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
    `position: absolute; left: 0px; top: 0px; width: ${canvas.width}px; height: ${canvas.height}px; z-index: ${nextZIndex(model)}`,
  );
  model.root.appendChild(host);
  commit(batch, model);
  return { op: op.op, clipId: hfId, newClipId: null };
}

// ── remove / move / trim / split / set / arrange ────────────────────────────

async function removeClip(
  env: EditEnv,
  batch: Batch,
  op: Extract<EditOperation, { op: "remove_clip" }>,
): Promise<EditOperationResult> {
  if (op.clips !== undefined) return removeClips(env, batch, op, op.clips);
  if (op.clip === undefined) throw new EditFailure("invalid_request", "remove_clip needs a clip");
  const model = await loadModel(env, batch.html);
  const clip = requireClip(model, op.clip, env);
  const later = op.ripple
    ? model.clips.filter(
        (other) => other !== clip && other.track === clip.track && other.start >= clip.end - EPS,
      )
    : [];
  const lockedLater = later.find((other) => other.locked);
  if (lockedLater) {
    throw new EditFailure("locked", `Clip "${lockedLater.id}" is locked and cannot ripple`);
  }
  const shifts: Gsap[] = [];
  for (const other of later) {
    writeClipTiming(other.element, { start: round3(other.start - clip.duration) });
    if (other.domId) shifts.push({ domId: other.domId, delta: -clip.duration });
  }
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
      await removeClip(env, batch, { op: "remove_clip", clip: id, ripple: true });
  } else {
    batch.html = removeElementsFromHtml(
      batch.html,
      ids.map((hfId) => ({ hfId })),
    );
  }
  return { op: op.op, clipId: ids[0] ?? null, newClipId: null, clipIds: ids };
}

async function moveClip(
  env: EditEnv,
  batch: Batch,
  op: Extract<EditOperation, { op: "move_clip" }>,
): Promise<EditOperationResult> {
  const model = await loadModel(env, batch.html);
  const clip = requireClip(model, op.clip, env);
  const start = round3(op.start ?? clip.start);
  writeClipTiming(clip.element, {
    start,
    ...(op.track !== undefined && { trackIndex: op.track }),
  });
  commit(batch, model);
  if (clip.domId) applyGsap(batch, [{ domId: clip.domId, delta: start - clip.start }]);
  return { op: op.op, clipId: clip.id, newClipId: null };
}

async function trimClip(
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
  const headDelta = start - clip.start;
  let mediaStart = clip.mediaStart ?? 0;
  if (isMedia && Math.abs(headDelta) > EPS) {
    // Trimming the head moves the in-point by the same amount of source time; earlier than the source's start is impossible.
    const shifted = mediaStart + headDelta * clip.playbackRate;
    if (shifted < -EPS) {
      throw new EditFailure(
        "out_of_bounds",
        `Cannot start ${fmt(-headDelta)}s earlier: only ${fmt(mediaStart / clip.playbackRate)}s of media precede this clip's in-point`,
      );
    }
    if (source !== null && shifted >= source) {
      throw new EditFailure("out_of_bounds", "The new start is past the end of the media");
    }
    mediaStart = Math.max(0, shifted);
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

async function splitClip(
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

async function setClip(
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

async function arrangeTrack(
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

async function setComposition(
  env: EditEnv,
  batch: Batch,
  op: Extract<EditOperation, { op: "set_composition" }>,
): Promise<EditOperationResult> {
  const model = await loadModel(env, batch.html);
  setRootDuration(model, op.duration);
  commit(batch, model);
  batch.explicitDuration = true;
  return { op: op.op, clipId: null, newClipId: null };
}

async function applyOperation(
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
  }
}

/** Without an explicit `set_composition`, the length follows the content: the furthest clip end, growing or shrinking. */
async function followContentLength(env: EditEnv, batch: Batch): Promise<void> {
  const model = await loadModel(env, batch.html);
  if (!batch.explicitDuration && model.clips.length > 0) {
    setRootDuration(
      model,
      model.clips.reduce((max, clip) => Math.max(max, clip.end), 0),
    );
  }
  // Serialising here also stamps stable ids on anything the batch left without one.
  commit(batch, model);
}

// ── write ────────────────────────────────────────────────────────────────────

function conflict(path: string): EditFailure {
  return new EditFailure(
    "conflict",
    `${path} changed while the edits were being applied; read the timeline again`,
  );
}

/**
 * Writes the batch the way the Studio file routes write: a backup first, then an atomic replace, refusing when the
 * file moved on since it was read. No write receipt is recorded, so Studio sees an outside edit (and reloads) and the
 * project history attributes the write to whichever window is open.
 */
function writeProjectFile(
  projectDir: string,
  path: string,
  content: string,
  expected: string | null,
): void {
  const abs = pinWithinProject(projectDir, path);
  if (!abs) throw new EditFailure("invalid_request", `${path} is outside the project`);
  const exists = existsSync(abs);
  if (exists) {
    const backup = snapshotBeforeWrite(projectDir, abs);
    if (backup.error) throw new Error(`Backup of ${path} failed: ${backup.error}`);
    if (expected !== null && readFileSync(abs, "utf-8") !== expected) throw conflict(path);
  } else {
    mkdirSync(dirname(abs), { recursive: true });
  }
  replaceFileAtomically(abs, content, exists ? statSync(abs).mode : 0o644);
}

/**
 * Applies a batch to one composition. Operations run in order against an in-memory copy; the first refusal aborts
 * the batch with its index and nothing is written. On success the composition (and the captions file and installed
 * registry files, when the batch touched them) are on disk and the response carries the fresh timeline.
 */
export async function applyEdits(
  env: EditEnv,
  request: ApplyEditsRequest,
): Promise<ApplyEditsResponse> {
  const path = posix.normalize(env.compositionPath);
  const scoped = { ...env, compositionPath: path };
  const abs = resolveWithinProject(env.project.dir, path);
  if (!abs || !path.endsWith(".html") || !existsSync(abs) || !statSync(abs).isFile()) {
    throw new EditFailure("unknown_composition", `No composition "${request.composition ?? path}"`);
  }
  const original = readFileSync(abs, "utf-8");
  if (
    request.baseVersion !== undefined &&
    request.baseVersion.replace(/^"|"$/g, "") !== editingVersion(original)
  ) {
    throw new EditFailure(
      "conflict",
      `${path} changed since the timeline was read (version ${request.baseVersion}); read it again`,
    );
  }
  if (!parseComposition(original, path)) {
    throw new EditFailure(
      "unknown_composition",
      `${path} is not a composition (no data-composition-id)`,
    );
  }

  const batch: Batch = { html: original, explicitDuration: false, files: new Map(), installed: [] };
  const results: EditOperationResult[] = [];
  for (const [index, op] of request.operations.entries()) {
    try {
      results.push(await applyOperation(scoped, batch, op));
    } catch (error) {
      throw isEditFailure(error) ? error.atOperation(index) : error;
    }
  }
  await followContentLength(scoped, batch);

  const changedFiles: string[] = [];
  for (const [file, content] of batch.files) {
    const existing = resolveWithinProject(env.project.dir, file);
    const previous = existing && existsSync(existing) ? readFileSync(existing, "utf-8") : null;
    if (previous === content) continue;
    writeProjectFile(env.project.dir, file, content, previous);
    changedFiles.push(file);
  }
  if (batch.html !== original) {
    writeProjectFile(env.project.dir, path, batch.html, original);
    changedFiles.unshift(path);
  }
  for (const file of batch.installed) if (!changedFiles.includes(file)) changedFiles.push(file);

  const model = await loadModel(scoped, batch.html);
  return {
    timeline: toSnapshot(model, path, batch.html, (media) =>
      env.facts.peek(env.project.dir, media),
    ),
    results,
    changedFiles,
  };
}
