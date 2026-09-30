/**
 * OpenVids Story Mode: the Story Graph contract shared by Studio (the Story workspace), the Studio server's story
 * service (`/api/projects/:id/story/*`) and the agent runtime's story tools.
 *
 * The Story Graph is a durable project artifact (`.hyperframes/story/graph.json`, tracked by project history so a
 * reverted AI turn restores it). It is the plan of the video: Chapter nodes in a narrative sequence, material nodes
 * (video, picture, music, motion graphics, missing asset) attached to chapters. Node ids are stable for the life of
 * the node and never reused. `Build Story` turns the graph into the timeline; built clips carry the chapter's id.
 *
 * Authorship is part of the data: what the user set by hand (`userEdited` fields, user-created nodes/edges/
 * attachments, and the edges/attachments the user removed) outranks the AI's previous plan, and locked nodes are
 * never changed by an agent. The story service enforces both for agent edits.
 */

import type { ManualEditPolicy } from "./types.js";
import { isRecord } from "./validate.js";

export const STORY_GRAPH_SCHEMA = 1;
/** Project-relative location of the graph. Inside `.hyperframes/` (agents cannot hand-edit it) but history-tracked. */
export const STORY_GRAPH_PATH = ".hyperframes/story/graph.json";
/**
 * Project-relative location of the Story ↔ timeline sync ledger: which clips each built section owns and the state
 * they were generated in. Written by Build Story / Rebuild together with the composition, history-tracked like the
 * graph (a reverted turn restores both), never edited by hand.
 */
export const STORY_SYNC_PATH = ".hyperframes/story/sync.json";

// ── Nodes ────────────────────────────────────────────────────────────────────

export const STORY_NODE_KINDS = [
  "chapter",
  "video",
  "picture",
  "music",
  "motion",
  "missing",
] as const;
export type StoryNodeKind = (typeof STORY_NODE_KINDS)[number];

/** Nodes that are attached to chapters (everything but chapters). */
export const STORY_MATERIAL_KINDS = ["video", "picture", "music", "motion", "missing"] as const;
export type StoryMaterialKind = (typeof STORY_MATERIAL_KINDS)[number];

export const STORY_NARRATIVE_ROLES = [
  "hook",
  "intro",
  "setup",
  "main",
  "example",
  "story",
  "interview",
  "climax",
  "transition",
  "recap",
  "outro",
  "call_to_action",
] as const;
export type StoryNarrativeRole = (typeof STORY_NARRATIVE_ROLES)[number];

/** `proposed`: the AI's suggestion; `approved`: the user accepted it; `needs_material`: waits for missing material. */
export const CHAPTER_STATUSES = ["proposed", "approved", "needs_material"] as const;
export type ChapterStatus = (typeof CHAPTER_STATUSES)[number];

export const MISSING_MEDIA_KINDS = ["video", "picture", "music", "sfx", "graphics"] as const;
export type MissingMediaKind = (typeof MISSING_MEDIA_KINDS)[number];

export type StoryAuthor = "ai" | "user";

export interface StoryPoint {
  x: number;
  y: number;
}

/** A range of a source file (seconds of the SOURCE, not of the timeline). */
export interface StorySourceRange {
  /** Project-relative media path. */
  source: string;
  from: number;
  to: number;
  /** Analysis segment the range came from, when it came from one. */
  segment: string | null;
}

/** The frame a card shows: a time in a source file. */
export interface StoryFrameRef {
  source: string;
  time: number;
}

interface StoryNodeBase {
  /** Stable for the node's whole life, never reused. */
  id: string;
  title: string;
  /** Canvas position; purely visual (never an authored decision). */
  position: StoryPoint;
  /** Locked nodes are never changed by an agent (their attachments neither). */
  locked: boolean;
  createdBy: StoryAuthor;
  /** Content fields the user set by hand; agents keep them. See {@link STORY_CONTENT_FIELDS}. */
  userEdited: string[];
}

export interface ChapterNode extends StoryNodeBase {
  kind: "chapter";
  purpose: string;
  description: string;
  narrativeRole: StoryNarrativeRole;
  /** Intended length on the timeline, seconds. */
  estimatedDuration: number;
  status: ChapterStatus;
  /** The A-roll material, played in this order. */
  sourceRanges: StorySourceRange[];
  /** A-roll intent (who/what carries the chapter). */
  aRoll: string;
  /** B-roll intent; concrete B-roll clips are attached video/picture nodes. */
  bRoll: string;
  /** Word-synced captions from the transcript for this chapter. */
  captions: boolean;
  /** Graphics intent; concrete graphics are attached motion nodes. */
  graphics: string;
  /** Audio intent; concrete music is an attached music node. */
  audio: string;
  previewFrame: StoryFrameRef | null;
}

/**
 * The Missing Asset node a material node replaced when it was resolved (Research imported the material, or an agent
 * resolved it with a project asset). The Missing Asset node itself is gone; its attachments now point here.
 */
export interface MissingResolution {
  /** Id of the Missing Asset node (never reused). */
  missing: string;
  mediaKind: MissingMediaKind;
  /** What was needed, as the Missing Asset node said. */
  need: string;
  at: number;
  /** Agent turn that resolved it; null when the user did. */
  turnId: string | null;
}

export interface VideoNode extends StoryNodeBase {
  kind: "video";
  /** Project-relative video path. */
  asset: string;
  /** Source in-point, seconds. */
  sourceIn: number;
  /** Source out-point; null = to the end of the file. */
  sourceOut: number | null;
  usageIntent: string;
  previewFrame: StoryFrameRef | null;
  /** Set when this node resolved a Missing Asset node. */
  resolvedFrom?: MissingResolution;
}

export interface PictureNode extends StoryNodeBase {
  kind: "picture";
  /** Project-relative image path. */
  asset: string;
  usageIntent: string;
  /** Set when this node resolved a Missing Asset node. */
  resolvedFrom?: MissingResolution;
}

export interface MusicNode extends StoryNodeBase {
  kind: "music";
  /** Project-relative audio path; null = only an intended choice so far. */
  asset: string | null;
  bpm: number | null;
  /** Gain under speech (0–1). */
  volume: number;
  usageIntent: string;
  /** Set when this node resolved a Missing Asset node. */
  resolvedFrom?: MissingResolution;
}

export interface MotionNode extends StoryNodeBase {
  kind: "motion";
  /** Registry block/component name (see browse_presets / `editing/presets`). */
  preset: string;
  /** Skill the preset comes from, when known (e.g. `motion-graphics`). */
  skill: string | null;
  /** Preset inputs as the user/agent wants them shown (e.g. `{ "M3": "100", "M4": "167" }`). */
  inputs: Record<string, string>;
  /** Length on the timeline; null = the preset's natural length. */
  duration: number | null;
  usageIntent: string;
}

export interface MissingAssetNode extends StoryNodeBase {
  kind: "missing";
  mediaKind: MissingMediaKind;
  /** What is needed: "Close-up of MacBook keyboard, shallow depth of field". */
  need: string;
  neededDuration: number | null;
}

export type StoryNode =
  | ChapterNode
  | VideoNode
  | PictureNode
  | MusicNode
  | MotionNode
  | MissingAssetNode;

export type StoryMaterialNode = Exclude<StoryNode, ChapterNode>;

/** The authored content fields of each node kind: what `userEdited` and agent `update_node` refer to. */
export const STORY_CONTENT_FIELDS = {
  chapter: [
    "title",
    "purpose",
    "description",
    "narrativeRole",
    "estimatedDuration",
    "status",
    "sourceRanges",
    "aRoll",
    "bRoll",
    "captions",
    "graphics",
    "audio",
    "previewFrame",
  ],
  video: ["title", "asset", "sourceIn", "sourceOut", "usageIntent", "previewFrame"],
  picture: ["title", "asset", "usageIntent"],
  music: ["title", "asset", "bpm", "volume", "usageIntent"],
  motion: ["title", "preset", "skill", "inputs", "duration", "usageIntent"],
  missing: ["title", "mediaKind", "need", "neededDuration"],
} as const satisfies Record<StoryNodeKind, readonly string[]>;

export type StoryContentField<K extends StoryNodeKind> = (typeof STORY_CONTENT_FIELDS)[K][number];

export function isChapter(node: StoryNode): node is ChapterNode {
  return node.kind === "chapter";
}

export function isMaterial(node: StoryNode): node is StoryMaterialNode {
  return node.kind !== "chapter";
}

// ── Edges and attachments ────────────────────────────────────────────────────

/**
 * A narrative (semantic) edge: `from` plays right before `to`. Only between chapters; each chapter has at most one
 * outgoing and one incoming sequence edge, and there are no cycles.
 */
export interface StoryEdge {
  id: string;
  kind: "sequence";
  from: string;
  to: string;
  /** How the story moves on: "match cut on the keyboard", "music rise". */
  transition: string;
  createdBy: StoryAuthor;
}

