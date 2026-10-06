import type { ProjectPart } from "@hyperframes/agent-protocol";
import { formatList, t, type TranslationKey } from "../i18n";

/** A part as a checklist row names it ("Renders"). */
export const PART_ROW_NAMES: Record<ProjectPart, TranslationKey> = {
  renders: "chat.project.part.renders",
  music: "chat.project.part.music",
  audio: "chat.project.part.audio",
  images: "chat.project.part.images",
  video: "chat.project.part.video",
  story: "chat.project.part.story",
  all: "chat.project.part.all",
};

/** A part inside a chip ("renders"), where it follows the project's name. */
const PART_CHIP_NAMES: Record<ProjectPart, TranslationKey> = {
  renders: "chat.project.chipPart.renders",
  music: "chat.project.chipPart.music",
  audio: "chat.project.chipPart.audio",
  images: "chat.project.chipPart.images",
  video: "chat.project.chipPart.video",
  story: "chat.project.chipPart.story",
  all: "chat.project.chipPart.all",
};

/** What a project chip says, in the user's language: `Promo · renders, music`. */
export function projectChipLabel(name: string, parts: readonly ProjectPart[]): string {
  return t("chat.project.chip", {
    name,
    parts: formatList(
      parts.map((part) => t(PART_CHIP_NAMES[part])),
      "conjunction",
      "narrow",
    ),
  });
}
