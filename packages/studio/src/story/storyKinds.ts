import {
  FilmStrip,
  FlagBanner,
  Image,
  MusicNotes,
  Shapes,
  WarningCircle,
  type Icon,
} from "@phosphor-icons/react";
import {
  isSoundEffect,
  type AttachmentPlacement,
  type ChapterStatus,
  type MissingMediaKind,
  type StoryNarrativeRole,
  type StoryNode,
  type StoryNodeKind,
} from "@hyperframes/agent-protocol";
import { t, type TranslationKey } from "../i18n";

/**
 * A node kind's identity in the prototype's clip-kind hues: video → `k-video`, picture → `k-image`, music →
 * `k-audio`, motion → `k-motion`. Hues mark identity only; selection is always the accent.
 */
export interface StoryKindStyle {
  labelKey: TranslationKey;
  icon: Icon;
  /** The card's kind class in story.css (`--hf-kh/kb/kl`: header, body, edge hue). */
  kindClass: string;
  /** Type chip: the kind's header hue with clip ink (lists, inspector head, menus). */
  chip: string;
  /** Fill behind a missing thumbnail. */
  body: string;
  /** The kind's edge hue as a CSS value (minimap). */
  stroke: string;
}

export const STORY_KIND_STYLES: Record<StoryNodeKind, StoryKindStyle> = {
  chapter: {
    labelKey: "story.kind.chapter",
    icon: FlagBanner,
    kindClass: "hf-k-chapter",
    chip: "border border-border-strong bg-surface-3 text-fg",
    body: "bg-surface-1",
    stroke: "var(--color-fg-3)",
  },
  video: {
    labelKey: "story.kind.video",
    icon: FilmStrip,
    kindClass: "hf-k-video",
    chip: "border border-k-video-l bg-k-video-h text-clip-ink",
    body: "bg-k-video-b",
    stroke: "var(--color-k-video-l)",
  },
  picture: {
    labelKey: "story.kind.picture",
    icon: Image,
    kindClass: "hf-k-image",
    chip: "border border-k-image-l bg-k-image-h text-clip-ink",
    body: "bg-k-image-b",
    stroke: "var(--color-k-image-l)",
  },
  music: {
    labelKey: "story.kind.music",
    icon: MusicNotes,
    kindClass: "hf-k-audio",
    chip: "border border-k-audio-l bg-k-audio-h text-clip-ink",
    body: "bg-k-audio-b",
    stroke: "var(--color-k-audio-l)",
  },
  motion: {
    labelKey: "story.kind.motion",
    icon: Shapes,
    kindClass: "hf-k-motion",
    chip: "border border-k-motion-l bg-k-motion-h text-clip-ink",
    body: "bg-k-motion-b",
    stroke: "var(--color-k-motion-l)",
  },
  missing: {
    labelKey: "story.kind.missing",
    icon: WarningCircle,
    kindClass: "hf-k-missing",
    chip: "border border-dashed border-border-strong bg-transparent text-warning",
    body: "bg-transparent",
    stroke: "var(--color-fg-disabled)",
  },
};

/** What a material plays as in its chapters: the bold first word of a card's meta line. */
export function materialRoleKey(node: StoryNode): TranslationKey {
  switch (node.kind) {
    case "chapter":
      return "story.role.chapter";
    case "video":
      return "story.role.video";
    case "picture":
      return "story.role.picture";
    case "music":
      return isSoundEffect(node) ? "story.role.sfx" : "story.role.music";
    case "motion":
      return "story.role.motion";
    case "missing":
      return "story.role.missing";
  }
}

export const NARRATIVE_ROLE_KEYS = {
  hook: "story.narrative.hook",
  intro: "story.narrative.intro",
  setup: "story.narrative.setup",
  main: "story.narrative.main",
  example: "story.narrative.example",
  story: "story.narrative.story",
  interview: "story.narrative.interview",
  climax: "story.narrative.climax",
  transition: "story.narrative.transition",
  recap: "story.narrative.recap",
  outro: "story.narrative.outro",
  call_to_action: "story.narrative.call_to_action",
} as const satisfies Record<StoryNarrativeRole, TranslationKey>;

export const CHAPTER_STATUS_KEYS = {
  proposed: "story.status.proposed",
  approved: "story.status.approved",
  needs_material: "story.status.needs_material",
} as const satisfies Record<ChapterStatus, TranslationKey>;

export const PLACEMENT_KEYS = {
  start: "story.placement.start",
  middle: "story.placement.middle",
  end: "story.placement.end",
  throughout: "story.placement.throughout",
} as const satisfies Record<AttachmentPlacement, TranslationKey>;

export const MISSING_KIND_KEYS = {
  video: "story.missingKind.video",
  picture: "story.missingKind.picture",
  music: "story.missingKind.music",
  sfx: "story.missingKind.sfx",
  graphics: "story.missingKind.graphics",
} as const satisfies Record<MissingMediaKind, TranslationKey>;

/** Human names of content fields, for "Set by you" chips. */
const FIELD_LABEL_KEYS: Readonly<Record<string, TranslationKey>> = {
  title: "story.field.title",
  purpose: "story.field.purpose",
  description: "story.field.description",
  narrativeRole: "story.field.narrativeRole",
  estimatedDuration: "story.field.estimatedDuration",
  status: "story.field.status",
  sourceRanges: "story.field.sourceRanges",
  aRoll: "story.field.aRoll",
  bRoll: "story.field.bRoll",
  captions: "story.field.captions",
  graphics: "story.field.graphics",
  audio: "story.field.audio",
  previewFrame: "story.field.previewFrame",
  asset: "story.field.asset",
  sourceIn: "story.field.sourceIn",
  sourceOut: "story.field.sourceOut",
  usageIntent: "story.field.usageIntent",
  bpm: "story.field.bpm",
  volume: "story.field.volume",
  preset: "story.field.preset",
  skill: "story.field.skill",
  inputs: "story.field.inputs",
  duration: "story.field.duration",
  mediaKind: "story.field.mediaKind",
  need: "story.field.need",
  neededDuration: "story.field.neededDuration",
};

/** The name of a content field as the user reads it; an unknown field keeps its raw name. */
export function fieldLabel(field: string): string {
  const key = FIELD_LABEL_KEYS[field];
  return key ? t(key) : field;
}