export const ATTACHMENT_PLACEMENTS = ["start", "middle", "end", "throughout"] as const;
export type AttachmentPlacement = (typeof ATTACHMENT_PLACEMENTS)[number];

/**
 * Material/intent relationship (kept apart from narrative edges): material `node` is to be used in `chapter`.
 * A music node attached to several chapters plays across all of them.
 */
export interface StoryAttachment {
  id: string;
  node: string;
  chapter: string;
  placement: AttachmentPlacement;
  /** Seconds from the chapter's start; overrides `placement` when set. */
  offset: number | null;
  /** Seconds on the timeline; null = the material's own/default length. */
  duration: number | null;
  createdBy: StoryAuthor;
}

/** What the user removed from the AI's plan; an agent must not put it back. */
export type StoryRemoval =
  | { kind: "edge"; from: string; to: string }
  | { kind: "attachment"; node: string; chapter: string };

// ── Graph ────────────────────────────────────────────────────────────────────

export interface StorySettings {
  /** Composition the story builds into; null = the project's main composition. */
  composition: string | null;
  /** Caption preset for chapters with captions; null = the first bundled caption preset. */
  captionPreset: string | null;
}

export interface StoryReviewRecord {
  at: number;
  turnId: string | null;
  summary: string;
}

export interface StoryBuiltChapter {
  node: string;
  start: number;
  end: number;
  clips: number;
}

export interface StoryBuildRecord {
  at: number;
  turnId: string | null;
  composition: string;
  /** Timeline version right after the build. */
  version: string;
  duration: number;
  chapters: StoryBuiltChapter[];
  warnings: string[];
}

export interface StoryGraph {
  schema: typeof STORY_GRAPH_SCHEMA;
  /** Stable id of the story. */
  id: string;
  title: string;
  /** The user's goal for the video, in their words. */
  brief: string;
  settings: StorySettings;
  nodes: StoryNode[];
  edges: StoryEdge[];
  attachments: StoryAttachment[];
  removedByUser: StoryRemoval[];
  review: StoryReviewRecord | null;
  build: StoryBuildRecord | null;
  updatedAt: number;
  updatedBy: StoryAuthor;
}

// ── Order ────────────────────────────────────────────────────────────────────

export interface StoryOrder {
  /** Every chapter in play order. */
  chapters: string[];
  /** Human-readable notes about the order (unconnected chapters, several chains). */
  notes: string[];
}

/**
 * Play order of the chapters: sequence chains in order of their first chapter's canvas position (left to right,
 * then top to bottom); a chapter without edges is a chain of its own. Assumes a graph that passed
 * {@link validateStoryGraph} (≤ 1 in, ≤ 1 out, no cycles); anything unreachable is appended by position.
 */
export function storyOrder(graph: Pick<StoryGraph, "nodes" | "edges">): StoryOrder {
  const chapters = graph.nodes.filter(isChapter);
  const byId = new Map(chapters.map((chapter) => [chapter.id, chapter]));
  const next = new Map<string, string>();
  const hasIncoming = new Set<string>();
  for (const edge of graph.edges) {
    if (edge.kind !== "sequence" || !byId.has(edge.from) || !byId.has(edge.to)) continue;
    if (!next.has(edge.from)) next.set(edge.from, edge.to);
    hasIncoming.add(edge.to);
  }
  const byPosition = (a: ChapterNode, b: ChapterNode) =>
    a.position.x - b.position.x || a.position.y - b.position.y || a.id.localeCompare(b.id);
  const heads = chapters.filter((chapter) => !hasIncoming.has(chapter.id)).sort(byPosition);
  const order: string[] = [];
  const seen = new Set<string>();
  const notes: string[] = [];
  const walk = (start: string) => {
    let current: string | undefined = start;
    while (current !== undefined && !seen.has(current)) {
      seen.add(current);
      order.push(current);
      current = next.get(current);
    }
  };
  for (const head of heads) walk(head.id);
  const rest = chapters.filter((chapter) => !seen.has(chapter.id)).sort(byPosition);
  for (const chapter of rest) walk(chapter.id);
  const chains = heads.length + (rest.length > 0 ? 1 : 0);
  const loose = chapters.filter(
    (chapter) => !next.has(chapter.id) && !hasIncoming.has(chapter.id) && chapters.length > 1,
  );
  if (loose.length > 0) {
    notes.push(
      `${loose.map((chapter) => `"${chapter.title}"`).join(", ")} ${loose.length === 1 ? "is" : "are"} not connected; placed by canvas position.`,
    );
  }
  if (chains - loose.length > 1) {
    notes.push("The story has several separate sequences; they play left to right.");
  }
  return { chapters: order, notes };
}

// ── API: reads ───────────────────────────────────────────────────────────────

/** What the service knows about one node beyond the graph itself. */
export interface StoryNodeFacts {
  /** Chapters: length of the A-roll once pauses, fillers and bad takes are cut (null: source not analyzed). */
  materialDuration?: number | null;
  /** Clips on the timeline that carry this node's id (built by Build Story), or null when none. */
  timeline: { clips: number; start: number; end: number } | null;
}

/** `GET /api/projects/:id/story`. */
export interface StoryView {
  /** Null until a story exists. */
  graph: StoryGraph | null;
  /** Content version of the graph file (`sha256:<hex>`); pass it back as `baseVersion`. */
  version: string | null;
  order: StoryOrder;
  facts: Record<string, StoryNodeFacts>;
  /** The composition the story builds into. */
  composition: string | null;
  /** How the timeline relates to the graph since the last build (null when there is no graph). */
  sync: StorySyncReport | null;
}

// ── Story ↔ timeline synchronization ─────────────────────────────────────────

/**
 * What a built unit is: a chapter's A-roll, the clip of one attached material (B-roll video, picture, motion
 * graphic, sound effect), a music bed (spanning the chapters it is attached to), or the story's captions.
 */
export const STORY_SYNC_ROLES = [
  "a_roll",
  "b_roll",
  "picture",
  "motion",
  "sfx",
  "music",
  "captions",
] as const;
export type StorySyncRole = (typeof STORY_SYNC_ROLES)[number];

/**
 * A music node that resolved a Missing Asset node of kind `sfx` is a sound effect: placed inside each chapter it is
 * attached to (placement, offset, duration) like a picture, instead of a bed spanning the chapters.
 */
export function isSoundEffect(node: StoryNode): boolean {
  return node.kind === "music" && node.resolvedFrom?.mediaKind === "sfx";
}

/** How the graph's intent for a unit/section compares with what was built. */
export const STORY_SYNC_CHANGES = ["unchanged", "changed", "added", "removed"] as const;
export type StorySyncChange = (typeof STORY_SYNC_CHANGES)[number];

/**
 * What a rebuild does with a unit: `keep` (stays as it is), `shift` (moves with its section, content untouched),
 * `rebuild` (regenerated), `add` (built for the first time), `remove` (taken off the timeline), `keep_edited` (the
 * story changed it but it holds manual edits and the policy keeps them), `keep_locked` (a locked node, frozen),
 * `skip` (outside the chapters the rebuild was asked for).
 */
export const STORY_SYNC_ACTIONS = [
  "keep",
  "shift",
  "rebuild",
  "add",
  "remove",
  "keep_edited",
  "keep_locked",
  "skip",
] as const;
export type StorySyncAction = (typeof STORY_SYNC_ACTIONS)[number];

/**
 * Who changed a generated clip after it was built: the user (Studio), a later AI turn (stamped by the editing
 * service), or unknown (a clip that is gone — removal leaves no trace to attribute).
 */
export type StoryEditAuthor = "user" | "ai" | "unknown";

/** One manual change to generated material, found by comparing the clip's structured state with its build record. */
export interface StoryManualEdit {
  /** The clip (for `removed`: the id it had). */
  clip: string;
  label: string;
  /** `modified`: its properties changed; `removed`: it is gone; `added`: a copy/split of generated material. */
  kind: "modified" | "removed" | "added";
  by: StoryEditAuthor;
  /** For `ai`: the turn that made the edit. */
  turn: string | null;
  /** `modified`: what changed (start, duration, track, mediaStart, volume, muted, frame, fit, fades, zIndex, locked, …). */
  fields: string[];
}

export interface StorySyncUnit {
  /** The story node the unit is built for (the chapter itself for its A-roll). */
  node: string;
  role: StorySyncRole;
  title: string;
  change: StorySyncChange;
  /** Why it changed, in words ("source ranges changed", "placement start → end", …). */
  reasons: string[];
  /** What a rebuild with the given (or default) options does with it. */
  action: StorySyncAction;
  /** Clips it owns on the timeline now. */
  clips: number;
  edits: StoryManualEdit[];
}

export interface StorySyncSection {
  chapter: string;
  title: string;
  /** Content change of the section (any unit changed → changed). */
  change: StorySyncChange;
  /** A rebuild moves the section on the timeline (new order, or an earlier section changes length). */
  moved: boolean;
  locked: boolean;
  reasons: string[];
  /** Where it is now / where a rebuild puts it (null: not on the timeline / removed). */
  current: { start: number; end: number } | null;
  next: { start: number; end: number } | null;
  units: StorySyncUnit[];
}

