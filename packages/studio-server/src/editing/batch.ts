import type { AssetRange, TextSize } from "@hyperframes/agent-protocol";
import type { AnalysisService } from "../analysis/service.js";
import type { ResolvedProject, StudioApiAdapter } from "../types.js";
import { pickedForUse } from "../helpers/pickedRange.js";
import { patchStyleAttrString } from "../helpers/sourceStyleMutation.js";
import { mediaBounds, readAssetRanges, type MediaBounds } from "./assetRanges.js";
import { EditFailure } from "./errors.js";
import { shiftClipTweens } from "./gsapSync.js";
import { isUntouchedTemplatePlaceholder } from "./placeholder.js";
import type { MediaFacts } from "./mediaFacts.js";
import {
  clipMediaPaths,
  findClip,
  parseComposition,
  resolveClipDurations,
  serializeModel,
  type ClipNode,
  type CompositionModel,
} from "./timeline.js";

export const EPS = 0.001;
/** How far a clip may run past the end of its media before the edit is refused (frame-rounding slack). */
export const MEDIA_OVERRUN_TOLERANCE = 0.05;
/** What Studio gives a freshly dropped image (DEFAULT_TIMELINE_ASSET_DURATION.image). */
export const DEFAULT_IMAGE_SECONDS = 3;
export const DEFAULT_CANVAS = { width: 1920, height: 1080 };
export const TEXT_SIZE_RATIO: Record<TextSize, number> = { small: 0.04, medium: 0.07, large: 0.11 };

export const round3 = (value: number) => Math.round(value * 1000) / 1000;
export const fmt = (value: number) => String(round3(value));

export interface EditEnv {
  project: ResolvedProject;
  /** Project-relative path of the composition being edited. */
  compositionPath: string;
  adapter: Pick<
    StudioApiAdapter,
    "listRegistryCatalog" | "installRegistryBlock" | "captionSkinsDir"
  >;
  facts: MediaFacts;
  /**
   * The agent turn making the edit: clips the batch changes are stamped with it (`data-ov-ai-edit`), clips it adds
   * get it as their provenance unless the operation names another. Absent for Studio's own and Story builds.
   */
  turnId?: string;
  /** The analysis cache, for `captions_from_transcript`. */
  analysis?: Pick<AnalysisService, "sourceData">;
}

/** The state a batch builds up in memory; nothing reaches disk until every operation has succeeded. */
export interface Batch {
  html: string;
  /** `set_composition` ran: the length is what the caller said, not what the content adds up to. */
  explicitDuration: boolean;
  /** Other project files the batch writes, keyed by project-relative path. */
  files: Map<string, string>;
  /** Files the registry install wrote (already on disk). */
  installed: string[];
  /** The part of `installed` that did not exist before the batch: removed again when the batch is refused. */
  fresh: string[];
  /** The project config and install record as they were before the batch's first install. */
  bookkeeping?: Map<string, string | null>;
  /** Existing clips (hf id or DOM id) the batch changed; stamped with the turn at the end. */
  touched: Set<string>;
  /** The user's picked asset fragments, read once per batch on first use. */
  ranges?: Map<string, AssetRange>;
  /** Things worth a look in the answer (overlaps, skipped clips); reported with the result. */
  warnings: string[];
  /** The composition held the untouched template placeholder when the batch started. */
  hadPlaceholder: boolean;
}

/**
 * The source window a placement of this asset must stay inside: the fragment the user picked, or the whole file.
 * The picks are read once per batch, so a 400-range cut costs one file read.
 */
export function boundsFor(
  env: EditEnv,
  batch: Batch,
  assetPath: string,
  duration: number | null,
): MediaBounds {
  const ranges = (batch.ranges ??= readAssetRanges(env.project.dir));
  return mediaBounds(ranges.get(assetPath), duration);
}

/** Names the user's pick in a refusal, numbers included, so a model can correct itself. */
export function pickedRange(assetPath: string, bounds: MediaBounds): string {
  // A picked bound always has an end; the fallback only satisfies the type.
  return pickedForUse(assetPath, { start: bounds.start, end: bounds.end ?? bounds.start });
}

