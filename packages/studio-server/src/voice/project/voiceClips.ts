import { readFileSync } from "node:fs";
import { join } from "node:path";
import { VOICE_LINE_ATTRIBUTE } from "@hyperframes/agent-protocol";
import { parseComposition } from "../../editing/timeline.js";
import { isInHiddenOrVendorDir, walkDir } from "../../helpers/safePath.js";

/**
 * The timeline clips that speak a voice line: `data-ov-voice-line` on a clip of any composition of the project. The
 * compositions are parsed the way the editing service parses them, so a clip id is the one `edit_timeline` uses.
 */
export function voiceClipsByLine(projectDir: string): Map<string, string[]> {
  const byLine = new Map<string, string[]>();
  for (const file of walkDir(projectDir)) {
    if (!file.endsWith(".html") || isInHiddenOrVendorDir(file) || file.startsWith("renders/"))
      continue;
    let html: string;
    try {
      html = readFileSync(join(projectDir, file), "utf-8");
    } catch {
      continue;
    }
    if (!html.includes(VOICE_LINE_ATTRIBUTE)) continue;
    const model = parseComposition(html, file);
    if (!model) continue;
    for (const clip of model.clips) {
      const lineId = clip.element.getAttribute(VOICE_LINE_ATTRIBUTE);
      const clipId = clip.id || clip.domId;
      if (!lineId || !clipId) continue;
      byLine.set(lineId, [...(byLine.get(lineId) ?? []), clipId]);
    }
  }
  return byLine;
}