/** A clip no story section owns (manual additions, cutaways, other agents' work) and how a rebuild treats it. */
export interface StoryUnrelatedClip {
  clip: string;
  label: string;
  track: number;
  start: number;
  end: number;
  /** `ai`: created by an agent turn (its `data-ov-turn`); otherwise the user's. */
  by: "user" | "ai";
  turn: string | null;
  /** The chapter whose section it sits in (it moves with that section), null before/after the story. */
  anchor: string | null;
  /** How far a rebuild moves it (0 = stays). */
  shift: number;
}

/**
 * The Story ↔ timeline impact: for every chapter section and music/caption unit, whether the graph still matches
 * what was built, which generated clips were edited afterwards, and what a rebuild would do. `not_built`: no sync
 * record and no story clips; `untracked`: story clips without a sync record (built before synchronization existed —
 * only a full Build can take them over); `in_sync`: nothing to rebuild; `out_of_sync`: a rebuild would change the
 * timeline.
 */
export interface StorySyncReport {
  state: "not_built" | "untracked" | "in_sync" | "out_of_sync";
  composition: string | null;
  /** Last build or rebuild. */
  syncedAt: number | null;
  turnId: string | null;
  /** In the graph's play order, then sections of chapters that left the story. */
  sections: StorySyncSection[];
  music: StorySyncUnit[];
  captions: StorySyncUnit | null;
  unrelated: StoryUnrelatedClip[];
  /** Chapters whose section a rebuild regenerates, adds or removes. */
  affected: string[];
  /** Chapters that moved (order or an earlier length) without content changes. */
  moved: string[];
  /** Locked chapters with changes that are only rebuilt with explicit permission. */
  lockedPending: string[];
  /** Every manual edit to generated material, anywhere in the story. */
  manualEdits: number;
  /** Units a rebuild must change that hold manual edits (kept under `keep`, replaced under `replace`). */
  conflicts: number;
  duration: { current: number; next: number };
  warnings: string[];
}

// ── API: user save ───────────────────────────────────────────────────────────

/**
 * `PUT /api/projects/:id/story` — Studio saves the whole graph after a manual edit. The service compares it with the
 * stored graph and records authorship (changed content fields → `userEdited`; new nodes/edges/attachments →
 * `createdBy: "user"`; removed AI edges/attachments → `removedByUser`), so the client never sets those itself.
 */
export interface SaveStoryRequest {
  /** Version the edit was made on; null when creating the first graph. */
  baseVersion: string | null;
  graph: StoryGraph;
}

// ── API: agent edits ─────────────────────────────────────────────────────────

/** A-roll material as an agent names it; the service resolves it to {@link StorySourceRange}s. */
export type StorySourceRangeInput =
  | { source: string; from: number; to: number }
  /** Whole analysis segments (`g3`), in the given order. */
  | { source: string; segments: string[] }
  /** Transcript sentences from `firstSentence` through `lastSentence` (`s12`…`s19`). */
  | { source: string; firstSentence: string; lastSentence: string };

export interface ChapterFieldsInput {
  title?: string;
  purpose?: string;
  description?: string;
  narrativeRole?: StoryNarrativeRole;
  estimatedDuration?: number;
  status?: ChapterStatus;
  sourceRanges?: StorySourceRangeInput[];
  aRoll?: string;
  bRoll?: string;
  captions?: boolean;
  graphics?: string;
  audio?: string;
  previewFrame?: StoryFrameRef | null;
}

export interface VideoFieldsInput {
  title?: string;
  asset?: string;
  sourceIn?: number;
  sourceOut?: number | null;
  usageIntent?: string;
  previewFrame?: StoryFrameRef | null;
}

export interface PictureFieldsInput {
  title?: string;
  asset?: string;
  usageIntent?: string;
}

export interface MusicFieldsInput {
  title?: string;
  asset?: string | null;
  bpm?: number | null;
  volume?: number;
  usageIntent?: string;
}

export interface MotionFieldsInput {
  title?: string;
  preset?: string;
  skill?: string | null;
  inputs?: Record<string, string>;
  duration?: number | null;
  usageIntent?: string;
}

export interface MissingFieldsInput {
  title?: string;
  mediaKind?: MissingMediaKind;
  need?: string;
  neededDuration?: number | null;
}

export type StoryNodeInput =
  | ({ kind: "chapter" } & ChapterFieldsInput)
  | ({ kind: "video" } & VideoFieldsInput)
  | ({ kind: "picture" } & PictureFieldsInput)
  | ({ kind: "music" } & MusicFieldsInput)
  | ({ kind: "motion" } & MotionFieldsInput)
  | ({ kind: "missing" } & MissingFieldsInput);

export type StoryFieldsInput =
  | ChapterFieldsInput
  | VideoFieldsInput
  | PictureFieldsInput
  | MusicFieldsInput
  | MotionFieldsInput
  | MissingFieldsInput;

/**
 * One agent edit. Node ids may be `@ref` for a node added earlier in the same batch (`add_node` with `ref`).
 * Agents never set positions: new nodes are laid out by the service.
 */
export type StoryOperation =
  | { op: "add_node"; ref?: string; node: StoryNodeInput }
  | { op: "update_node"; id: string; set: StoryFieldsInput }
  | { op: "remove_node"; id: string }
  /** Add a sequence edge, or change its transition when it exists. */
  | { op: "connect"; from: string; to: string; transition?: string }
  | { op: "disconnect"; from: string; to: string }
  /** Rewire the sequence so the chapters play in exactly this order (every chapter, once). */
  | { op: "set_order"; chapters: string[] }
  | {
      op: "attach";
      node: string;
      chapter: string;
      placement?: AttachmentPlacement;
      offset?: number | null;
      duration?: number | null;
    }
  | { op: "detach"; node: string; chapter: string }
  | {
      op: "set_story";
      title?: string;
      brief?: string;
      captionPreset?: string | null;
      composition?: string | null;
      /** Records the result of an AI review on the graph. */
      reviewSummary?: string;
    }
  /**
   * Replace a Missing Asset node with a concrete material node for `asset` (a project media file): video → video,
   * picture/graphics → picture (or video for a video file), music/sfx → music. The new node takes over the missing
   * node's attachments (same attachment ids, placement, offset and duration) and records `resolvedFrom`. Refused for
   * a locked Missing Asset node. A user-created Missing Asset node may be resolved: that is what the user asked for.
   */
  | {
      op: "resolve_missing";
      id: string;
      asset: string;
      title?: string;
      usageIntent?: string;
      /** video: source in/out points. */
      sourceIn?: number;
      sourceOut?: number | null;
    };

export type StoryOperationName = StoryOperation["op"];

export const STORY_OPERATION_NAMES = [
  "add_node",
  "update_node",
  "remove_node",
  "connect",
  "disconnect",
  "set_order",
  "attach",
  "detach",
  "set_story",
  "resolve_missing",
] as const satisfies readonly StoryOperationName[];

/** `POST /api/projects/:id/story/edit` — an agent's atomic batch. Creates the graph when none exists. */
export interface StoryEditRequest {
  baseVersion?: string;
  /** The agent turn making the edit (recorded on a review). */
  turnId?: string;
  operations: StoryOperation[];
}

export interface StoryOperationResult {
  op: StoryOperationName;
  /** The node, edge or attachment the operation created or changed. */
  id: string | null;
}

export interface StoryEditResponse {
  view: StoryView;
  results: StoryOperationResult[];
}

// ── API: build ───────────────────────────────────────────────────────────────

/**
 * `POST /api/projects/:id/story/build` — compile the whole graph into the timeline in one atomic edit. Every section
 * is regenerated (manual edits to generated clips are replaced and reported), except the built sections of locked
 * chapters, which stay as they are unless `allowLocked` names them. Clips no section owns are kept (and move with the
 * section they sit in); the raw A-roll of the chapters' sources is replaced only by the first build.
 */
export interface StoryBuildRequest {
  /** Graph version the caller read; refused when the graph changed since. */
  baseVersion?: string;
  /** Agent turn doing the build (stamped on the built clips). */
  turnId?: string;
  /** Compile and report without writing anything. */
  dryRun?: boolean;
  /** Locked chapters the user allows to be rebuilt. */
  allowLocked?: string[];
}

export interface StoryBuiltMaterial {
  node: string;
  chapter: string;
  clipId: string | null;
  start: number;
  end: number;
  track: number;
}

