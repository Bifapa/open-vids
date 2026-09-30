import {
  BookOpen,
  FilmStrip,
  Image,
  MusicNotes,
  Sparkle,
  WarningCircle,
  type Icon,
} from "@phosphor-icons/react";
import type {
  AttachmentPlacement,
  ChapterStatus,
  MissingMediaKind,
  StoryNarrativeRole,
  StoryNodeKind,
} from "@hyperframes/agent-protocol";

export interface StoryKindStyle {
  label: string;
  icon: Icon;
  /** Icon/text colour. */
  text: string;
  /** Soft tint behind the kind's icon. */
  tint: string;
  /** Card accent edge. */
  border: string;
  /** Stroke of the kind's attachment edges (a CSS value; SVG styles take variables). */
  stroke: string;
}

export const STORY_KIND_STYLES: Record<StoryNodeKind, StoryKindStyle> = {
  chapter: {
    label: "Chapter",
    icon: BookOpen,
    text: "text-accent",
    tint: "bg-accent/15",
    border: "border-t-accent",
    stroke: "var(--color-accent)",
  },
  video: {
    label: "Video",
    icon: FilmStrip,
    text: "text-media",
    tint: "bg-media/15",
    border: "border-t-media",
    stroke: "var(--color-media)",
  },
  picture: {
    label: "Picture",
    icon: Image,
    text: "text-violet-400",
    tint: "bg-violet-400/15",
    border: "border-t-violet-400",
    stroke: "var(--color-violet-400)",
  },
  music: {
    label: "Music",
    icon: MusicNotes,
    text: "text-pink-400",
    tint: "bg-pink-400/15",
    border: "border-t-pink-400",
    stroke: "var(--color-pink-400)",
  },
  motion: {
    label: "Motion Graphics",
    icon: Sparkle,
    text: "text-container",
    tint: "bg-container/15",
    border: "border-t-container",
    stroke: "var(--color-container)",
  },
  missing: {
    label: "Missing Asset",
    icon: WarningCircle,
    text: "text-danger",
    tint: "bg-danger/15",
    border: "border-t-danger",
    stroke: "var(--color-danger)",
  },
};

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
