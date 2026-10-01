import { findStartTags } from "@hyperframes/core/compiler/html-document";
import {
  isPreviewManagedVideo,
  STUDIO_PREVIEW_DETACHED_SRC_ATTR,
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

/**
 * Rewrite one `<video>` start tag so it carries no `src`: the source moves to the detached attribute
 * (the runtime's preview media budget attaches it when the clip is near the playhead) and `preload`
 * becomes `none`. Everything else in the tag stays byte for byte.
 */
function detachStartTag(html: string, open: number, tagEnd: number): string {
  const spans = readAttributes(html, open, tagEnd);
  const src = spans.find((span) => span.name === "src");
  if (!src) return html.slice(open, tagEnd);
  const preload = spans.find((span) => span.name === "preload");
  const edits: Array<{ from: number; to: number; text: string }> = [
    { from: src.start, to: src.nameEnd, text: STUDIO_PREVIEW_DETACHED_SRC_ATTR },
  ];
  if (preload) edits.push({ from: preload.start, to: preload.end, text: 'preload="none"' });
  else
    edits.push({
      from: open + "<video".length,
      to: open + "<video".length,
      text: ' preload="none"',
    });
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
 * Serve a preview document with its managed videos (`isPreviewManagedVideo`) holding no `src`.
 *
 * A browser opens a media player for every `<video src>` as the parser meets it; WebKit opens an
 * AVURLAsset per element in its GPU process. A film of a hundred clips must not open a hundred, so
 * the source is withheld at parse and the runtime attaches it only near the playhead. Videos inside
 * `<template>` are left to the runtime, which strips them as it mounts the template; if the
 * document's videos cannot be matched one to one with the scanner's tags, the document is left
 * untouched and the runtime alone paces the loads.
 */
export function detachPreviewVideos(html: string): string {
  if (!/<video[\s>]/i.test(html) || !/<!doctype|<html[\s>]/i.test(html)) return html;
  const videos = [...parseHTML(html).document.querySelectorAll("video")];
  const tags = findStartTags(html, "video");
  if (tags.length !== videos.length) return html;
  const parts: string[] = [];
  let from = 0;
  videos.forEach((video, i) => {
    const open = tags[i];
    if (open === undefined || !isPreviewManagedVideo(video)) return;
    const tagEnd = startTagEnd(html, open);
    if (tagEnd === -1) return;
    parts.push(html.slice(from, open), detachStartTag(html, open, tagEnd));
    from = tagEnd;
  });
  parts.push(html.slice(from));
  return parts.join("");
}