export interface StoryBuildResult {
  dryRun: boolean;
  composition: string;
  /** Timeline version after the build (the current one for a dry run). */
  timelineVersion: string;
  duration: number;
  chapters: Array<StoryBuiltChapter & { title: string; estimatedDuration: number }>;
  materials: StoryBuiltMaterial[];
  /** Clips replaced by the build: earlier story clips (and, on the first build, the raw A-roll of the chapters' sources). */
  removedClips: number;
  /** Clips the build left alone (manual additions, cutaways on other tracks, locked sections). */
  keptClips: number;
  captions: { preset: string; cues: number } | null;
  /** Manual edits to generated clips that the build replaced. */
  replacedEdits: StoryManualEdit[];
  /** Locked chapters whose built section was left as it was. */
  keptLocked: string[];
  warnings: string[];
  view: StoryView;
}

/**
 * `POST /api/projects/:id/story/rebuild` — Rebuild affected sections: compares the graph with the sync ledger and
 * changes only what the graph changed — regenerates the units whose intent changed, adds/removes sections of added/
 * removed chapters, moves sections that only moved (content untouched, manual edits kept), and leaves everything
 * else byte-for-byte alone. One atomic edit, plus the ledger and the graph's build record.
 */
export interface StoryRebuildRequest {
  baseVersion?: string;
  turnId?: string;
  /** Only regenerate these chapters' changed sections (default: every affected one). Order and removals always apply. */
  chapters?: string[];
  /** Generated clips edited after the build in a unit that must change (default `keep`). */
  manualEdits?: ManualEditPolicy;
  /** Locked chapters the user allows to be rebuilt. */
  allowLocked?: string[];
  dryRun?: boolean;
}

export interface StoryRebuildResult {
  dryRun: boolean;
  composition: string;
  timelineVersion: string;
  /**
   * Whether the rebuild changes the timeline (a dry run: would change it). False when it already matches the graph,
   * or when every remaining difference is held back (manual edits kept, locked chapters, chapters outside the scope).
   */
  changed: boolean;
  /** The plan as it was carried out (actions per unit). */
  report: StorySyncReport;
  /** Chapters whose section was regenerated or built for the first time. */
  rebuilt: string[];
  /** Chapters whose section was taken off the timeline. */
  removed: string[];
  /** Chapters whose section only moved. */
  moved: string[];
  /** Manual edits kept although the story changed that unit (policy `keep`, or a clip locked on the timeline). */
  keptEdits: StoryManualEdit[];
  /** Manual edits the rebuild replaced (policy `replace`). */
  replacedEdits: StoryManualEdit[];
  /** Locked chapters with changes that were not rebuilt. */
  keptLocked: string[];
  duration: number;
  warnings: string[];
  view: StoryView;
}

// ── Errors ───────────────────────────────────────────────────────────────────

export const STORY_ERROR_CODES = [
  "invalid_request",
  /** No graph yet (build, or edits that need an existing node). */
  "no_story",
  "unknown_node",
  /** The node is locked: agents cannot change it. */
  "locked",
  /** The change would undo a decision the user made by hand. */
  "user_decision",
  /** The graph (or the timeline) changed since `baseVersion`. */
  "conflict",
  "unknown_asset",
  "unknown_preset",
  "not_analyzed",
  "unsupported",
] as const;
export type StoryErrorCode = (typeof STORY_ERROR_CODES)[number];

export interface StoryError {
  code: StoryErrorCode;
  message: string;
  /** Index of the failing operation in an edit batch. */
  opIndex?: number;
}

export function isStoryError(value: unknown): value is StoryError {
  return (
    isRecord(value) &&
    typeof value.message === "string" &&
    STORY_ERROR_CODES.some((code) => code === value.code)
  );
}

// ── Limits and validation ────────────────────────────────────────────────────

export const STORY_LIMITS = {
  nodes: 300,
  edges: 600,
  attachments: 600,
  removals: 600,
  operations: 100,
  sourceRanges: 200,
  idChars: 64,
  titleChars: 120,
  textChars: 2_000,
  pathChars: 1_024,
  inputs: 24,
  inputChars: 200,
  maxTime: 24 * 60 * 60,
  maxCoordinate: 1_000_000,
} as const;

export type ParsedStory<T> = { ok: true; value: T } | { ok: false; error: StoryError };

class Invalid extends Error {
  constructor(
    message: string,
    readonly opIndex?: number,
  ) {
    super(message);
  }
}

function fail(message: string): never {
  throw new Invalid(message);
}

function parse<T>(read: () => T): ParsedStory<T> {
  try {
    return { ok: true, value: read() };
  } catch (error) {
    if (error instanceof Invalid) {
      return {
        ok: false,
        error: {
          code: "invalid_request",
          message: error.message,
          ...(error.opIndex !== undefined && { opIndex: error.opIndex }),
        },
      };
    }
    throw error;
  }
}

function record(value: unknown, where: string): Record<string, unknown> {
  if (!isRecord(value)) fail(`${where} must be an object`);
  return value;
}

function onlyKeys(value: Record<string, unknown>, allowed: readonly string[], where: string): void {
  const extra = Object.keys(value).find((key) => !allowed.includes(key));
  if (extra) fail(`${where}unknown field "${extra}"`);
}

const ID_SHAPE = /^[A-Za-z0-9_-]+$/;

function id(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) fail(`${field} must be an id`);
  if (value.length > STORY_LIMITS.idChars)
    fail(`${field} exceeds ${STORY_LIMITS.idChars} characters`);
  if (!ID_SHAPE.test(value)) fail(`${field} may only contain letters, digits, _ and -`);
  return value;
}

/** An id or an `@ref` to a node added earlier in the same batch. */
function nodeRef(value: unknown, field: string): string {
  if (typeof value === "string" && value.startsWith("@")) return `@${id(value.slice(1), field)}`;
  return id(value, field);
}

function text(value: unknown, field: string, max: number = STORY_LIMITS.textChars): string {
  if (typeof value !== "string") fail(`${field} must be a string`);
  if (value.length > max) fail(`${field} exceeds ${max} characters`);
  return value;
}

function title(value: unknown, field: string): string {
  const read = text(value, field, STORY_LIMITS.titleChars);
  if (read.trim().length === 0) fail(`${field} must not be empty`);
  return read;
}

function path(value: unknown, field: string): string {
  const read = text(value, field, STORY_LIMITS.pathChars);
  if (read.trim().length === 0) fail(`${field} must be a project-relative path`);
  return read;
}

function seconds(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0)
    fail(`${field} must be a number of seconds ≥ 0`);
  if (value > STORY_LIMITS.maxTime) fail(`${field} exceeds ${STORY_LIMITS.maxTime} seconds`);
  return value;
}

function positive(value: unknown, field: string): number {
  const read = seconds(value, field);
  if (read <= 0) fail(`${field} must be greater than 0`);
  return read;
}

function nullable<T>(value: unknown, read: (value: unknown) => T): T | null {
  return value === null ? null : read(value);
}

function bool(value: unknown, field: string): boolean {
  if (typeof value !== "boolean") fail(`${field} must be true or false`);
  return value;
}

function pick<T extends string>(value: unknown, allowed: readonly T[], field: string): T {
  const match = allowed.find((candidate) => candidate === value);
  if (match === undefined) fail(`${field} must be one of ${allowed.join(", ")}`);
  return match;
}

function coordinate(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) fail(`${field} must be a number`);
  if (Math.abs(value) > STORY_LIMITS.maxCoordinate) fail(`${field} is out of range`);
  return value;
}

function point(value: unknown, field: string): StoryPoint {
  const raw = record(value, field);
  onlyKeys(raw, ["x", "y"], `${field}: `);
  return { x: coordinate(raw.x, `${field}.x`), y: coordinate(raw.y, `${field}.y`) };
}

function frameRef(value: unknown, field: string): StoryFrameRef {
  const raw = record(value, field);
  onlyKeys(raw, ["source", "time"], `${field}: `);
  return { source: path(raw.source, `${field}.source`), time: seconds(raw.time, `${field}.time`) };
}

function volume(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1)
    fail(`${field} must be a number from 0 to 1`);
  return value;
}

function bpm(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 20 || value > 400)
    fail(`${field} must be a tempo from 20 to 400`);
  return value;
}

function inputs(value: unknown, field: string): Record<string, string> {
  const raw = record(value, field);
  const entries = Object.entries(raw);
  if (entries.length > STORY_LIMITS.inputs) fail(`${field} exceeds ${STORY_LIMITS.inputs} entries`);
  const read: Record<string, string> = {};
  for (const [key, entry] of entries) {
    if (key.length === 0 || key.length > STORY_LIMITS.inputChars)
      fail(`${field} has an invalid key`);
    read[key] = text(entry, `${field}.${key}`, STORY_LIMITS.inputChars);
  }
  return read;
}

function authors(value: unknown, field: string): StoryAuthor {
  return pick(value, ["ai", "user"] as const, field);
}

function sourceRange(value: unknown, field: string): StorySourceRange {
  const raw = record(value, field);
  onlyKeys(raw, ["source", "from", "to", "segment"], `${field}: `);
  const from = seconds(raw.from, `${field}.from`);
  const to = seconds(raw.to, `${field}.to`);
  if (to <= from) fail(`${field}.to must be after from`);
  return {
    source: path(raw.source, `${field}.source`),
    from,
    to,
    segment:
      raw.segment === undefined ? null : nullable(raw.segment, (v) => id(v, `${field}.segment`)),
  };
}

