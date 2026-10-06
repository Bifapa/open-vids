import { HF_AUDIO_GROUP_ATTR, HF_AUDIO_GROUP_TAG } from "@hyperframes/core/audio-groups";
import { VOICE_LINE_ATTRIBUTE, VOICEOVER_AUDIO_GROUP } from "@hyperframes/agent-protocol";
import { readScript, selectedTake } from "../voice/project/takesStore.js";
import { EditFailure } from "./errors.js";

/** What `add_clip.voiceLine` places: the line's selected take. */
export interface VoiceLinePlacement {
  lineId: string;
  /** Project-relative audio file. */
  file: string;
  start: number;
  end: number;
}

/** The selected take of a voice line; a line the script does not have, or one without a take, is an edit error. */
export function resolveVoiceLine(projectDir: string, lineId: string): VoiceLinePlacement {
  const line = readScript(projectDir).lines.find((entry) => entry.id === lineId);
  if (!line) {
    throw new EditFailure(
      "unknown_asset",
      `There is no voice line "${lineId}" in this project's voiceover script`,
    );
  }
  const take = selectedTake(line);
  if (!take) {
    throw new EditFailure(
      "unknown_asset",
      `Voice line "${lineId}" has no generated take yet: generate the voiceover first`,
    );
  }
  return { lineId, file: take.file, start: take.start, end: take.end };
}

/** The attributes a voiceover clip carries: the line it speaks and its audio group. */
export function voiceClipAttributes(lineId: string): Record<string, string> {
  return { [VOICE_LINE_ATTRIBUTE]: lineId, [HF_AUDIO_GROUP_ATTR]: VOICEOVER_AUDIO_GROUP };
}

const GROUP_ELEMENT = new RegExp(
  `<\\s*${HF_AUDIO_GROUP_TAG}\\b[^>]*\\bid="${VOICEOVER_AUDIO_GROUP}"`,
  "i",
);
const OTHER_ELEMENT = new RegExp(`\\bid="${VOICEOVER_AUDIO_GROUP}"`, "i");

/**
 * The composition with its `<hf-audio-group id="voiceover" data-label="Voiceover">` bus: appended before `</body>`
 * (or at the end of a fragment) as Studio does when it creates a group, left alone when the composition has one.
 */
export function withVoiceoverGroup(html: string): string {
  if (GROUP_ELEMENT.test(html)) return html;
  if (OTHER_ELEMENT.test(html)) {
    // The group id belongs to an unrelated element: writing the bus would aim every group write at it.
    throw new EditFailure(
      "conflict",
      `The id "${VOICEOVER_AUDIO_GROUP}" is already used by another element of this composition`,
    );
  }
  const tag = `<${HF_AUDIO_GROUP_TAG} id="${VOICEOVER_AUDIO_GROUP}" data-label="Voiceover"></${HF_AUDIO_GROUP_TAG}>`;
  const closeBody = html.lastIndexOf("</body>");
  if (closeBody < 0) return `${html}\n${tag}\n`;
  return `${html.slice(0, closeBody)}  ${tag}\n  ${html.slice(closeBody)}`;
}
