import { posix } from "node:path";
import type {
  ClipKind,
  ProjectAsset,
  ClipProvenance,
  TimelineClip,
  TimelineSnapshot,
  TimelineTrack,
} from "@hyperframes/agent-protocol";
import { readClipTiming, type ClipTiming } from "@hyperframes/core/composition-contract";
import {
  readMediaOffsetSeconds,
  readPlaybackRate,
  resolveNaturalDurationSeconds,
} from "@hyperframes/parsers/media-duration";
import { isUntouchedTemplatePlaceholder } from "./placeholder.js";
import { fileContentVersion } from "../helpers/fileVersion.js";
import { parseSourceDocument } from "../helpers/sourceMutation.js";

const LABEL_CHARS = 60;

/** One authored clip of a composition: the DOM element plus its resolved timing. */
export interface ClipNode {
  element: Element;
  /** `data-hf-id`. */
  id: string;
  domId: string | null;
  kind: ClipKind;
  start: number;
  /** Timeline length; a media clip without `data-duration` runs to the end of its source. */
  duration: number;
  end: number;
  track: number;
  /** Project-relative media path. */
  src: string | null;
  compositionSrc: string | null;
  mediaStart: number | null;
  playbackRate: number;
  locked: boolean;
}

export interface CompositionModel {
  document: Document;
  wrappedFragment: boolean;
  /** First element carrying `data-composition-id`. */
  root: Element;
  /** The composition element that carries `data-duration` (the root, unless only an inner element does). */
  durationHolder: Element;
  width: number;
  height: number;
  /** Declared duration in seconds (0 when none is authored). */
  duration: number;
  clips: ClipNode[];
}

/** Matches in document order; `<template>` contents are separate subtrees in linkedom, so search each one too. */
function findAll(scope: Document | Element, selector: string): Element[] {
  const found = Array.from(scope.querySelectorAll(selector));
  for (const template of scope.querySelectorAll("template")) {
    found.push(...findAll(template, selector));
  }
  return [...new Set(found)];
}

export function serializeModel(model: Pick<CompositionModel, "document" | "wrappedFragment">) {
  return model.wrappedFragment ? model.document.body.innerHTML || "" : model.document.toString();
}

function numberAttr(element: Element, name: string): number | null {
  const parsed = Number.parseFloat(element.getAttribute(name) ?? "");
  return Number.isFinite(parsed) ? parsed : null;
}