function list<T>(
  value: unknown,
  field: string,
  max: number,
  read: (entry: unknown, where: string) => T,
): T[] {
  if (!Array.isArray(value)) fail(`${field} must be an array`);
  if (value.length > max) fail(`${field} exceeds ${max} entries`);
  return value.map((entry, index) => read(entry, `${field}[${index}]`));
}

function contentFields(kind: StoryNodeKind, raw: Record<string, unknown>, field: string): string[] {
  const allowed: readonly string[] = STORY_CONTENT_FIELDS[kind];
  return list(raw.userEdited, `${field}.userEdited`, allowed.length, (entry, where) =>
    pick(entry, allowed, where),
  );
}

/** `resolvedFrom` on material nodes that replaced a Missing Asset node (not a content field: never edited by hand). */
function resolution(value: unknown, field: string): MissingResolution {
  const raw = record(value, field);
  onlyKeys(raw, ["missing", "mediaKind", "need", "at", "turnId"], `${field}: `);
  return {
    missing: id(raw.missing, `${field}.missing`),
    mediaKind: pick(raw.mediaKind, MISSING_MEDIA_KINDS, `${field}.mediaKind`),
    need: text(raw.need, `${field}.need`),
    at: timestamp(raw.at, `${field}.at`),
    turnId: nullable(raw.turnId, (v) => text(v, `${field}.turnId`, STORY_LIMITS.idChars * 2)),
  };
}

function resolvedFrom(
  raw: Record<string, unknown>,
  field: string,
): { resolvedFrom?: MissingResolution } {
  return raw.resolvedFrom === undefined
    ? {}
    : { resolvedFrom: resolution(raw.resolvedFrom, `${field}.resolvedFrom`) };
}

const RESOLVABLE_KINDS: readonly StoryNodeKind[] = ["video", "picture", "music"];

const NODE_BASE_KEYS = ["id", "kind", "title", "position", "locked", "createdBy", "userEdited"];

function storedNode(value: unknown, field: string): StoryNode {
  const raw = record(value, field);
  const kind = pick(raw.kind, STORY_NODE_KINDS, `${field}.kind`);
  onlyKeys(
    raw,
    [
      ...NODE_BASE_KEYS,
      ...STORY_CONTENT_FIELDS[kind],
      ...(RESOLVABLE_KINDS.includes(kind) ? ["resolvedFrom"] : []),
    ],
    `${field}: `,
  );
  const base = {
    id: id(raw.id, `${field}.id`),
    title: title(raw.title, `${field}.title`),
    position: point(raw.position, `${field}.position`),
    locked: bool(raw.locked, `${field}.locked`),
    createdBy: authors(raw.createdBy, `${field}.createdBy`),
    userEdited: contentFields(kind, raw, field),
  };
  switch (kind) {
    case "chapter":
      return {
        ...base,
        kind,
        purpose: text(raw.purpose, `${field}.purpose`),
        description: text(raw.description, `${field}.description`),
        narrativeRole: pick(raw.narrativeRole, STORY_NARRATIVE_ROLES, `${field}.narrativeRole`),
        estimatedDuration: seconds(raw.estimatedDuration, `${field}.estimatedDuration`),
        status: pick(raw.status, CHAPTER_STATUSES, `${field}.status`),
        sourceRanges: list(
          raw.sourceRanges,
          `${field}.sourceRanges`,
          STORY_LIMITS.sourceRanges,
          sourceRange,
        ),
        aRoll: text(raw.aRoll, `${field}.aRoll`),
        bRoll: text(raw.bRoll, `${field}.bRoll`),
        captions: bool(raw.captions, `${field}.captions`),
        graphics: text(raw.graphics, `${field}.graphics`),
        audio: text(raw.audio, `${field}.audio`),
        previewFrame: nullable(raw.previewFrame, (v) => frameRef(v, `${field}.previewFrame`)),
      };
    case "video": {
      const sourceIn = seconds(raw.sourceIn, `${field}.sourceIn`);
      const sourceOut = nullable(raw.sourceOut, (v) => seconds(v, `${field}.sourceOut`));
      if (sourceOut !== null && sourceOut <= sourceIn)
        fail(`${field}.sourceOut must be after sourceIn`);
      return {
        ...base,
        kind,
        asset: path(raw.asset, `${field}.asset`),
        sourceIn,
        sourceOut,
        usageIntent: text(raw.usageIntent, `${field}.usageIntent`),
        previewFrame: nullable(raw.previewFrame, (v) => frameRef(v, `${field}.previewFrame`)),
        ...resolvedFrom(raw, field),
      };
    }
    case "picture":
      return {
        ...base,
        kind,
        asset: path(raw.asset, `${field}.asset`),
        usageIntent: text(raw.usageIntent, `${field}.usageIntent`),
        ...resolvedFrom(raw, field),
      };
    case "music":
      return {
        ...base,
        kind,
        asset: nullable(raw.asset, (v) => path(v, `${field}.asset`)),
        bpm: nullable(raw.bpm, (v) => bpm(v, `${field}.bpm`)),
        volume: volume(raw.volume, `${field}.volume`),
        usageIntent: text(raw.usageIntent, `${field}.usageIntent`),
        ...resolvedFrom(raw, field),
      };
    case "motion":
      return {
        ...base,
        kind,
        preset: title(raw.preset, `${field}.preset`),
        skill: nullable(raw.skill, (v) => text(v, `${field}.skill`, STORY_LIMITS.titleChars)),
        inputs: inputs(raw.inputs, `${field}.inputs`),
        duration: nullable(raw.duration, (v) => positive(v, `${field}.duration`)),
        usageIntent: text(raw.usageIntent, `${field}.usageIntent`),
      };
    case "missing":
      return {
        ...base,
        kind,
        mediaKind: pick(raw.mediaKind, MISSING_MEDIA_KINDS, `${field}.mediaKind`),
        need: text(raw.need, `${field}.need`),
        neededDuration: nullable(raw.neededDuration, (v) => positive(v, `${field}.neededDuration`)),
      };
  }
}

function storedEdge(value: unknown, field: string): StoryEdge {
  const raw = record(value, field);
  onlyKeys(raw, ["id", "kind", "from", "to", "transition", "createdBy"], `${field}: `);
  return {
    id: id(raw.id, `${field}.id`),
    kind: pick(raw.kind, ["sequence"] as const, `${field}.kind`),
    from: id(raw.from, `${field}.from`),
    to: id(raw.to, `${field}.to`),
    transition: text(raw.transition, `${field}.transition`, STORY_LIMITS.textChars),
    createdBy: authors(raw.createdBy, `${field}.createdBy`),
  };
}

function storedAttachment(value: unknown, field: string): StoryAttachment {
  const raw = record(value, field);
  onlyKeys(
    raw,
    ["id", "node", "chapter", "placement", "offset", "duration", "createdBy"],
    `${field}: `,
  );
  return {
    id: id(raw.id, `${field}.id`),
    node: id(raw.node, `${field}.node`),
    chapter: id(raw.chapter, `${field}.chapter`),
    placement: pick(raw.placement, ATTACHMENT_PLACEMENTS, `${field}.placement`),
    offset: nullable(raw.offset, (v) => seconds(v, `${field}.offset`)),
    duration: nullable(raw.duration, (v) => positive(v, `${field}.duration`)),
    createdBy: authors(raw.createdBy, `${field}.createdBy`),
  };
}

function storedRemoval(value: unknown, field: string): StoryRemoval {
  const raw = record(value, field);
  const kind = pick(raw.kind, ["edge", "attachment"] as const, `${field}.kind`);
  if (kind === "edge") {
    onlyKeys(raw, ["kind", "from", "to"], `${field}: `);
    return { kind, from: id(raw.from, `${field}.from`), to: id(raw.to, `${field}.to`) };
  }
  onlyKeys(raw, ["kind", "node", "chapter"], `${field}: `);
  return {
    kind,
    node: id(raw.node, `${field}.node`),
    chapter: id(raw.chapter, `${field}.chapter`),
  };
}

function reviewRecord(value: unknown, field: string): StoryReviewRecord {
  const raw = record(value, field);
  onlyKeys(raw, ["at", "turnId", "summary"], `${field}: `);
  return {
    at: timestamp(raw.at, `${field}.at`),
    turnId: nullable(raw.turnId, (v) => text(v, `${field}.turnId`, STORY_LIMITS.idChars * 2)),
    summary: text(raw.summary, `${field}.summary`),
  };
}

function timestamp(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0)
    fail(`${field} must be a timestamp`);
  return value;
}

