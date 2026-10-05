import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  STUDIO_MANUAL_EDITS_PATH,
  createStudioManualEditsRenderBodyScript,
  createStudioPositionSeekReapplyScript,
} from "@hyperframes/studio-server/manual-edits-render-script";

/** Attributes Studio bakes into a composition when an element is dragged, resized, rotated or given motion. */
const POSITION_EDIT_ATTRS = [
  'data-hf-studio-path-offset="true"',
  'data-hf-studio-box-size="true"',
  'data-hf-studio-rotation="true"',
  'data-hf-studio-motion="',
];

function readManualEditsManifest(projectDir: string): string {
  const path = join(projectDir, STUDIO_MANUAL_EDITS_PATH);
  if (!existsSync(path)) return "";
  try {
    return readFileSync(path, "utf-8");
  } catch {
    return "";
  }
}

/**
 * The scripts the render adds so Studio edits survive GSAP's seeks: the position re-apply script when the bundled
 * HTML carries Studio position attributes, and the manual-edits script for the project's manifest. A page built
 * without them shows dragged, rotated or resized elements at their unedited place.
 */
export function studioEditBodyScripts(
  projectDir: string,
  html: string,
  composition: string | undefined,
): string[] {
  const scripts: string[] = [];
  if (POSITION_EDIT_ATTRS.some((attr) => html.includes(attr))) {
    scripts.push(createStudioPositionSeekReapplyScript());
  }
  const manualEdits = createStudioManualEditsRenderBodyScript(readManualEditsManifest(projectDir), {
    activeCompositionPath: composition ?? null,
  });
  if (manualEdits) scripts.push(manualEdits);
  return scripts;
}
