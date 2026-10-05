import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import type { CaptionCue, PresetInfo } from "@hyperframes/agent-protocol";
import { MAIN_COMPOSITION } from "./inventory.js";

export const CAPTIONS_FILE = "compositions/captions.html";

/**
 * The captions composition a composition hosts: the main video keeps `compositions/captions.html`, every other
 * composition gets `compositions/captions-<its name>-<hash of its path>.html`, so captioning one never replaces
 * another's cues (the hash keeps `compositions/a/b.html`, `compositions/a-b.html` and `a/b.html` apart).
 */
export function captionsFileFor(compositionPath: string): string {
  if (compositionPath === MAIN_COMPOSITION) return CAPTIONS_FILE;
  const name = compositionPath
    .replace(/\.html$/i, "")
    .replace(/^compositions\//, "")
    .replace(/[^A-Za-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  const hash = createHash("sha1").update(compositionPath).digest("hex").slice(0, 8);
  return `compositions/captions-${name || "scene"}-${hash}.html`;
}

const CAPTIONS_FILE_RE = /^compositions\/captions-.+-[0-9a-f]{8}\.html$/;

/** Whether a project-relative composition path is a captions composition made by `apply_captions`. */
export function isCaptionsFile(path: string | null): boolean {
  return path === CAPTIONS_FILE || (path !== null && CAPTIONS_FILE_RE.test(path));
}

/**
 * The clip of a composition that mounts its captions: the one on the composition's own captions file, else (for a
 * composition other than the main video) a host still mounting the shared `compositions/captions.html`, which
 * captions applied before each composition had its own file left behind.
 */
export function findCaptionsHost<T extends { compositionSrc: string | null }>(
  clips: readonly T[],
  compositionPath: string,
): { host: T; legacy: boolean } | null {
  const own = captionsFileFor(compositionPath);
  const exact = clips.find((clip) => clip.compositionSrc === own);
  if (exact) return { host: exact, legacy: false };
  if (compositionPath === MAIN_COMPOSITION) return null;
  const shared = clips.find((clip) => clip.compositionSrc === CAPTIONS_FILE);
  return shared ? { host: shared, legacy: true } : null;
}

export const CAPTION_SKIN_FILE = "caption-skin.html";
const PRESET_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

const round3 = (value: number) => Math.round(value * 1000) / 1000;

interface CaptionWord {
  id: string;
  text: string;
  start: number;
  end: number;
}

interface CaptionGroup {
  id: string;
  start: number;
  end: number;
  text: string;
  words: CaptionWord[];
}

/** Path of a preset's skin file, or null when the name is not a folder of the skins directory. */
export function captionSkinPath(skinsDir: string, name: string): string | null {
  if (!PRESET_NAME_RE.test(name)) return null;
  const file = join(skinsDir, name, CAPTION_SKIN_FILE);
  return existsSync(file) ? file : null;
}

/** Cues (sorted by start) become caption groups; the cue span is divided evenly among its words. */
export function cuesToGroups(cues: readonly CaptionCue[]): CaptionGroup[] | { overlap: number } {
  const sorted = [...cues].sort((a, b) => a.start - b.start);
  const groups: CaptionGroup[] = [];
  for (const [index, cue] of sorted.entries()) {
    const next = sorted[index + 1];
    // A cue never runs into the next one (the same clamp captions.mjs applies to its groups).
    const end = next && next.start < cue.end ? next.start : cue.end;
    if (end <= cue.start) return { overlap: index };
    const words = cue.text.split(/\s+/).filter(Boolean);
    const span = (end - cue.start) / words.length;
    groups.push({
      id: `caption-group-${index}`,
      start: round3(cue.start),
      end: round3(end),
      text: words.join(" "),
      words: words.map((text, wordIndex) => ({
        id: `caption-word-${index}-${wordIndex}`,
        text,
        start: round3(cue.start + span * wordIndex),
        end: round3(cue.start + span * (wordIndex + 1)),
      })),
    });
  }
  return groups;
}

function fillOnce(source: string, pattern: RegExp, replacement: string, label: string): string {
  const found = source.match(pattern)?.length ?? 0;
  if (found !== 1)
    throw new Error(`caption-skin.html: expected exactly one ${label}, found ${found}`);
  return source.replace(pattern, () => replacement);
}

/**
 * The frame-preset caption skin with its reserved holes filled: the same contract `buildFromSkin` in the
 * faceless-explainer skill fills (groups, duration, canvas size), wrapped in a `<template>` composition.
 * The brand-token hole stays empty, so the skin's own literal fallbacks apply.
 */
export function buildCaptionsComposition(input: {
  skin: string;
  groups: CaptionGroup[];
  duration: number;
  width: number;
  height: number;
}): string {
  let out = input.skin;
  // A skin's authoring comment can contain tag-like text ("<template>") that the linter mistakes for the
  // root element; strip until stable so removing one comment cannot re-form another marker.
  for (let previous = ""; previous !== out; ) {
    previous = out;
    out = out.replace(/<!--[\s\S]*?-->/g, "");
  }
  const total = round3(input.duration);
  out = fillOnce(
    out,
    /var GROUPS = \[\];/,
    `var GROUPS = ${JSON.stringify(input.groups).replace(/</g, "\\u003c")};`,
    "`var GROUPS = [];` hole",
  );
  out = fillOnce(out, /var DURATION = 0;/, `var DURATION = ${total};`, "`var DURATION = 0;` hole");
  out = fillOnce(out, /data-duration="0"/, `data-duration="${total}"`, '`data-duration="0"` hole');
  out = fillOnce(out, /data-width="0"/, `data-width="${input.width}"`, '`data-width="0"` hole');
  out = fillOnce(out, /data-height="0"/, `data-height="${input.height}"`, '`data-height="0"` hole');
  out += "\n<style>\n  .caption-line { line-height: 1.1 !important; }\n</style>";
  return `<template id="captions-template" data-composition-id="captions" data-width="${input.width}" data-height="${input.height}">\n${out.trim()}\n</template>\n`;
}

/** FRAME.md's front matter block as `key: value` pairs (folded `>` values joined), plus the body after it. */
function readFrameDoc(text: string): { meta: Map<string, string>; body: string } {
  const meta = new Map<string, string>();
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
  if (!match) return { meta, body: text };
  let key: string | null = null;
  for (const line of (match[1] ?? "").split(/\r?\n/)) {
    const top = /^([A-Za-z][\w-]*):\s*(.*)$/.exec(line);
    if (top) {
      key = top[1] ?? null;
      const value = (top[2] ?? "").trim();
      if (key) meta.set(key, value === ">" || value === "|" ? "" : value);
    } else if (key && /^\s+\S/.test(line)) {
      meta.set(key, `${meta.get(key) ?? ""} ${line.trim()}`.trim());
    }
  }
  return { meta, body: text.slice(match[0].length) };
}

function firstSentence(text: string, max: number): string {
  const sentence = /^.*?[.!?](?:\s|$)/.exec(text)?.[0].trim() ?? text;
  return sentence.length > max ? `${sentence.slice(0, max - 1).trimEnd()}…` : sentence;
}

/** The caption presets: one folder per skin, titled from its FRAME.md. */
export function listCaptionPresets(skinsDir: string): PresetInfo[] {
  let names: string[];
  try {
    names = readdirSync(skinsDir).sort();
  } catch {
    return [];
  }
  const presets: PresetInfo[] = [];
  for (const name of names) {
    const dir = join(skinsDir, name);
    if (!PRESET_NAME_RE.test(name) || !statSync(dir).isDirectory()) continue;
    if (!existsSync(join(dir, CAPTION_SKIN_FILE))) continue;
    let title = name;
    let description = "";
    try {
      const { meta, body } = readFrameDoc(readFileSync(join(dir, "FRAME.md"), "utf-8"));
      title = /^#\s+(.+)$/m.exec(body)?.[1]?.trim() ?? meta.get("name") ?? name;
      description = firstSentence(meta.get("description") ?? "", 200);
    } catch {
      // A skin without a readable FRAME.md is still a usable preset, titled by its folder.
    }
    presets.push({ name, kind: "caption", title, description, tags: [], duration: null });
  }
  return presets;
}