function buildRecord(value: unknown, field: string): StoryBuildRecord {
  const raw = record(value, field);
  onlyKeys(
    raw,
    ["at", "turnId", "composition", "version", "duration", "chapters", "warnings"],
    `${field}: `,
  );
  return {
    at: timestamp(raw.at, `${field}.at`),
    turnId: nullable(raw.turnId, (v) => text(v, `${field}.turnId`, STORY_LIMITS.idChars * 2)),
    composition: path(raw.composition, `${field}.composition`),
    version: text(raw.version, `${field}.version`, 200),
    duration: seconds(raw.duration, `${field}.duration`),
    chapters: list(raw.chapters, `${field}.chapters`, STORY_LIMITS.nodes, (entry, where) => {
      const chapter = record(entry, where);
      onlyKeys(chapter, ["node", "start", "end", "clips"], `${where}: `);
      const clips = chapter.clips;
      if (typeof clips !== "number" || !Number.isInteger(clips) || clips < 0)
        fail(`${where}.clips must be a whole number`);
      return {
        node: id(chapter.node, `${where}.node`),
        start: seconds(chapter.start, `${where}.start`),
        end: seconds(chapter.end, `${where}.end`),
        clips,
      };
    }),
    warnings: list(raw.warnings, `${field}.warnings`, 200, (entry, where) => text(entry, where)),
  };
}

function settings(value: unknown, field: string): StorySettings {
  const raw = record(value, field);
  onlyKeys(raw, ["composition", "captionPreset"], `${field}: `);
  return {
    composition: nullable(raw.composition, (v) => path(v, `${field}.composition`)),
    captionPreset: nullable(raw.captionPreset, (v) => title(v, `${field}.captionPreset`)),
  };
}

/** Structural problems of a graph (dangling references, edges between wrong kinds, branching or cyclic sequence). */
export function validateStoryGraph(
  graph: Pick<StoryGraph, "nodes" | "edges" | "attachments">,
): string[] {
  const problems: string[] = [];
  const nodes = new Map<string, StoryNode>();
  for (const node of graph.nodes) {
    if (nodes.has(node.id)) problems.push(`Node id ${node.id} is used twice.`);
    nodes.set(node.id, node);
  }
  const edgeIds = new Set<string>();
  const outgoing = new Map<string, string>();
  const incoming = new Map<string, string>();
  for (const edge of graph.edges) {
    if (edgeIds.has(edge.id) || nodes.has(edge.id))
      problems.push(`Edge id ${edge.id} is used twice.`);
    edgeIds.add(edge.id);
    const from = nodes.get(edge.from);
    const to = nodes.get(edge.to);
    if (!from || !to) {
      problems.push(`Edge ${edge.id} connects a node that does not exist.`);
      continue;
    }
    if (from.kind !== "chapter" || to.kind !== "chapter") {
      problems.push(`Edge ${edge.id}: sequence edges connect chapters only.`);
      continue;
    }
    if (edge.from === edge.to) problems.push(`Edge ${edge.id} connects a chapter to itself.`);
    if (outgoing.has(edge.from))
      problems.push(`Chapter "${from.title}" is followed by two chapters.`);
    if (incoming.has(edge.to)) problems.push(`Chapter "${to.title}" follows two chapters.`);
    outgoing.set(edge.from, edge.to);
    incoming.set(edge.to, edge.from);
  }
  for (const start of outgoing.keys()) {
    const seen = new Set<string>();
    let current: string | undefined = start;
    while (current !== undefined) {
      if (seen.has(current)) {
        problems.push("The chapter sequence has a cycle.");
        break;
      }
      seen.add(current);
      current = outgoing.get(current);
    }
    if (problems.at(-1) === "The chapter sequence has a cycle.") break;
  }
  const pairs = new Set<string>();
  for (const attachment of graph.attachments) {
    if (edgeIds.has(attachment.id) || nodes.has(attachment.id))
      problems.push(`Attachment id ${attachment.id} is used twice.`);
    edgeIds.add(attachment.id);
    const material = nodes.get(attachment.node);
    const chapter = nodes.get(attachment.chapter);
    if (!material || !chapter) {
      problems.push(`Attachment ${attachment.id} refers to a node that does not exist.`);
      continue;
    }
    if (material.kind === "chapter" || chapter.kind !== "chapter")
      problems.push(`Attachment ${attachment.id}: material attaches to a chapter.`);
    const pair = `${attachment.node}\0${attachment.chapter}`;
    if (pairs.has(pair))
      problems.push(`"${material.title}" is attached to "${chapter.title}" twice.`);
    pairs.add(pair);
  }
  return problems;
}

/** Reads a complete stored graph (the file, or a Studio save): every field present, nothing unknown, consistent. */
export function parseStoryGraph(raw: unknown): ParsedStory<StoryGraph> {
  return parse(() => {
    const value = record(raw, "graph");
    onlyKeys(
      value,
      [
        "schema",
        "id",
        "title",
        "brief",
        "settings",
        "nodes",
        "edges",
        "attachments",
        "removedByUser",
        "review",
        "build",
        "updatedAt",
        "updatedBy",
      ],
      "graph: ",
    );
    if (value.schema !== STORY_GRAPH_SCHEMA) fail(`graph.schema must be ${STORY_GRAPH_SCHEMA}`);
    const graph: StoryGraph = {
      schema: STORY_GRAPH_SCHEMA,
      id: id(value.id, "graph.id"),
      title: text(value.title, "graph.title", STORY_LIMITS.titleChars),
      brief: text(value.brief, "graph.brief"),
      settings: settings(value.settings, "graph.settings"),
      nodes: list(value.nodes, "graph.nodes", STORY_LIMITS.nodes, storedNode),
      edges: list(value.edges, "graph.edges", STORY_LIMITS.edges, storedEdge),
      attachments: list(
        value.attachments,
        "graph.attachments",
        STORY_LIMITS.attachments,
        storedAttachment,
      ),
      removedByUser: list(
        value.removedByUser,
        "graph.removedByUser",
        STORY_LIMITS.removals,
        storedRemoval,
      ),
      review: nullable(value.review, (v) => reviewRecord(v, "graph.review")),
      build: nullable(value.build, (v) => buildRecord(v, "graph.build")),
      updatedAt: timestamp(value.updatedAt, "graph.updatedAt"),
      updatedBy: authors(value.updatedBy, "graph.updatedBy"),
    };
    const problems = validateStoryGraph(graph);
    if (problems.length > 0) fail(problems.join(" "));
    return graph;
  });
}

export function parseSaveStoryRequest(raw: unknown): ParsedStory<SaveStoryRequest> {
  return parse(() => {
    const value = record(raw, "body");
    onlyKeys(value, ["baseVersion", "graph"], "");
    const baseVersion = nullable(value.baseVersion, (v) => text(v, "baseVersion", 200));
    const graph = parseStoryGraph(value.graph);
    if (!graph.ok) fail(graph.error.message);
    return { baseVersion, graph: graph.value };
  });
}

// ── Agent operation parsing ──────────────────────────────────────────────────

function rangeInput(value: unknown, field: string): StorySourceRangeInput {
  const raw = record(value, field);
  const source = path(raw.source, `${field}.source`);
  if (raw.segments !== undefined) {
    onlyKeys(raw, ["source", "segments"], `${field}: `);
    const segments = list(
      raw.segments,
      `${field}.segments`,
      STORY_LIMITS.sourceRanges,
      (entry, where) => id(entry, where),
    );
    if (segments.length === 0) fail(`${field}.segments must not be empty`);
    return { source, segments };
  }
  if (raw.firstSentence !== undefined || raw.lastSentence !== undefined) {
    onlyKeys(raw, ["source", "firstSentence", "lastSentence"], `${field}: `);
    return {
      source,
      firstSentence: id(raw.firstSentence, `${field}.firstSentence`),
      lastSentence: id(raw.lastSentence, `${field}.lastSentence`),
    };
  }
  onlyKeys(raw, ["source", "from", "to"], `${field}: `);
  const from = seconds(raw.from, `${field}.from`);
  const to = seconds(raw.to, `${field}.to`);
  if (to <= from) fail(`${field}.to must be after from`);
  return { source, from, to };
}

type FieldReader = {
  at: (key: string) => string;
  has: (key: string) => boolean;
  raw: Record<string, unknown>;
};

function reader(raw: Record<string, unknown>, field: string): FieldReader {
  return { at: (key) => `${field}.${key}`, has: (key) => raw[key] !== undefined, raw };
}

