import { parseStartTagAttributes, scanStartTags } from "../compiler/htmlMarkupScan.js";
import { AUDIO_EXT, IMAGE_EXT, VIDEO_EXT } from "../mediaTypes.js";

/**
 * Locate the opening tag of the first composition root element (the first start tag that carries a
 * non-empty `data-composition-id`), e.g. `<div data-composition-id="main">`. A root outside any
 * `<template>` wins; otherwise the first one inside a template is used (the standard
 * `<template><div data-composition-id>` sub-composition layout). Comments, raw-text elements and
 * quoted attribute values are skipped, and any attribute quoting is accepted. `end` is the offset
 * just past the tag's `>`.
 */
export function findCompositionRootOpenTag(
  source: string,
): { start: number; end: number; tag: string } | null {
  let inTemplateRoot: { start: number; end: number; tag: string } | null = null;
  for (const range of scanStartTags(source)) {
    const tag = source.slice(range.start, range.end);
    if (!parseStartTagAttributes(tag).get("data-composition-id")) continue;
    if (!range.inTemplate) return { start: range.start, end: range.end, tag };
    inTemplateRoot ??= { start: range.start, end: range.end, tag };
  }
  return inTemplateRoot;
}

export type TimelineAssetKind = "image" | "video" | "audio";

export function getTimelineAssetKind(assetPath: string): TimelineAssetKind | null {
  if (IMAGE_EXT.test(assetPath)) return "image";
  if (VIDEO_EXT.test(assetPath)) return "video";
  if (AUDIO_EXT.test(assetPath)) return "audio";
  return null;
}

