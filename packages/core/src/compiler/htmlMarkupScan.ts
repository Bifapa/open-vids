/**
 * Dependency-free HTML markup scanner shared by the compiler and the Studio-facing editing helpers.
 *
 * It walks start tags the way a browser tokenizer would for the purpose of *locating* them: comments,
 * raw-text elements (script, style, title, textarea), bogus close tags and quoted attribute values
 * (which may contain `>`) never produce false tag boundaries. It never builds a DOM.
 */

/** Lowercases A-Z only, so indexes found in the result are valid in the input ("İ" lowercases to two chars). */
export function lowerAscii(text: string): string {
  return text.replace(/[A-Z]+/g, (letters) => letters.toLowerCase());
}

export function isHtmlWhitespace(char: string): boolean {
  return char === " " || char === "\n" || char === "\t" || char === "\r" || char === "\f";
}

export function isTagBoundary(char: string): boolean {
  return char === "" || char === ">" || char === "/" || isHtmlWhitespace(char);
}

type TagState = "tagName" | "between" | "name" | "equals" | "value";

/** Index of the `>` that closes the start tag whose name begins at `from`, or -1. */
export function findTagEnd(html: string, from: number): number {
  let quote: string | undefined;
  let state: TagState = "tagName";
  for (let index = from; index < html.length; index += 1) {
    const char = html.charAt(index);
    if (quote) {
      quote = char === quote ? undefined : quote;
      continue;
    }
    if (char === ">") return index;
    if (state === "equals" && (char === '"' || char === "'")) {
      quote = char;
      state = "between";
      continue;
    }
    state = nextTagState(state, char, index === from);
  }
  return -1;
}

function nextTagState(state: TagState, char: string, first: boolean): TagState {
  if (isHtmlWhitespace(char)) return stateAfterWhitespace(state);
  if (char === "/" && !first) return stateAfterSlash(state);
  if (char === "=" && state === "name") return "equals";
  if (state === "equals") return "value";
  return state === "between" ? "name" : state;
}

function stateAfterWhitespace(state: TagState): TagState {
  return state === "tagName" || state === "value" ? "between" : state;
}

function stateAfterSlash(state: TagState): TagState {
  return state === "equals" || state === "value" ? "value" : "between";
}

const RAW_TEXT_TAGS = ["script", "style", "title", "textarea"] as const;

const COMMENT_END = /--!?>/g;

/** Offsets of every `<` that starts markup (not text inside comments or raw-text elements). */
export function* markupStarts(lowered: string): Generator<number> {
  const unclosedRawText = new Set<string>();
  let cursor = 0;
  while (cursor !== -1) {
    const open = lowered.indexOf("<", cursor);
    if (open === -1) return;
    yield open;
    cursor = skipMarkup(lowered, open, unclosedRawText);
  }
}

export function isTagAt(lowered: string, at: number, token: string): boolean {
  return lowered.startsWith(token, at) && isTagBoundary(lowered.charAt(at + token.length));
}

/** Offsets of each `<name` start tag (any case), none inside comments, raw text or `<template>`. */
export function findStartTags(html: string, name: string): number[] {
  const lowered = lowerAscii(html);
  const token = `<${lowerAscii(name)}`;
  const starts: number[] = [];
  let templateDepth = 0;
  for (const open of markupStarts(lowered)) {
    if (templateDepth === 0 && isTagAt(lowered, open, token)) starts.push(open);
    if (isTagAt(lowered, open, "<template")) templateDepth++;
    else if (templateDepth > 0 && isTagAt(lowered, open, "</template")) templateDepth--;
  }
  return starts;
}

export interface StartTagRange {
  /** Offset of the opening `<`. */
  start: number;
  /** Offset just past the closing `>`. */
  end: number;
}

/** A start tag located by {@link scanStartTags}; `inTemplate` is true inside a `<template>` element. */
export interface ScannedStartTag extends StartTagRange {
  inTemplate: boolean;
}

/**
 * Every complete start tag of any name, in document order, skipping comments and raw text.
 * Tags inside `<template>` elements are included and flagged.
 */
export function scanStartTags(html: string): ScannedStartTag[] {
  const lowered = lowerAscii(html);
  const tags: ScannedStartTag[] = [];
  let templateDepth = 0;
  for (const open of markupStarts(lowered)) {
    if (/[a-z]/.test(lowered.charAt(open + 1))) {
      const tagEnd = findTagEnd(lowered, open + 1);
      if (tagEnd !== -1) tags.push({ start: open, end: tagEnd + 1, inTemplate: templateDepth > 0 });
    }
    if (isTagAt(lowered, open, "<template")) templateDepth++;
    else if (templateDepth > 0 && isTagAt(lowered, open, "</template")) templateDepth--;
  }
  return tags;
}

