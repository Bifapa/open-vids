import { readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { parseHTML } from "linkedom";
import { lockedEditAdvice } from "../autonomy.ts";
import { resolveProjectFileTargets } from "./path-guard.ts";

/**
 * A clip the user locked in the Studio timeline carries `data-timeline-locked`. The editing service
 * refuses to touch it, but the specialists also own OMP's `edit`/`write`, which would rewrite the
 * clip straight in the composition HTML. This guard computes what such a call would leave in the
 * file and refuses it when a locked element would be removed, changed, or unlocked.
 */

const LOCK_ATTRIBUTE = "data-timeline-locked";
const HTML_EXTENSIONS: Record<string, true> = { ".html": true, ".htm": true };
const UNREADABLE_OK: Record<string, true> = { ENOENT: true, ENOTDIR: true, EISDIR: true };
const EDIT_KEYS: Record<string, true> = {
  path: true,
  old_string: true,
  new_string: true,
  replace_all: true,
};
const WRITE_KEYS: Record<string, true> = { path: true, content: true };

interface ClipElement {
  hfId: string | null;
  id: string | null;
  locked: boolean;
  html: string;
}

function readAttribute(element: Element, name: string): string | null {
  // linkedom keeps the source case of attribute names; browsers lowercase them.
  for (const attribute of Array.from(element.attributes)) {
    if (attribute.name.toLowerCase() === name) return attribute.value;
  }
  return null;
}

/** Every element of the document, including the contents of `<template>` (sub-composition files). */
function collectElements(source: string): ClipElement[] {
  const { document } = parseHTML(source);
  const elements: ClipElement[] = [];
  const roots: ParentNode[] = [document];
  while (roots.length > 0) {
    const root = roots.pop();
    if (!root) break;
    for (const element of Array.from(root.querySelectorAll("*"))) {
      elements.push({
        hfId: readAttribute(element, "data-hf-id"),
        id: readAttribute(element, "id"),
        locked: readAttribute(element, LOCK_ATTRIBUTE) !== null,
        html: element.outerHTML,
      });
      if (element.localName === "template") roots.push(element);
    }
  }
  return elements;
}

/** OMP's edit tools match on BOM-less, LF-only text and restore the file's line endings afterwards. */
function normalizeText(text: string): string {
  return text.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
}

/** The text OMP's `edit`/`write` would leave in the file, or why that cannot be determined. */
function resultingContent(
  toolName: string,
  input: unknown,
  current: string,
): { content: string } | { reason: string } {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return { reason: "its arguments are not an object" };
  }
  const allowed = toolName === "edit" ? EDIT_KEYS : WRITE_KEYS;
  for (const key of Object.keys(input)) {
    if (!Object.hasOwn(allowed, key)) return { reason: `it passes an unsupported "${key}" field` };
  }
  const args: Record<string, unknown> = { ...input };

  if (toolName === "write") {
    if (typeof args.content !== "string") return { reason: "it has no text content" };
    return { content: normalizeText(args.content) };
  }

  const { old_string: oldString, new_string: newString, replace_all: replaceAll } = args;
  if (typeof oldString !== "string" || typeof newString !== "string") {
    return { reason: "it does not give an old_string and a new_string" };
  }
  if (replaceAll !== undefined && typeof replaceAll !== "boolean") {
    return { reason: "replace_all is not a boolean" };
  }
  const search = normalizeText(oldString);
  if (!search) return { reason: "old_string is empty" };
  const replacement = normalizeText(newString);
  const base = normalizeText(current);
  const occurrences = base.split(search).length - 1;
  if (occurrences === 0) {
    return { reason: "old_string does not match the file text exactly" };
  }
  if (occurrences > 1 && replaceAll !== true) {
    return { reason: `old_string matches ${occurrences} places and replace_all is not set` };
  }
  return { content: base.split(search).join(replacement) };
}

function clipLabel(clip: ClipElement): string {
  if (clip.id) return `#${clip.id}`;
  if (clip.hfId) return clip.hfId;
  return clip.html.slice(0, 60);
}

/** What the change does to the first locked clip it breaks, or null when every locked clip survives. */
interface LockedClipViolation {
  clip: ClipElement;
  action: string;
}

function lockedClipViolation(
  current: ClipElement[],
  next: ClipElement[],
): LockedClipViolation | null {
  const survivingAnonymous = new Map<string, number>();
  for (const element of next) {
    if (element.locked && !element.hfId && !element.id) {
      survivingAnonymous.set(element.html, (survivingAnonymous.get(element.html) ?? 0) + 1);
    }
  }
  for (const clip of current) {
    if (!clip.locked) continue;
    if (!clip.hfId && !clip.id) {
      const left = survivingAnonymous.get(clip.html) ?? 0;
      if (left === 0) return { clip, action: "change, unlock or remove" };
      survivingAnonymous.set(clip.html, left - 1);
      continue;
    }
    const same = next.filter(
      (element) =>
        (clip.hfId !== null && element.hfId === clip.hfId) ||
        (clip.id !== null && element.id === clip.id),
    );
    if (same.some((element) => element.html === clip.html)) continue;
    if (same.length === 0) return { clip, action: "remove" };
    return { clip, action: same.some((element) => element.locked) ? "change" : "unlock" };
  }
  return null;
}

/**
 * Null when the call may run; otherwise the message the agent sees. `askFirst` is the user's "ask before changing locked
 * sections" setting: it decides whether the message tells the agent to stop and ask or to leave the clip and carry on.
 */
export async function guardLockedClips(
  projectDir: string,
  input: unknown,
  toolName?: string,
  askFirst = true,
): Promise<string | null> {
  if (toolName !== "edit" && toolName !== "write") return null;

  const targets = await resolveProjectFileTargets(projectDir, input);
  const root = targets.length > 0 ? await realpath(projectDir) : projectDir;
  for (const target of targets) {
    if (!Object.hasOwn(HTML_EXTENSIONS, path.extname(target).toLowerCase())) continue;
    const display = path.relative(root, target) || target;

    let current: string;
    try {
      current = await readFile(target, "utf8");
    } catch (error) {
      const code =
        typeof error === "object" && error !== null && "code" in error ? error.code : undefined;
      if (typeof code === "string" && Object.hasOwn(UNREADABLE_OK, code)) continue;
      return `${display} could not be read to check it for locked timeline clips, so the ${toolName} was blocked.`;
    }
    if (!current.toLowerCase().includes(LOCK_ATTRIBUTE)) continue;

    const outcome = resultingContent(toolName, input, current);
    if ("reason" in outcome) {
      return `${display} contains clips the user locked in the timeline, and this ${toolName} call cannot be checked against them (${outcome.reason}), so it was blocked. Use an edit with an exact old_string that matches once (or replace_all), and leave locked clips untouched.`;
    }

    let violation: LockedClipViolation | null;
    try {
      violation = lockedClipViolation(
        collectElements(normalizeText(current)),
        collectElements(outcome.content),
      );
    } catch {
      return `${display} could not be parsed to check it for locked timeline clips, so the ${toolName} was blocked.`;
    }
    if (violation) {
      return `This ${toolName} would ${violation.action} the locked clip ${JSON.stringify(clipLabel(violation.clip))} in ${display}. The user locked it in the timeline (${LOCK_ATTRIBUTE}) and agents cannot change it. ${lockedEditAdvice(askFirst)}`;
    }
  }
  return null;
}