function chapterFields({ at, has, raw }: FieldReader): ChapterFieldsInput {
  const set: ChapterFieldsInput = {};
  if (has("title")) set.title = title(raw.title, at("title"));
  if (has("purpose")) set.purpose = text(raw.purpose, at("purpose"));
  if (has("description")) set.description = text(raw.description, at("description"));
  if (has("narrativeRole"))
    set.narrativeRole = pick(raw.narrativeRole, STORY_NARRATIVE_ROLES, at("narrativeRole"));
  if (has("estimatedDuration"))
    set.estimatedDuration = positive(raw.estimatedDuration, at("estimatedDuration"));
  if (has("status")) set.status = pick(raw.status, CHAPTER_STATUSES, at("status"));
  if (has("sourceRanges"))
    set.sourceRanges = list(
      raw.sourceRanges,
      at("sourceRanges"),
      STORY_LIMITS.sourceRanges,
      rangeInput,
    );
  if (has("aRoll")) set.aRoll = text(raw.aRoll, at("aRoll"));
  if (has("bRoll")) set.bRoll = text(raw.bRoll, at("bRoll"));
  if (has("captions")) set.captions = bool(raw.captions, at("captions"));
  if (has("graphics")) set.graphics = text(raw.graphics, at("graphics"));
  if (has("audio")) set.audio = text(raw.audio, at("audio"));
  if (has("previewFrame"))
    set.previewFrame = nullable(raw.previewFrame, (v) => frameRef(v, at("previewFrame")));
  return set;
}

function videoFields({ at, has, raw }: FieldReader): VideoFieldsInput {
  const set: VideoFieldsInput = {};
  if (has("title")) set.title = title(raw.title, at("title"));
  if (has("asset")) set.asset = path(raw.asset, at("asset"));
  if (has("sourceIn")) set.sourceIn = seconds(raw.sourceIn, at("sourceIn"));
  if (has("sourceOut"))
    set.sourceOut = nullable(raw.sourceOut, (v) => positive(v, at("sourceOut")));
  if (has("usageIntent")) set.usageIntent = text(raw.usageIntent, at("usageIntent"));
  if (has("previewFrame"))
    set.previewFrame = nullable(raw.previewFrame, (v) => frameRef(v, at("previewFrame")));
  return set;
}

function pictureFields({ at, has, raw }: FieldReader): PictureFieldsInput {
  const set: PictureFieldsInput = {};
  if (has("title")) set.title = title(raw.title, at("title"));
  if (has("asset")) set.asset = path(raw.asset, at("asset"));
  if (has("usageIntent")) set.usageIntent = text(raw.usageIntent, at("usageIntent"));
  return set;
}

function musicFields({ at, has, raw }: FieldReader): MusicFieldsInput {
  const set: MusicFieldsInput = {};
  if (has("title")) set.title = title(raw.title, at("title"));
  if (has("asset")) set.asset = nullable(raw.asset, (v) => path(v, at("asset")));
  if (has("bpm")) set.bpm = nullable(raw.bpm, (v) => bpm(v, at("bpm")));
  if (has("volume")) set.volume = volume(raw.volume, at("volume"));
  if (has("usageIntent")) set.usageIntent = text(raw.usageIntent, at("usageIntent"));
  return set;
}

function motionFields({ at, has, raw }: FieldReader): MotionFieldsInput {
  const set: MotionFieldsInput = {};
  if (has("title")) set.title = title(raw.title, at("title"));
  if (has("preset")) set.preset = title(raw.preset, at("preset"));
  if (has("skill"))
    set.skill = nullable(raw.skill, (v) => text(v, at("skill"), STORY_LIMITS.titleChars));
  if (has("inputs")) set.inputs = inputs(raw.inputs, at("inputs"));
  if (has("duration")) set.duration = nullable(raw.duration, (v) => positive(v, at("duration")));
  if (has("usageIntent")) set.usageIntent = text(raw.usageIntent, at("usageIntent"));
  return set;
}

function missingFields({ at, has, raw }: FieldReader): MissingFieldsInput {
  const set: MissingFieldsInput = {};
  if (has("title")) set.title = title(raw.title, at("title"));
  if (has("mediaKind")) set.mediaKind = pick(raw.mediaKind, MISSING_MEDIA_KINDS, at("mediaKind"));
  if (has("need")) set.need = text(raw.need, at("need"));
  if (has("neededDuration"))
    set.neededDuration = nullable(raw.neededDuration, (v) => positive(v, at("neededDuration")));
  return set;
}

/** Reads the content fields an agent may set on a node of `kind` (all optional). */
function fieldsInput(
  kind: StoryNodeKind,
  raw: Record<string, unknown>,
  field: string,
): StoryFieldsInput {
  const read = reader(raw, field);
  switch (kind) {
    case "chapter":
      return chapterFields(read);
    case "video":
      return videoFields(read);
    case "picture":
      return pictureFields(read);
    case "music":
      return musicFields(read);
    case "motion":
      return motionFields(read);
    case "missing":
      return missingFields(read);
  }
}

/** Every key an update may carry for some kind: an update names a node id, so its kind is only known to the service. */
const ANY_CONTENT_FIELD: readonly string[] = [
  ...new Set(Object.values(STORY_CONTENT_FIELDS).flat()),
];

/**
 * Reads an update's fields without knowing the node's kind. The service re-reads them with
 * {@link parseStoryFields} once it knows the kind.
 */
function looseFields(value: unknown, field: string): Record<string, unknown> {
  const raw = record(value, field);
  onlyKeys(raw, ANY_CONTENT_FIELD, `${field}: `);
  if (Object.keys(raw).length === 0) fail(`${field} must set at least one field`);
  return raw;
}

/** Reads `set` of an update for a node of a known kind; unknown fields for that kind are refused. */
export function parseStoryFields(kind: StoryNodeKind, raw: unknown): ParsedStory<StoryFieldsInput> {
  return parse(() => {
    const value = record(raw, "set");
    onlyKeys(value, STORY_CONTENT_FIELDS[kind], `set (${kind}): `);
    return fieldsInput(kind, value, "set");
  });
}

function nodeInput(value: unknown, field: string): StoryNodeInput {
  const raw = record(value, field);
  const kind = pick(raw.kind, STORY_NODE_KINDS, `${field}.kind`);
  const allowed: readonly string[] = STORY_CONTENT_FIELDS[kind];
  onlyKeys(raw, ["kind", ...allowed], `${field}: `);
  const read = reader(raw, field);
  const required = <T>(value: T | undefined, name: string): T => {
    if (value === undefined) fail(`${field}.${name} is required`);
    return value;
  };
  switch (kind) {
    case "chapter": {
      const fields = chapterFields(read);
      required(fields.title, "title");
      return { kind, ...fields };
    }
    case "video": {
      const fields = videoFields(read);
      required(fields.title, "title");
      required(fields.asset, "asset");
      return { kind, ...fields };
    }
    case "picture": {
      const fields = pictureFields(read);
      required(fields.title, "title");
      required(fields.asset, "asset");
      return { kind, ...fields };
    }
    case "music": {
      const fields = musicFields(read);
      required(fields.title, "title");
      return { kind, ...fields };
    }
    case "motion": {
      const fields = motionFields(read);
      required(fields.title, "title");
      required(fields.preset, "preset");
      return { kind, ...fields };
    }
    case "missing": {
      const fields = missingFields(read);
      required(fields.title, "title");
      required(fields.need, "need");
      return { kind, ...fields };
    }
  }
}

