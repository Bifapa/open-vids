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

/**
 * A node kind's identity in the prototype's clip-kind hues: video → `k-video`, picture → `k-image`, music →
 * `k-audio`, motion → `k-motion`. Hues mark identity only; selection is always the accent.
 */
export interface StoryKindStyle {
  label: string;
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
    label: "Chapter",
    icon: FlagBanner,
    kindClass: "hf-k-chapter",
    chip: "border border-border-strong bg-surface-3 text-fg",
    body: "bg-surface-1",
    stroke: "var(--color-fg-3)",
  },
  video: {
    label: "Video",
    icon: FilmStrip,
    kindClass: "hf-k-video",
    chip: "border border-k-video-l bg-k-video-h text-clip-ink",
    body: "bg-k-video-b",
    stroke: "var(--color-k-video-l)",
  },
  picture: {
    label: "Picture",
    icon: Image,
    kindClass: "hf-k-image",
    chip: "border border-k-image-l bg-k-image-h text-clip-ink",
    body: "bg-k-image-b",
    stroke: "var(--color-k-image-l)",
  },
  music: {
    label: "Music",
    icon: MusicNotes,
    kindClass: "hf-k-audio",
    chip: "border border-k-audio-l bg-k-audio-h text-clip-ink",
    body: "bg-k-audio-b",
    stroke: "var(--color-k-audio-l)",
  },
  motion: {
    label: "Motion Graphics",
    icon: Shapes,
    kindClass: "hf-k-motion",
    chip: "border border-k-motion-l bg-k-motion-h text-clip-ink",
    body: "bg-k-motion-b",
    stroke: "var(--color-k-motion-l)",
  },
  missing: {
    label: "Missing Asset",
    icon: WarningCircle,
    kindClass: "hf-k-missing",
    chip: "border border-dashed border-border-strong bg-transparent text-warning",
    body: "bg-transparent",
    stroke: "var(--color-fg-disabled)",
  },
};

/** What a material plays as in its chapters: the bold first word of a card's meta line. */
export function materialRole(node: StoryNode): string {
  switch (node.kind) {
    case "chapter":
      return "Chapter";
    case "video":
      return "B-roll";
    case "picture":
      return "Picture";
    case "music":
      return isSoundEffect(node) ? "SFX" : "Music";
    case "motion":
      return "Motion preset";
    case "missing":
      return "Missing";
  }
}

export const NARRATIVE_ROLE_LABELS: Record<StoryNarrativeRole, string> = {
  hook: "Hook",
  intro: "Intro",
  setup: "Setup",
  main: "Main",
  example: "Example",
  story: "Story",
  interview: "Interview",
  climax: "Climax",
  transition: "Transition",
  recap: "Recap",
  outro: "Outro",
  call_to_action: "Call to action",
};

export const CHAPTER_STATUS_LABELS: Record<ChapterStatus, string> = {
  proposed: "Proposed",
  approved: "Approved",
  needs_material: "Needs material",
};

export const PLACEMENT_LABELS: Record<AttachmentPlacement, string> = {
  start: "At the start",
  middle: "In the middle",
  end: "At the end",
  throughout: "Throughout",
};

export const MISSING_KIND_LABELS: Record<MissingMediaKind, string> = {
  video: "Video",
  picture: "Picture",
  music: "Music",
  sfx: "Sound effect",
  graphics: "Graphics",
};

/** Human names of content fields, for "Set by you" chips. */
export const FIELD_LABELS: Record<string, string> = {
  title: "Title",
  purpose: "Purpose",
  description: "Description",
  narrativeRole: "Role",
  estimatedDuration: "Duration",
  status: "Status",
  sourceRanges: "A-roll ranges",
  aRoll: "A-roll",
  bRoll: "B-roll",
  captions: "Captions",
  graphics: "Graphics",
  audio: "Audio",
  previewFrame: "Preview frame",
  asset: "Asset",
  sourceIn: "In",
  sourceOut: "Out",
  usageIntent: "Usage",
  bpm: "BPM",
  volume: "Volume",
  preset: "Preset",
  skill: "Skill",
  inputs: "Inputs",
  duration: "Duration",
  mediaKind: "Media kind",
  need: "Need",
  neededDuration: "Needed length",
};
