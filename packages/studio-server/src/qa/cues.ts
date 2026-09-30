import { existsSync, readFileSync } from "node:fs";
import type { CaptionCue, TimelineClip } from "@hyperframes/agent-protocol";
import { CAPTIONS_FILE } from "../editing/captions.js";
import { resolveWithinProject } from "../helpers/safePath.js";
import { isCaptionsHost } from "./timelineModel.js";

const MARKER = "var GROUPS = ";

/** The JSON array that starts at `from`, found by bracket matching (strings may contain brackets). */
function arrayAt(text: string, from: number): string | null {
  let depth = 0;
  let inString = false;
  for (let index = from; index < text.length; index += 1) {
    const char = text[index];
    if (inString) {
      if (char === "\\") index += 1;
      else if (char === '"') inString = false;
    } else if (char === '"') inString = true;
    else if (char === "[") depth += 1;
    else if (char === "]" && --depth === 0) return text.slice(from, index + 1);
  }
  return null;
}

/**
 * The caption text and timing the captions composition plays (`var GROUPS = [...]`, written by the editing service),
 * shifted by the start of the clip that hosts it. Empty when the project has no captions or the file is not one the
 * editing service wrote.
 */
export function readCaptionCues(projectDir: string, clips: readonly TimelineClip[]): CaptionCue[] {
  const host = clips.find(isCaptionsHost);
  const file = host ? resolveWithinProject(projectDir, CAPTIONS_FILE) : null;
  if (!host || !file || !existsSync(file)) return [];
  const source = readFileSync(file, "utf-8");
  const at = source.indexOf(MARKER);
  const json = at < 0 ? null : arrayAt(source, at + MARKER.length);
  if (json === null) return [];
  let groups: unknown;
  try {
    groups = JSON.parse(json);
  } catch {
    return [];
  }
  if (!Array.isArray(groups)) return [];
  const cues: CaptionCue[] = [];
  for (const group of groups) {
    const text: unknown =
      typeof group === "object" && group !== null ? Reflect.get(group, "text") : null;
    const start: unknown =
      typeof group === "object" && group !== null ? Reflect.get(group, "start") : null;
    const end: unknown =
      typeof group === "object" && group !== null ? Reflect.get(group, "end") : null;
    if (
      typeof text === "string" &&
      typeof start === "number" &&
      typeof end === "number" &&
      Number.isFinite(start) &&
      Number.isFinite(end) &&
      end > start
    ) {
      cues.push({ text, start: start + host.start, end: end + host.start });
    }
  }
  return cues;
}