/** Project-relative path of a media `src`, or null for URLs and anything that leaves the project. */
export function resolveProjectRelative(compositionPath: string, src: string | null): string | null {
  const raw = (src ?? "").trim().replace(/[?#].*$/, "");
  if (!raw || /^[a-z][a-z0-9+.-]*:/i.test(raw) || raw.startsWith("//")) return null;
  const joined = raw.startsWith("/")
    ? posix.normalize(raw.slice(1))
    : posix.normalize(posix.join(posix.dirname(compositionPath), raw));
  return joined === ".." || joined.startsWith("../") || joined === "." ? null : joined;
}

function clipKindOf(element: Element): ClipKind {
  const tag = element.tagName.toLowerCase();
  if (element.hasAttribute("data-composition-src") || element.hasAttribute("data-composition-id")) {
    return "composition";
  }
  if (tag === "video") return "video";
  if (tag === "audio") return "audio";
  if (tag === "img") return "image";
  if (element.children.length === 0 && (element.textContent ?? "").trim() !== "") return "text";
  return "element";
}

/**
 * Timed descendants of the root, skipping the root itself and everything inside another clip: a clip's own
 * children are part of that clip (a sub-composition host owns whatever it contains).
 */
function collectClipElements(root: Element): Element[] {
  const clips: Element[] = [];
  const visit = (parent: Element) => {
    for (const child of Array.from(parent.children)) {
      if (child.hasAttribute("data-start")) clips.push(child);
      else visit(child);
    }
  };
  visit(root);
  return clips;
}

/** Parses one composition source; null when it has no composition root. */
export function parseComposition(html: string, compositionPath: string): CompositionModel | null {
  const { document, wrappedFragment } = parseSourceDocument(html);
  const roots = findAll(document, "[data-composition-id]");
  const root = roots[0];
  if (!root) return null;
  const withAttr = (name: string) => roots.find((element) => element.hasAttribute(name)) ?? root;
  const durationHolder = withAttr("data-duration");
  const width = numberAttr(withAttr("data-width"), "data-width") ?? 0;
  const height = numberAttr(withAttr("data-height"), "data-height") ?? 0;
  const duration =
    numberAttr(durationHolder, "data-duration") ??
    numberAttr(withAttr("data-composition-duration"), "data-composition-duration") ??
    0;

  const elements = collectClipElements(root);
  const byRef = new Map<string, Element>();
  for (const element of elements) {
    const hfId = element.getAttribute("data-hf-id");
    if (hfId) byRef.set(hfId, element);
    if (element.id) byRef.set(element.id, element);
  }

  const timings = new Map<Element, ClipTiming>();
  const resolving = new Set<Element>();
  const timingOf = (element: Element): ClipTiming => {
    const cached = timings.get(element);
    if (cached) return cached;
    // A start that references its own chain resolves to "unknown" instead of recursing forever.
    const timing = readClipTiming(element, {
      resolveReferenceEnd: (refId) => {
        const target = byRef.get(refId);
        if (!target || target === element || resolving.has(target)) return null;
        resolving.add(element);
        const end = timingOf(target).end;
        resolving.delete(element);
        return end;
      },
    });
    timings.set(element, timing);
    return timing;
  };

  const clips: ClipNode[] = elements.map((element, index) => {
    const kind = clipKindOf(element);
    const timing = timingOf(element);
    const start = timing.start ?? 0;
    const track = timing.trackSource === "default" ? index : timing.trackIndex;
    const rawSrc = element.getAttribute("src");
    const src = kind === "video" || kind === "audio" || kind === "image" ? rawSrc : null;
    const isMedia = kind === "video" || kind === "audio";
    const getAttr = (name: string) => element.getAttribute(name);
    const mediaStart = isMedia ? readMediaOffsetSeconds(getAttr) : null;
    const playbackRate = isMedia ? readPlaybackRate(getAttr) : 1;
    const compositionSrc = element.getAttribute("data-composition-src");
    return {
      element,
      id: element.getAttribute("data-hf-id") ?? "",
      domId: element.id ? element.id : null,
      kind,
      start,
      // Filled in below once the sources' lengths are known; authored durations are final.
      duration: timing.duration ?? 0,
      end: start + (timing.duration ?? 0),
      track,
      src: src === null ? null : resolveProjectRelative(compositionPath, src),
      compositionSrc:
        compositionSrc === null ? null : resolveProjectRelative(compositionPath, compositionSrc),
      mediaStart,
      playbackRate,
      locked: element.hasAttribute("data-timeline-locked"),
    };
  });

  return { document, wrappedFragment, root, durationHolder, width, height, duration, clips };
}

/** Project-relative media files the clips read, for pre-probing. */
export function clipMediaPaths(model: CompositionModel): string[] {
  return [
    ...new Set(
      model.clips.flatMap((clip) => (clip.src !== null && clip.kind !== "image" ? [clip.src] : [])),
    ),
  ];
}

/** Timeline length of a clip that has no authored duration, from its probed source length. */
export function naturalDuration(clip: ClipNode, sourceDuration: number | null): number | null {
  if (sourceDuration === null) return null;
  return resolveNaturalDurationSeconds(sourceDuration, clip.mediaStart ?? 0, clip.playbackRate);
}

export type SourceLookup = (path: string) => ProjectAsset | undefined;

/**
 * Resolves the durations the source HTML leaves implicit: a video/audio clip without `data-duration` runs to
 * the end of its media (known only when probed); anything else without one fills the rest of the composition.
 */
export function resolveClipDurations(model: CompositionModel, lookup: SourceLookup): void {
  for (const clip of model.clips) {
    if (clip.element.hasAttribute("data-duration") || clip.element.hasAttribute("data-end")) {
      continue;
    }
    const source = clip.src === null ? undefined : lookup(clip.src);
    const natural = naturalDuration(clip, source?.duration ?? null);
    const rest = Math.max(0, model.duration - clip.start);
    clip.duration = natural ?? rest;
    clip.end = clip.start + clip.duration;
  }
}

export function clipLabel(clip: ClipNode): string {
  const { element } = clip;
  if (clip.kind === "text") return (element.textContent ?? "").trim().slice(0, LABEL_CHARS);
  if (clip.src) return clip.src.split("/").pop() ?? clip.src;
  if (clip.kind === "composition") {
    const source = clip.compositionSrc?.split("/").pop();
    return element.id || source || element.getAttribute("data-composition-id") || "composition";
  }
  return element.id || element.tagName.toLowerCase();
}

function zIndexOf(element: Element): number | null {
  const match = /(?:^|;)\s*z-index\s*:\s*(-?\d+)/i.exec(element.getAttribute("style") ?? "");
  return match?.[1] ? Number.parseInt(match[1], 10) : null;
}

/** Markup attributes that carry a clip's provenance. */
const PROVENANCE_ATTRIBUTES = {
  storyNode: "data-ov-story-node",
  cut: "data-ov-cut",
  turn: "data-ov-turn",
} as const satisfies Record<keyof ClipProvenance, string>;

/** The attributes to write for a provenance stamp (only the ids that are set). */
export function provenanceAttributes(
  provenance: Partial<ClipProvenance> | undefined,
): Record<string, string> {
  const attributes: Record<string, string> = {};
  if (provenance?.storyNode) attributes[PROVENANCE_ATTRIBUTES.storyNode] = provenance.storyNode;
  if (provenance?.cut) attributes[PROVENANCE_ATTRIBUTES.cut] = provenance.cut;
  if (provenance?.turn) attributes[PROVENANCE_ATTRIBUTES.turn] = provenance.turn;
  return attributes;
}

export function stampProvenance(
  element: Element,
  provenance: Partial<ClipProvenance> | undefined,
): void {
  for (const [name, value] of Object.entries(provenanceAttributes(provenance))) {
    element.setAttribute(name, value);
  }
}

/** A clip's provenance read back from its markup; null when it carries none. */
export function readClipProvenance(element: Element): ClipProvenance | null {
  const read: ClipProvenance = {
    storyNode: element.getAttribute(PROVENANCE_ATTRIBUTES.storyNode),
    cut: element.getAttribute(PROVENANCE_ATTRIBUTES.cut),
    turn: element.getAttribute(PROVENANCE_ATTRIBUTES.turn),
  };
  return read.storyNode === null && read.cut === null && read.turn === null ? null : read;
}

function toWireClip(clip: ClipNode, lookup: SourceLookup): TimelineClip {
  const { element } = clip;
  const isMedia = clip.kind === "video" || clip.kind === "audio";
  const volume = isMedia ? numberAttr(element, "data-volume") : null;
  const sourceDuration = clip.src === null ? null : (lookup(clip.src)?.duration ?? null);
  return {
    id: clip.id,
    domId: clip.domId,
    kind: clip.kind,
    label: clipLabel(clip),
    start: clip.start,
    duration: clip.duration,
    end: clip.end,
    track: clip.track,
    zIndex: zIndexOf(element),
    src: clip.src,
    mediaStart: clip.mediaStart,
    sourceDuration,
    volume: isMedia ? (volume ?? 1) : null,
    muted: isMedia && element.hasAttribute("muted"),
    compositionSrc: clip.compositionSrc,
    locked: clip.locked,
    ...(isUntouchedTemplatePlaceholder(element) && { placeholder: true }),
    provenance: readClipProvenance(element),
  };
}

/** The wire snapshot of a parsed composition: clips ordered by track then start, grouped into tracks. */
export function toSnapshot(
  model: CompositionModel,
  compositionPath: string,
  content: string,
  lookup: SourceLookup,
): TimelineSnapshot {
  const clips = model.clips
    .map((clip) => toWireClip(clip, lookup))
    .sort((a, b) => a.track - b.track || a.start - b.start);
  const tracks: TimelineTrack[] = [];
  for (const clip of clips) {
    const last = tracks[tracks.length - 1];
    if (last && last.index === clip.track) last.clipIds.push(clip.id);
    else tracks.push({ index: clip.track, clipIds: [clip.id] });
  }
  return {
    composition: {
      path: compositionPath,
      width: model.width,
      height: model.height,
      duration: model.duration,
    },
    version: editingVersion(content),
    tracks,
    clips,
  };
}

/**
 * The composition's content version as a plain token (`sha256:<hex>`). The HTTP ETag form carries quotes, which
 * models drop when they copy the value back, so the editing contract uses the bare token and accepts either form.
 */
export function editingVersion(content: string): string {
  return fileContentVersion(content).replace(/^"|"$/g, "");
}

/** Resolves a clip id (`data-hf-id`, or the DOM `id`) among the composition's clips. */
export function findClip(model: CompositionModel, ref: string): ClipNode | undefined {
  return (
    model.clips.find((clip) => clip.id === ref) ?? model.clips.find((clip) => clip.domId === ref)
  );
}