function operation(value: unknown, index: number): StoryOperation {
  const where = `operations[${index}]`;
  const raw = record(value, where);
  const op = pick(raw.op, STORY_OPERATION_NAMES, `${where}.op`);
  const keys = (allowed: string[]) => onlyKeys(raw, ["op", ...allowed], `${where}: `);
  switch (op) {
    case "add_node": {
      keys(["ref", "node"]);
      return {
        op,
        ...(raw.ref !== undefined && { ref: id(raw.ref, `${where}.ref`) }),
        node: nodeInput(raw.node, `${where}.node`),
      };
    }
    case "update_node": {
      keys(["id", "set"]);
      const set = looseFields(raw.set, `${where}.set`);
      const kinds = STORY_NODE_KINDS.filter((kind) =>
        Object.keys(set).every((key) =>
          (STORY_CONTENT_FIELDS[kind] as readonly string[]).includes(key),
        ),
      );
      // Validate the values against the first kind that has all the keys; the service re-checks for the real kind.
      const kind = kinds[0];
      if (kind === undefined) fail(`${where}.set mixes fields of different node kinds`);
      return {
        op,
        id: nodeRef(raw.id, `${where}.id`),
        set: fieldsInput(kind, set, `${where}.set`),
      };
    }
    case "remove_node":
      keys(["id"]);
      return { op, id: nodeRef(raw.id, `${where}.id`) };
    case "connect":
      keys(["from", "to", "transition"]);
      return {
        op,
        from: nodeRef(raw.from, `${where}.from`),
        to: nodeRef(raw.to, `${where}.to`),
        ...(raw.transition !== undefined && {
          transition: text(raw.transition, `${where}.transition`),
        }),
      };
    case "disconnect":
      keys(["from", "to"]);
      return { op, from: nodeRef(raw.from, `${where}.from`), to: nodeRef(raw.to, `${where}.to`) };
    case "set_order": {
      keys(["chapters"]);
      const chapters = list(raw.chapters, `${where}.chapters`, STORY_LIMITS.nodes, (entry, at) =>
        nodeRef(entry, at),
      );
      if (chapters.length === 0) fail(`${where}.chapters must not be empty`);
      if (new Set(chapters).size !== chapters.length)
        fail(`${where}.chapters lists a chapter twice`);
      return { op, chapters };
    }
    case "attach":
      keys(["node", "chapter", "placement", "offset", "duration"]);
      return {
        op,
        node: nodeRef(raw.node, `${where}.node`),
        chapter: nodeRef(raw.chapter, `${where}.chapter`),
        ...(raw.placement !== undefined && {
          placement: pick(raw.placement, ATTACHMENT_PLACEMENTS, `${where}.placement`),
        }),
        ...(raw.offset !== undefined && {
          offset: nullable(raw.offset, (v) => seconds(v, `${where}.offset`)),
        }),
        ...(raw.duration !== undefined && {
          duration: nullable(raw.duration, (v) => positive(v, `${where}.duration`)),
        }),
      };
    case "detach":
      keys(["node", "chapter"]);
      return {
        op,
        node: nodeRef(raw.node, `${where}.node`),
        chapter: nodeRef(raw.chapter, `${where}.chapter`),
      };
    case "set_story": {
      keys(["title", "brief", "captionPreset", "composition", "reviewSummary"]);
      const set: Extract<StoryOperation, { op: "set_story" }> = { op };
      if (raw.title !== undefined)
        set.title = text(raw.title, `${where}.title`, STORY_LIMITS.titleChars);
      if (raw.brief !== undefined) set.brief = text(raw.brief, `${where}.brief`);
      if (raw.captionPreset !== undefined)
        set.captionPreset = nullable(raw.captionPreset, (v) => title(v, `${where}.captionPreset`));
      if (raw.composition !== undefined)
        set.composition = nullable(raw.composition, (v) => path(v, `${where}.composition`));
      if (raw.reviewSummary !== undefined)
        set.reviewSummary = text(raw.reviewSummary, `${where}.reviewSummary`);
      if (Object.keys(set).length === 1) fail(`${where} must set at least one field`);
      return set;
    }
    case "resolve_missing": {
      keys(["id", "asset", "title", "usageIntent", "sourceIn", "sourceOut"]);
      const sourceIn =
        raw.sourceIn === undefined ? undefined : seconds(raw.sourceIn, `${where}.sourceIn`);
      const sourceOut =
        raw.sourceOut === undefined
          ? undefined
          : nullable(raw.sourceOut, (v) => seconds(v, `${where}.sourceOut`));
      if (sourceOut != null && sourceOut <= (sourceIn ?? 0))
        fail(`${where}.sourceOut must be after sourceIn`);
      return {
        op,
        id: nodeRef(raw.id, `${where}.id`),
        asset: path(raw.asset, `${where}.asset`),
        ...(raw.title !== undefined && { title: title(raw.title, `${where}.title`) }),
        ...(raw.usageIntent !== undefined && {
          usageIntent: text(raw.usageIntent, `${where}.usageIntent`),
        }),
        ...(sourceIn !== undefined && { sourceIn }),
        ...(sourceOut !== undefined && { sourceOut }),
      };
    }
  }
}

export function parseStoryEditRequest(raw: unknown): ParsedStory<StoryEditRequest> {
  return parse(() => {
    const value = record(raw, "body");
    onlyKeys(value, ["baseVersion", "turnId", "operations"], "");
    if (!Array.isArray(value.operations) || value.operations.length === 0)
      fail("operations must be a non-empty array");
    if (value.operations.length > STORY_LIMITS.operations)
      fail(`operations exceeds ${STORY_LIMITS.operations} entries`);
    const operations = value.operations.map((entry: unknown, index: number) => {
      try {
        return operation(entry, index);
      } catch (error) {
        if (error instanceof Invalid) throw new Invalid(error.message, index);
        throw error;
      }
    });
    return {
      ...(value.baseVersion !== undefined && {
        baseVersion: text(value.baseVersion, "baseVersion", 200),
      }),
      ...(value.turnId !== undefined && {
        turnId: text(value.turnId, "turnId", STORY_LIMITS.idChars * 2),
      }),
      operations,
    };
  });
}

function nodeIds(value: unknown, field: string): string[] {
  return [...new Set(list(value, field, STORY_LIMITS.nodes, (entry, where) => id(entry, where)))];
}

export function parseStoryBuildRequest(raw: unknown): ParsedStory<StoryBuildRequest> {
  return parse(() => {
    if (raw === undefined || raw === null) return {};
    const value = record(raw, "body");
    onlyKeys(value, ["baseVersion", "turnId", "dryRun", "allowLocked"], "");
    return {
      ...(value.baseVersion !== undefined && {
        baseVersion: text(value.baseVersion, "baseVersion", 200),
      }),
      ...(value.turnId !== undefined && {
        turnId: text(value.turnId, "turnId", STORY_LIMITS.idChars * 2),
      }),
      ...(value.dryRun !== undefined && { dryRun: bool(value.dryRun, "dryRun") }),
      ...(value.allowLocked !== undefined && {
        allowLocked: nodeIds(value.allowLocked, "allowLocked"),
      }),
    };
  });
}

export function parseStoryRebuildRequest(raw: unknown): ParsedStory<StoryRebuildRequest> {
  return parse(() => {
    if (raw === undefined || raw === null) return {};
    const value = record(raw, "body");
    onlyKeys(
      value,
      ["baseVersion", "turnId", "dryRun", "chapters", "manualEdits", "allowLocked"],
      "",
    );
    return {
      ...(value.baseVersion !== undefined && {
        baseVersion: text(value.baseVersion, "baseVersion", 200),
      }),
      ...(value.turnId !== undefined && {
        turnId: text(value.turnId, "turnId", STORY_LIMITS.idChars * 2),
      }),
      ...(value.dryRun !== undefined && { dryRun: bool(value.dryRun, "dryRun") }),
      ...(value.chapters !== undefined && { chapters: nodeIds(value.chapters, "chapters") }),
      ...(value.manualEdits !== undefined && {
        manualEdits: pick(value.manualEdits, ["keep", "replace"] as const, "manualEdits"),
      }),
      ...(value.allowLocked !== undefined && {
        allowLocked: nodeIds(value.allowLocked, "allowLocked"),
      }),
    };
  });
}

/** Narrow type guard for responses (clients trust the service's shape after this). */
export function isStoryView(value: unknown): value is StoryView {
  return (
    isRecord(value) &&
    (value.graph === null || isRecord(value.graph)) &&
    (value.version === null || typeof value.version === "string") &&
    isRecord(value.order) &&
    Array.isArray(value.order.chapters) &&
    isRecord(value.facts)
  );
}

// ── Captions from the transcript ─────────────────────────────────────────────

/** A kept source range and where it plays on the timeline. */
export interface PlacedRange {
  from: number;
  to: number;
  /** Timeline position of `from`. */
  at: number;
}

export interface CaptionCueOptions {
  /** Most words in one cue (default 7). */
  maxWords?: number;
  /** Longest cue, seconds (default 3.2). */
  maxSeconds?: number;
}

/**
 * Word-synced caption cues for the timeline: every transcript word whose middle lies inside a kept range is placed
 * at its timeline time; cues break at sentence ends, at cuts between ranges, and at the word/length limits.
 * `words` need `text`, `start`, `end`; `sentenceEnds` holds the indices of words that end a sentence.
 */
export function captionCuesFromWords(
  words: ReadonlyArray<{ text: string; start: number; end: number }>,
  ranges: readonly PlacedRange[],
  options: CaptionCueOptions & { sentenceEnds?: ReadonlySet<number> } = {},
): Array<{ text: string; start: number; end: number }> {
  const maxWords = options.maxWords ?? 7;
  const maxSeconds = options.maxSeconds ?? 3.2;
  const sorted = [...ranges].sort((a, b) => a.at - b.at);
  const cues: Array<{ text: string; start: number; end: number }> = [];
  for (const range of sorted) {
    let pending: string[] = [];
    let cueStart = 0;
    let cueEnd = 0;
    const flush = () => {
      if (pending.length > 0) {
        cues.push({
          text: pending.join(" "),
          start: Number(cueStart.toFixed(3)),
          end: Number(Math.max(cueEnd, cueStart + 0.2).toFixed(3)),
        });
      }
      pending = [];
    };
    for (const [index, word] of words.entries()) {
      const middle = (word.start + word.end) / 2;
      if (middle < range.from || middle >= range.to) continue;
      const trimmed = word.text.trim();
      if (!trimmed) continue;
      const start = range.at + Math.max(word.start, range.from) - range.from;
      const end = range.at + Math.min(word.end, range.to) - range.from;
      if (pending.length >= maxWords || (pending.length > 0 && end - cueStart > maxSeconds))
        flush();
      if (pending.length === 0) cueStart = start;
      pending.push(trimmed);
      cueEnd = end;
      if (options.sentenceEnds?.has(index)) flush();
    }
    flush();
  }
  return cues;
}
