import { findStartTags } from "@hyperframes/core/compiler/html-document";
import {
  isPreviewManagedVideo,
  isPreviewPacedAudio,
  STUDIO_PREVIEW_DETACHED_SRC_ATTR,
  type PreviewVideoProbe,
} from "@hyperframes/core/studio-preview-mark";
import { parseHTML } from "linkedom";

interface AttributeSpan {
  name: string;
  /** Offsets into the document: `start` is the name's first character, `end` just past the value. */
  start: number;
  nameEnd: number;
  end: number;
}

const WHITESPACE = /\s/;

/** Offset just past the `>` that ends the start tag at `open`, honouring quoted values; -1 if unclosed. */
function startTagEnd(html: string, open: number): number {
  let quote: string | null = null;
  for (let at = open + 1; at < html.length; at += 1) {
    const ch = html.charAt(at);
    if (quote !== null) {
      if (ch === quote) quote = null;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === ">") {
      return at + 1;
    }
  }
  return -1;
}

/** The attributes of the start tag at `open`, as offsets, so one can be renamed without re-serializing. */
function readAttributes(html: string, open: number, tagEnd: number): AttributeSpan[] {
  const spans: AttributeSpan[] = [];
  let at = open + 1;
  while (at < tagEnd && !WHITESPACE.test(html.charAt(at)) && html.charAt(at) !== ">") at += 1;
  while (at < tagEnd - 1) {
    while (at < tagEnd - 1 && (WHITESPACE.test(html.charAt(at)) || html.charAt(at) === "/"))
      at += 1;
    if (at >= tagEnd - 1) break;
    const start = at;
    while (at < tagEnd - 1 && !/[\s=/>]/.test(html.charAt(at))) at += 1;
    const nameEnd = at;
    let end = at;
    let probe = at;
    while (probe < tagEnd - 1 && WHITESPACE.test(html.charAt(probe))) probe += 1;
    if (html.charAt(probe) === "=") {
      probe += 1;
      while (probe < tagEnd - 1 && WHITESPACE.test(html.charAt(probe))) probe += 1;
      const quote = html.charAt(probe);
      if (quote === '"' || quote === "'") {
        const close = html.indexOf(quote, probe + 1);
        probe = close === -1 ? tagEnd - 1 : close + 1;
      } else {
        while (probe < tagEnd - 1 && !WHITESPACE.test(html.charAt(probe))) probe += 1;
      }
      end = probe;
      at = probe;
    }
    if (nameEnd > start)
      spans.push({ name: html.slice(start, nameEnd).toLowerCase(), start, nameEnd, end });
  }
  return spans;
}

type TagEdit = { from: number; to: number; text: string };

/** `preload="none"` in place of the authored one, or as the first attribute. */
function preloadNoneEdit(open: number, tagName: string, spans: AttributeSpan[]): TagEdit {
  const preload = spans.find((span) => span.name === "preload");
  if (preload) return { from: preload.start, to: preload.end, text: 'preload="none"' };
  const at = open + 1 + tagName.length;
  return { from: at, to: at, text: ' preload="none"' };
}

function applyEdits(html: string, open: number, tagEnd: number, edits: TagEdit[]): string {
  edits.sort((a, b) => a.from - b.from);
  const parts: string[] = [];
  let from = open;
  for (const edit of edits) {
    parts.push(html.slice(from, edit.from), edit.text);
    from = edit.to;
  }
  parts.push(html.slice(from, tagEnd));
  return parts.join("");
}

/**
 * Rewrite one `<video>` start tag so it carries no `src`: the source moves to the detached attribute
 * (the runtime's preview media budget attaches it when the clip is near the playhead) and `preload`
 * becomes `none`. Everything else in the tag stays byte for byte.
 */
function detachStartTag(html: string, open: number, tagEnd: number): string {
  const spans = readAttributes(html, open, tagEnd);
  const src = spans.find((span) => span.name === "src");
  if (!src) return html.slice(open, tagEnd);
  return applyEdits(html, open, tagEnd, [
    { from: src.start, to: src.nameEnd, text: STUDIO_PREVIEW_DETACHED_SRC_ATTR },
    preloadNoneEdit(open, "video", spans),
  ]);
}

/**
 * Rewrite one `<audio>` start tag so it keeps its `src` but loads nothing at parse (`preload="none"`):
 * the runtime's preview media budget starts the load when the clip is near the playhead.
 */
function deferStartTag(html: string, open: number, tagEnd: number): string {
  const spans = readAttributes(html, open, tagEnd);
  return applyEdits(html, open, tagEnd, [preloadNoneEdit(open, "audio", spans)]);
}

/** Rewrite the start tags of the live (non-template) `tagName` elements `rewrite` accepts. */
function rewriteMediaStartTags(
  html: string,
  tagName: "video" | "audio",
  accepts: (el: PreviewVideoProbe) => boolean,
  rewrite: (html: string, open: number, tagEnd: number) => string,
): string {
  if (!new RegExp(`<${tagName}[\\s>]`, "i").test(html)) return html;
  const elements = [...parseHTML(html).document.querySelectorAll(tagName)];
  const tags = findStartTags(html, tagName);
  if (tags.length !== elements.length) return html;
  const parts: string[] = [];
  let from = 0;
  elements.forEach((el, i) => {
    const open = tags[i];
    if (open === undefined || !accepts(el)) return;
    const tagEnd = startTagEnd(html, open);
    if (tagEnd === -1) return;
    parts.push(html.slice(from, open), rewrite(html, open, tagEnd));
    from = tagEnd;
  });
  parts.push(html.slice(from));
  return parts.join("");
}

/**
 * Serve a preview document whose media opens nothing at parse: managed videos
 * (`isPreviewManagedVideo`) hold no `src`, paced audio (`isPreviewPacedAudio`) keeps its `src` with
 * `preload="none"`.
 *
 * A browser opens a media player for every `<video src>` / `<audio src>` as the parser meets it;
 * WebKit opens an AVURLAsset per element in its GPU process. A film of a hundred clips must not open
 * a hundred: opening dozens at once and then deleting players whose asset is still opening
 * deadlocked the WebContent and GPU processes. The runtime's preview media budget starts the loads
 * near the playhead, a few at a time. Media inside `<template>` is left to the runtime, which
 * prepares it as it mounts the template; if the document's tags cannot be matched one to one with
 * the scanner's, that kind is left untouched and the runtime alone paces the loads.
 */
export function deferPreviewMedia(html: string): string {
  if (!/<!doctype|<html[\s>]/i.test(html)) return html;
  const detached = rewriteMediaStartTags(html, "video", isPreviewManagedVideo, detachStartTag);
  return rewriteMediaStartTags(detached, "audio", isPreviewPacedAudio, deferStartTag);
}