export function buildTimelineAssetId(assetPath: string, existingIds: Iterable<string>): string {
  const baseName = assetPath.split("/").pop() ?? "asset";
  const normalized = baseName
    .replace(/\.[^.]+$/, "")
    .replace(/[^a-zA-Z0-9_-]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .toLowerCase();
  const baseId = normalized || "asset";
  const ids = new Set(existingIds);
  if (!ids.has(baseId)) return baseId;
  let suffix = 2;
  while (ids.has(`${baseId}_${suffix}`)) suffix += 1;
  return `${baseId}_${suffix}`;
}

/**
 * A project-relative file path as the URL a `src` attribute holds: every segment percent-encoded
 * (so `#`, `?`, `%`, spaces and quotes stay part of the file name), `/` kept. A browser, the render
 * compiler and the editing service all decode it back to the name on disk.
 */
export function encodeAssetUrlPath(path: string): string {
  return path
    .split("/")
    .map((segment) =>
      encodeURIComponent(segment).replace(
        /[!'()*]/g,
        (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
      ),
    )
    .join("/");
}

function escapeHtmlAttribute(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

export function resolveTimelineAssetSrc(targetPath: string, assetPath: string): string {
  const targetDir = targetPath.includes("/")
    ? targetPath.slice(0, targetPath.lastIndexOf("/"))
    : "";
  if (!targetDir) return assetPath;

  const fromParts = targetDir.split("/").filter(Boolean);
  const toParts = assetPath.split("/").filter(Boolean);
  while (fromParts.length > 0 && toParts.length > 0 && fromParts[0] === toParts[0]) {
    fromParts.shift();
    toParts.shift();
  }

  const up = fromParts.map(() => "..");
  const relative = [...up, ...toParts].join("/");
  return relative || assetPath.split("/").pop() || assetPath;
}

/**
 * CapCut-style placement: natural size when it fits, scaled-to-fit when
 * oversized, always centered. Unknown natural size → full-frame.
 */
export function fitTimelineAssetGeometry(
  natural: { width: number; height: number } | null,
  comp: { width: number; height: number },
): { left: number; top: number; width: number; height: number } {
  if (!natural || natural.width <= 0 || natural.height <= 0) {
    return { left: 0, top: 0, width: comp.width, height: comp.height };
  }
  const scale = Math.min(1, comp.width / natural.width, comp.height / natural.height);
  const width = Math.round(natural.width * scale);
  const height = Math.round(natural.height * scale);
  return {
    left: Math.round((comp.width - width) / 2),
    top: Math.round((comp.height - height) / 2),
    width,
    height,
  };
}

export function buildTimelineAssetInsertHtml(input: {
  id: string;
  hfId: string;
  assetPath: string;
  kind: TimelineAssetKind;
  start: number;
  duration: number;
  track: number;
  zIndex: number;
  geometry?: { left: number; top: number; width: number; height: number };
  /** Video only: true inserts `data-has-audio="true"` with no `muted`. Unknown or false stays muted. */
  hasAudio?: boolean;
  /** Visual media only; default `contain`. */
  fit?: "contain" | "cover";
  /** Video/audio: source in-point in seconds. */
  mediaStart?: number;
  /** Video/audio: `data-volume`; audio defaults to 1. */
  volume?: number;
  /** Video/audio: true forces `muted` (and no `data-has-audio`). */
  muted?: boolean;
  /** Video/audio: clip-edge fades in seconds (`data-fade-in` / `data-fade-out`); 0 or unset writes nothing. */
  fadeIn?: number;
  fadeOut?: number;
  /** Extra attributes written on the element (values are escaped); used for provenance stamps. */
  attributes?: Readonly<Record<string, string>>;
}): string {
  const extraAttributes = Object.entries(input.attributes ?? {})
    .map(([name, value]) => ` ${name}="${escapeHtmlAttribute(value)}"`)
    .join("");
  const sharedAttrs = `id="${escapeHtmlAttribute(input.id)}" data-hf-id="${escapeHtmlAttribute(input.hfId)}" class="clip" src="${escapeHtmlAttribute(encodeAssetUrlPath(input.assetPath))}" data-start="${input.start}" data-duration="${input.duration}" data-track-index="${input.track}"${extraAttributes}`;
  const geometry = input.geometry ?? { left: 0, top: 0, width: 640, height: 360 };
  const visualStyles = `position: absolute; left: ${geometry.left}px; top: ${geometry.top}px; width: ${geometry.width}px; height: ${geometry.height}px; object-fit: ${input.fit ?? "contain"}; z-index: ${input.zIndex}`;
  const fadeAttrs = [
    ...(input.fadeIn ? [`data-fade-in="${input.fadeIn}"`] : []),
    ...(input.fadeOut ? [`data-fade-out="${input.fadeOut}"`] : []),
  ];
  const mediaAttrs = [
    ...(input.mediaStart ? [`data-media-start="${input.mediaStart}"`] : []),
    ...(input.volume !== undefined && input.kind !== "audio"
      ? [`data-volume="${input.volume}"`]
      : []),
    ...fadeAttrs,
  ].join(" ");
  const extraMedia = mediaAttrs ? ` ${mediaAttrs}` : "";

  if (input.kind === "image") {
    return `<img ${sharedAttrs} style="${visualStyles}" />`;
  }

  if (input.kind === "video") {
    // `muted` and `data-has-audio="true"` are mutually exclusive by the lint
    // contract (video_has_audio_but_muted): an audible drop takes the latter.
    const audio = input.hasAudio && !input.muted ? 'data-has-audio="true"' : "muted";
    return `<video ${sharedAttrs} ${audio}${extraMedia} playsinline style="${visualStyles}"></video>`;
  }

  const muted = input.muted ? " muted" : "";
  return `<audio ${sharedAttrs} data-volume="${input.volume ?? 1}"${muted}${input.mediaStart ? ` data-media-start="${input.mediaStart}"` : ""}${fadeAttrs.length ? ` ${fadeAttrs.join(" ")}` : ""} style="z-index: ${input.zIndex}"></audio>`;
}

export function insertTimelineAssetIntoSource(source: string, assetHtml: string): string {
  const root = findCompositionRootOpenTag(source);
  if (!root) {
    throw new Error("No composition root found in target source");
  }
  const insertAt = root.end;
  const lineStart = source.lastIndexOf("\n", root.start);
  const leadingWhitespace = source.slice(lineStart + 1, root.start).match(/^(\s*)/)?.[1] ?? "";
  const childIndent = leadingWhitespace + "  ";
  const indented = assetHtml
    .split("\n")
    .map((line, i) => (i === 0 ? line : childIndent + line))
    .join("\n");
  return `${source.slice(0, insertAt)}\n${childIndent}${indented}${source.slice(insertAt)}`;
}