/**
 * Every complete start tag of any name, in document order, skipping comments, raw text and the
 * content of `<template>` elements.
 */
export function findAllStartTags(html: string): StartTagRange[] {
  return scanStartTags(html)
    .filter((tag) => !tag.inTemplate)
    .map(({ start, end }) => ({ start, end }));
}

/**
 * Attributes of one start tag (`<div a="1" b='2' c=3 d>`), names lowercased, values undecoded.
 * A valueless attribute maps to "".
 */
export function parseStartTagAttributes(tag: string): Map<string, string> {
  const attributes = new Map<string, string>();
  let cursor = 1;
  while (cursor < tag.length && !isTagBoundary(tag.charAt(cursor))) cursor += 1;
  while (cursor < tag.length) {
    while (isHtmlWhitespace(tag.charAt(cursor)) || tag.charAt(cursor) === "/") cursor += 1;
    if (cursor >= tag.length || tag.charAt(cursor) === ">") break;
    const nameStart = cursor;
    cursor += 1;
    while (
      cursor < tag.length &&
      !isTagBoundary(tag.charAt(cursor)) &&
      tag.charAt(cursor) !== "="
    ) {
      cursor += 1;
    }
    const name = lowerAscii(tag.slice(nameStart, cursor));
    let probe = cursor;
    while (isHtmlWhitespace(tag.charAt(probe))) probe += 1;
    let value = "";
    if (tag.charAt(probe) === "=") {
      probe += 1;
      while (isHtmlWhitespace(tag.charAt(probe))) probe += 1;
      const quote = tag.charAt(probe);
      if (quote === '"' || quote === "'") {
        const close = tag.indexOf(quote, probe + 1);
        const valueEnd = close === -1 ? tag.length : close;
        value = tag.slice(probe + 1, valueEnd);
        probe = valueEnd + 1;
      } else {
        const valueStart = probe;
        while (
          probe < tag.length &&
          !isHtmlWhitespace(tag.charAt(probe)) &&
          tag.charAt(probe) !== ">"
        ) {
          probe += 1;
        }
        value = tag.slice(valueStart, probe);
      }
      cursor = probe;
    }
    if (!attributes.has(name)) attributes.set(name, value);
  }
  return attributes;
}

/** Cursor just past the markup that starts at `open`, or -1 when the document ends inside it. */
function skipMarkup(lowered: string, open: number, unclosedRawText: Set<string>): number {
  if (lowered.startsWith("<!--", open)) return skipComment(lowered, open);
  const next = lowered.charAt(open + 1);
  if (next === "/" && !/[a-z]/.test(lowered.charAt(open + 2))) {
    const bogusEnd = lowered.indexOf(">", open);
    return bogusEnd === -1 ? -1 : bogusEnd + 1;
  }
  if (!/[a-z/]/.test(next)) return open + 1;
  const tagEnd = findTagEnd(lowered, open + 1);
  return tagEnd === -1 ? -1 : skipRawText(lowered, open, tagEnd, unclosedRawText);
}

function skipComment(lowered: string, open: number): number {
  if (lowered.startsWith("<!-->", open) || lowered.startsWith("<!--->", open)) {
    return lowered.indexOf(">", open) + 1;
  }
  COMMENT_END.lastIndex = open + 4;
  const end = COMMENT_END.exec(lowered);
  return end ? end.index + end[0].length : -1;
}

function skipRawText(
  lowered: string,
  open: number,
  tagEnd: number,
  unclosedRawText: Set<string>,
): number {
  const rawText = RAW_TEXT_TAGS.find((name) => isTagAt(lowered, open, `<${name}`));
  if (!rawText) return tagEnd + 1;
  const close = unclosedRawText.has(rawText) ? -1 : findRawTextClose(lowered, rawText, tagEnd + 1);
  if (close !== -1) return close;
  unclosedRawText.add(rawText);
  return lowered.charAt(tagEnd - 1) === "/" ? tagEnd + 1 : -1;
}

function findRawTextClose(lowered: string, name: string, from: number): number {
  const close = `</${name}`;
  for (let at = lowered.indexOf(close, from); at !== -1; at = lowered.indexOf(close, at + 1)) {
    if (isTagAt(lowered, at, close)) return at;
  }
  return -1;
}