export interface Gsap {
  domId: string;
  delta: number;
}

export async function loadModel(env: EditEnv, html: string): Promise<CompositionModel> {
  const model = parseComposition(html, env.compositionPath);
  if (!model) {
    throw new EditFailure("unknown_composition", `${env.compositionPath} has no composition root`);
  }
  await env.facts.readMany(env.project.dir, clipMediaPaths(model));
  resolveClipDurations(model, (path) => env.facts.peek(env.project.dir, path));
  return model;
}

export const commit = (batch: Batch, model: CompositionModel) => {
  batch.html = serializeModel(model);
};

export function requireClip(model: CompositionModel, ref: string, env: EditEnv): ClipNode {
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

export function canvasOf(model: CompositionModel) {
  return {
    width: model.width > 0 ? model.width : DEFAULT_CANVAS.width,
    height: model.height > 0 ? model.height : DEFAULT_CANVAS.height,
  };
}

export function usedIds(model: CompositionModel): string[] {
  return [...model.document.querySelectorAll("[id]")].map((element) => element.id);
}

export const CAPTIONS_HOST = '[data-track-kind="captions"]';
/**
 * The captions host stacks in its own band, above the clips an edit places: captions are read over the footage, so a
 * B-roll shot, title or graphic added later must not cover them.
 */
export const CAPTIONS_Z_BAND = 1000;

export function styledZIndex(element: Element): number | null {
  const match = /(?:^|;)\s*z-index\s*:\s*(-?\d+)/i.exec(element.getAttribute("style") ?? "");
  return match?.[1] ? Number.parseInt(match[1], 10) : null;
}

/** Studio's stacking rule: a new clip sits above every styled element already in the composition but the captions. */
export function nextZIndex(model: CompositionModel): number {
  let max = 0;
  for (const element of model.root.querySelectorAll("[style]")) {
    if (element.matches(CAPTIONS_HOST)) continue;
    max = Math.max(max, styledZIndex(element) ?? max);
  }
  return max + 1;
}

/** Where the captions host stacks: in its band, and above everything else even when the band is outgrown. */
export function captionsZIndex(model: CompositionModel): number {
  return Math.max(CAPTIONS_Z_BAND, nextZIndex(model));
}

export function maxTrack(model: CompositionModel): number {
  return model.clips.reduce((max, clip) => Math.max(max, clip.track), -1);
}

export function setStyle(element: Element, property: string, value: string | null): void {
  element.setAttribute(
    "style",
    patchStyleAttrString(element.getAttribute("style") ?? "", property, value),
  );
}

export function setRootDuration(model: CompositionModel, seconds: number): void {
  const holder = model.durationHolder;
  const name =
    !holder.hasAttribute("data-duration") && holder.hasAttribute("data-composition-duration")
      ? "data-composition-duration"
      : "data-duration";
  holder.setAttribute(name, fmt(seconds));
}

/** The media in-point attribute the clip already uses (`data-playback-start` wins, as it does when read). */
export function mediaStartAttr(element: Element): string {
  return element.hasAttribute("data-playback-start") ? "data-playback-start" : "data-media-start";
}

/**
 * Clip-edge fades belong to video and audio, and must fit inside the clip: each within its length, and both together
 * (the ramps would otherwise cross).
 */
export function checkFades(
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

export function setFadeAttribute(element: Element, name: string, seconds: number): void {
  if (seconds > 0) element.setAttribute(name, fmt(seconds));
  else element.removeAttribute(name);
}

export function applyGsap(batch: Batch, shifts: readonly Gsap[]): void {
  for (const { domId, delta } of shifts) batch.html = shiftClipTweens(batch.html, domId, delta);
}

/**
 * The composition length the content may not undercut: the declared one, except that the blank template's 10 s
 * (carried by its untouched placeholder) is not a length anyone chose, so it stops counting once the placeholder is gone.
 */
export function declaredLength(batch: Batch, model: CompositionModel): number {
  if (batch.explicitDuration) return model.duration;
  const placeholderGone =
    batch.hadPlaceholder &&
    !model.clips.some((clip) => isUntouchedTemplatePlaceholder(clip.element));
  return placeholderGone ? 0 : model.duration;
}
